// The content-script root: the main window, every visible sticky, the quick
// capture bar, and the composer's note picker. Also owns the global
// shortcuts and the store's refresh cadence.
import { useEffect, useMemo } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { NotesWindow } from "@/components/notes-window";
import { StickyNote } from "@/components/sticky-note";
import { CaptureBar } from "@/components/capture-bar";
import { NotePicker } from "@/components/note-picker";
import { controller } from "@/lib/controller";
import { useControllerState, useNotesState } from "@/lib/hooks";
import { notesStore, openStickies } from "@/lib/store";

const REFRESH_INTERVAL_MS = 20_000;

export function FloatingNotes() {
  const { notes, config } = useNotesState();
  const { windowOpen, notePickerTarget, visibleThreads } = useControllerState();
  const sheet = useIsCompactViewport();

  // ------------------------------------------------------------- data flow

  useEffect(() => {
    void notesStore.refresh();
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void notesStore.refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void notesStore.refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  }, []);

  // Editor font size for every surface, from settings.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--bbnotes-editor-font-size",
      `${config.fontSize}px`,
    );
    return () => {
      document.documentElement.style.removeProperty("--bbnotes-editor-font-size");
    };
  }, [config.fontSize]);

  // ------------------------------------------------------------- shortcuts

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.altKey || !event.ctrlKey) return;
      // event.code, not event.key: Ctrl+Shift+' is `"` on a US layout.
      if (event.code !== "Quote") return;
      if (event.shiftKey) {
        if (!config.captureShortcutEnabled) return;
        event.preventDefault();
        event.stopPropagation();
        controller.openCapture();
        return;
      }
      if (!config.shortcutEnabled) return;
      event.preventDefault();
      event.stopPropagation();
      controller.toggleWindow();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [config.shortcutEnabled, config.captureShortcutEnabled]);

  // The window (or a reveal request) also wants fresh data on open.
  useEffect(() => {
    if (windowOpen) void notesStore.refresh();
  }, [windowOpen]);

  // -------------------------------------------------------------- stickies

  const stickies = useMemo(() => {
    const open = openStickies(notes);
    return open.filter(
      (note) =>
        note.pinnedThreadId === null ||
        visibleThreads.some((thread) => thread.threadId === note.pinnedThreadId),
    );
  }, [notes, visibleThreads]);

  return (
    <TooltipProvider delayDuration={400}>
      <NotesWindow />
      {/* A 300px card floating over a 390px screen is clutter; on the sheet
          every note is one tap away inside the window instead. */}
      {sheet
        ? null
        : stickies.map((note, index) => (
            <StickyNote key={note.id} note={note} index={index} />
          ))}
      <CaptureBar />
      {notePickerTarget !== null ? <NotePicker target={notePickerTarget} /> : null}
    </TooltipProvider>
  );
}
