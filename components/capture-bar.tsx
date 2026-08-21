// Quick capture: one bar, type, Enter, gone.
//
// Tab flips the target between the Inbox note and the current thread's
// scratchpad. Nothing else to manage — the bar exists so a thought can be
// parked without opening a window while an agent is mid-stream.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { controller } from "@/lib/controller";
import { useControllerState, useNotesState } from "@/lib/hooks";
import { notesStore } from "@/lib/store";
import { cn } from "@/lib/utils";

type Target = "inbox" | "scratchpad";

export function CaptureBar() {
  const { captureOpen } = useControllerState();
  const { config } = useNotesState();
  const [text, setText] = useState("");
  const [target, setTarget] = useState<Target>("inbox");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const thread = controller.activeThread();
  const scratchpadAvailable = thread !== null;
  // What the save will actually do: the scratchpad target silently falls
  // back to the inbox when the thread has gone away, and the label must say
  // so rather than promising a scratchpad the save won't touch.
  const effectiveTarget: Target =
    target === "scratchpad" && scratchpadAvailable ? "scratchpad" : "inbox";

  useEffect(() => {
    if (!captureOpen) return;
    setText("");
    setTarget(
      config.captureTarget === "scratchpad" && scratchpadAvailable
        ? "scratchpad"
        : "inbox",
    );
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
    // Only when the bar opens; retargeting mid-typing would be rude.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureOpen]);

  const close = useCallback(() => controller.closeCapture(), []);

  const save = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || saving) {
      close();
      return;
    }
    setSaving(true);
    try {
      if (effectiveTarget === "scratchpad" && thread !== null) {
        const pad = await notesStore.scratchpad(thread.threadId, thread.projectId);
        await notesStore.appendToNote(pad.id, `- ${trimmed}`);
        toast.success("Captured to the thread scratchpad");
      } else {
        const inbox = await notesStore.inboxNote();
        await notesStore.appendToNote(inbox.id, `- ${trimmed}`);
        toast.success("Captured to Inbox");
      }
      close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Capture failed");
    } finally {
      setSaving(false);
    }
  }, [text, saving, effectiveTarget, thread, close]);

  if (!captureOpen) return null;

  return (
    <>
      <div className="bb-fn-capture-backdrop" onPointerDown={close} aria-hidden="true" />
      <div
        className="bb-fn-capture"
        data-state="open"
        role="dialog"
        aria-modal="true"
        aria-label="Quick capture"
      >
        <div className="overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
          <textarea
            ref={inputRef}
            value={text}
            rows={Math.min(6, Math.max(1, text.split("\n").length))}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                if (scratchpadAvailable) {
                  setTarget((current) => (current === "inbox" ? "scratchpad" : "inbox"));
                }
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void save();
              }
            }}
            placeholder="Capture a thought…"
            aria-label="Capture text"
            className="bb-fn-input block w-full resize-none bg-transparent px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Icon
                name={effectiveTarget === "inbox" ? "Archive" : "FileText"}
                className="size-3"
                aria-hidden
              />
              {effectiveTarget === "inbox" ? "Inbox" : "This thread's scratchpad"}
              {scratchpadAvailable ? (
                <span className={cn("ml-1 rounded border border-border px-1")}>
                  Tab to switch
                </span>
              ) : null}
            </span>
            <span>Enter saves · Shift+Enter newline · Esc closes</span>
          </div>
        </div>
      </div>
    </>
  );
}
