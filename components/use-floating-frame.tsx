// Drag/resize/persist wiring shared by the main window and every sticky.
//
// Geometry lives in a ref (the handlers read and write it every pointer move)
// and is mirrored onto the element directly — re-rendering React 60 times a
// second to move a window is the wrong tool. Ported from the floating
// terminal and parameterized per window.
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  clampFrame,
  installDrag,
  installResize,
  loadFrame,
  RESIZE_EDGES,
  saveFrame,
  snapFrame,
  type Frame,
  type SizeProfile,
} from "@/lib/frame";
import { raiseLayer, registerLayer } from "@/lib/z-order";

/** Edge hit areas, wide enough to grab without visually thickening the border. */
const EDGE_CLASS: Record<string, string> = {
  n: "absolute inset-x-3 top-0 h-1.5 cursor-ns-resize",
  s: "absolute inset-x-3 bottom-0 h-1.5 cursor-ns-resize",
  e: "absolute inset-y-3 right-0 w-1.5 cursor-ew-resize",
  w: "absolute inset-y-3 left-0 w-1.5 cursor-ew-resize",
  ne: "absolute right-0 top-0 size-3 cursor-nesw-resize",
  nw: "absolute left-0 top-0 size-3 cursor-nwse-resize",
  se: "absolute bottom-0 right-0 size-3 cursor-nwse-resize",
  sw: "absolute bottom-0 left-0 size-3 cursor-nesw-resize",
};

export interface FloatingFrameOptions {
  frameKey: string;
  profile: SizeProfile;
  fallback: () => Frame;
  /**
   * False hands geometry to the stylesheet (the mobile sheet) — inline styles
   * are removed and no gesture is installed.
   */
  active: boolean;
  /** Collapsed sticky: width and position apply, height follows content. */
  skipHeight?: boolean;
  /** Magnetic gutters: a release near a viewport edge aligns to it. */
  snap?: boolean;
}

export function useFloatingFrame({
  frameKey,
  profile,
  fallback,
  active,
  skipHeight = false,
  snap = false,
}: FloatingFrameOptions): {
  rootRef: React.RefObject<HTMLDivElement | null>;
  handleRef: React.RefObject<HTMLDivElement | null>;
  resizeEdges: ReactNode;
} {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const edgeRefs = useRef(new Map<string, HTMLDivElement>());
  const frameRef = useRef<Frame | null>(null);

  const activeRef = useRef(active);
  activeRef.current = active;
  const skipHeightRef = useRef(skipHeight);
  skipHeightRef.current = skipHeight;

  const applyFrame = useCallback((next: Frame) => {
    const node = rootRef.current;
    if (!activeRef.current) {
      // Hand geometry back to the stylesheet; inline styles outrank a class.
      if (node !== null) {
        node.style.removeProperty("left");
        node.style.removeProperty("top");
        node.style.removeProperty("width");
        node.style.removeProperty("height");
      }
      return;
    }
    frameRef.current = next;
    if (node === null) return;
    node.style.left = `${next.x}px`;
    node.style.top = `${next.y}px`;
    node.style.width = `${next.width}px`;
    if (skipHeightRef.current) node.style.removeProperty("height");
    else node.style.height = `${next.height}px`;
  }, []);

  const snapRef = useRef(snap);
  snapRef.current = snap;

  const commitFrame = useCallback(
    (next: Frame) => {
      const settled = snapRef.current ? snapFrame(next) : next;
      applyFrame(settled);
      saveFrame(frameKey, settled);
    },
    [applyFrame, frameKey],
  );

  // Mount, and every return from inactive (sheet) mode: re-read stored
  // geometry rather than trusting memory — a frame first computed at phone
  // width would otherwise become the desktop window.
  useEffect(() => {
    if (!active) {
      applyFrame(fallback()); // Only strips inline styles in inactive mode.
      return;
    }
    frameRef.current = loadFrame(frameKey, profile, fallback);
    applyFrame(frameRef.current);
    // fallback is intentionally not a dependency: it is a fresh closure every
    // render, and geometry must only reset when the window or mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, frameKey, profile, applyFrame]);

  // Collapsing and expanding re-applies the same frame with the new height rule.
  useEffect(() => {
    if (active && frameRef.current !== null) applyFrame(frameRef.current);
  }, [skipHeight, active, applyFrame]);

  useEffect(() => {
    const handle = handleRef.current;
    if (handle === null || !active) return;
    const aborter = new AbortController();
    const options = {
      profile,
      getFrame: () => frameRef.current ?? fallback(),
      onChange: applyFrame,
      onCommit: commitFrame,
    };
    installDrag(handle, options, aborter.signal);
    for (const edge of RESIZE_EDGES) {
      const node = edgeRefs.current.get(edge);
      if (node !== undefined) installResize(node, edge, options, aborter.signal);
    }
    return () => aborter.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, profile, applyFrame, commitFrame]);

  useEffect(() => {
    if (!active) return;
    const onResize = () => {
      if (frameRef.current !== null) {
        applyFrame(clampFrame(frameRef.current, profile));
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active, profile, applyFrame]);

  // Window-manager stacking: register while active, raise on any press.
  useEffect(() => {
    const node = rootRef.current;
    if (!active || node === null) return;
    const unregister = registerLayer(node);
    const raise = () => raiseLayer(node);
    node.addEventListener("pointerdown", raise, { capture: true });
    return () => {
      node.removeEventListener("pointerdown", raise, { capture: true });
      unregister();
    };
  }, [active]);

  const resizeEdges = !active
    ? null
    : RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          ref={(node) => {
            if (node === null) edgeRefs.current.delete(edge);
            else edgeRefs.current.set(edge, node);
          }}
          className={EDGE_CLASS[edge] ?? ""}
          aria-hidden="true"
        />
      ));

  return { rootRef, handleRef, resizeEdges };
}
