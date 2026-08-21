// Window geometry: persistence, viewport clamping, dragging, and resizing.
//
// Ported from bb-plugin-floating-terminal and generalized: this plugin floats
// N windows (the main window plus any number of stickies), so every helper
// takes a storage key and a size profile instead of baking in one window's
// constants. Kept in plain DOM rather than React because the windows are
// mounted by a content script into document.body, outside the host tree.

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SizeProfile {
  minWidth: number;
  minHeight: number;
  defaultWidth: number;
  defaultHeight: number;
}

export const WINDOW_PROFILE: SizeProfile = {
  minWidth: 520,
  minHeight: 300,
  defaultWidth: 840,
  defaultHeight: 520,
};

export const STICKY_PROFILE: SizeProfile = {
  minWidth: 220,
  minHeight: 64,
  defaultWidth: 300,
  defaultHeight: 260,
};

const STORAGE_PREFIX = "bb-plugin-notes:frame:v1:";
/** Keep this much of a window reachable so it can never be dragged away. */
const KEEP_VISIBLE = 120;
/** One inset for every edge, so the corner reads as a corner. */
const GUTTER = 40;
/** Each unplaced sticky lands offset from the last, like a dealt hand. */
const CASCADE_STEP = 28;

/**
 * The main window rests in the bottom-right corner — the opposite corner from
 * the floating terminal, so running both never means excavating one from
 * under the other.
 */
export function defaultWindowFrame(): Frame {
  const width = Math.min(
    WINDOW_PROFILE.defaultWidth,
    Math.max(WINDOW_PROFILE.minWidth, window.innerWidth - 2 * GUTTER),
  );
  const height = Math.min(
    WINDOW_PROFILE.defaultHeight,
    Math.max(WINDOW_PROFILE.minHeight, window.innerHeight - 2 * GUTTER),
  );
  return clampFrame(
    {
      x: window.innerWidth - width - GUTTER,
      y: window.innerHeight - height - GUTTER,
      width,
      height,
    },
    WINDOW_PROFILE,
  );
}

/** Stickies cascade down-right from the upper-right region. */
export function defaultStickyFrame(index: number): Frame {
  const step = (index % 8) * CASCADE_STEP;
  return clampFrame(
    {
      x: window.innerWidth - STICKY_PROFILE.defaultWidth - GUTTER * 2 - step,
      y: GUTTER + step,
      width: STICKY_PROFILE.defaultWidth,
      height: STICKY_PROFILE.defaultHeight,
    },
    STICKY_PROFILE,
  );
}

export function clampFrame(frame: Frame, profile: SizeProfile): Frame {
  const width = Math.max(
    profile.minWidth,
    Math.min(frame.width, window.innerWidth),
  );
  const height = Math.max(
    profile.minHeight,
    Math.min(frame.height, window.innerHeight),
  );
  return {
    width,
    height,
    x: Math.round(
      Math.min(
        Math.max(frame.x, KEEP_VISIBLE - width),
        window.innerWidth - KEEP_VISIBLE,
      ),
    ),
    // Never let the header (the only drag handle) go above the viewport.
    y: Math.round(Math.min(Math.max(frame.y, 0), window.innerHeight - 40)),
  };
}

export function loadFrame(
  key: string,
  profile: SizeProfile,
  fallback: () => Frame,
): Frame {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback();
    const parsed = JSON.parse(raw) as Partial<Frame>;
    const numbers = [parsed.x, parsed.y, parsed.width, parsed.height];
    if (
      numbers.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      return fallback();
    }
    return clampFrame(parsed as Frame, profile);
  } catch {
    return fallback();
  }
}

export function saveFrame(key: string, frame: Frame): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(frame));
  } catch {
    // Private mode or a full quota: geometry just falls back to the default.
  }
}

export function forgetFrame(key: string): void {
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Same story as saveFrame.
  }
}

export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const RESIZE_EDGES: readonly Edge[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
];

interface GestureOptions {
  profile: SizeProfile;
  getFrame: () => Frame;
  /** Called on every pointer move with the in-progress geometry. */
  onChange: (frame: Frame) => void;
  /** Called once on release, for persistence. */
  onCommit: (frame: Frame) => void;
}

function trackPointer(
  element: HTMLElement,
  compute: (dx: number, dy: number, start: Frame) => Frame,
  { profile, getFrame, onChange, onCommit }: GestureOptions,
  signal: AbortSignal,
): void {
  element.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      // Controls inside the drag handle must stay clickable.
      if ((event.target as HTMLElement | null)?.closest("[data-no-drag]") != null) {
        return;
      }
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const startFrame = getFrame();
      let latest = startFrame;
      element.setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent) => {
        latest = clampFrame(
          compute(moveEvent.clientX - startX, moveEvent.clientY - startY, startFrame),
          profile,
        );
        onChange(latest);
      };
      const done = () => {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", done);
        element.removeEventListener("pointercancel", done);
        onCommit(latest);
      };

      element.addEventListener("pointermove", move, { signal });
      element.addEventListener("pointerup", done, { signal });
      element.addEventListener("pointercancel", done, { signal });
    },
    { signal },
  );
}

export function installDrag(
  handle: HTMLElement,
  options: GestureOptions,
  signal: AbortSignal,
): void {
  trackPointer(
    handle,
    (dx, dy, start) => ({ ...start, x: start.x + dx, y: start.y + dy }),
    options,
    signal,
  );
}

export function installResize(
  handle: HTMLElement,
  edge: Edge,
  options: GestureOptions,
  signal: AbortSignal,
): void {
  trackPointer(
    handle,
    (dx, dy, start) => {
      const next = { ...start };
      if (edge.includes("e")) next.width = start.width + dx;
      if (edge.includes("s")) next.height = start.height + dy;
      if (edge.includes("w")) {
        // Growing leftwards moves the origin and the size in opposite directions.
        next.width = Math.max(options.profile.minWidth, start.width - dx);
        next.x = start.x + (start.width - next.width);
      }
      if (edge.includes("n")) {
        next.height = Math.max(options.profile.minHeight, start.height - dy);
        next.y = start.y + (start.height - next.height);
      }
      return next;
    },
    options,
    signal,
  );
}
