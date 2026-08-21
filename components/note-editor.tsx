// One note bound to the live-markdown editor: saves through the store,
// uploads pasted images as attachments, adopts external writes, and fires
// the confetti burst the moment a checklist crosses to complete.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  MarkdownEditor,
  countTasks,
  type MarkdownEditorHandle,
} from "@/lib/editor";
import { notesStore, rpc } from "@/lib/store";
import type { ListedNote } from "@/lib/contract";
import { confettiBurst } from "@/components/confetti";
import { cn } from "@/lib/utils";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the image"));
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function NoteEditor({
  note,
  autoFocus = false,
  placeholder,
  className,
}: {
  note: ListedNote;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MarkdownEditorHandle | null>(null);
  const tasksRef = useRef({ done: note.taskDone, total: note.taskTotal });
  /** Bumped to remount the editor on an externally written body. */
  const [externalVersion, setExternalVersion] = useState(0);

  // The same note can be written by an agent tool, the CLI, or another
  // surface while this editor holds an older doc. The editor owns its doc
  // after mount (echoing our own saves back would move the caret), so an
  // external body is adopted by remounting — but only while the user is not
  // typing here: an unfocused editor has flushed its save on blur, so
  // remounting loses nothing. A focused editor is left alone.
  useEffect(() => {
    const handle = handleRef.current;
    if (handle === null) return;
    if (handle.getBody() === note.body) return;
    const container = containerRef.current;
    if (container !== null && container.contains(document.activeElement)) return;
    setExternalVersion((version) => version + 1);
  }, [note.body]);

  const onChange = useCallback((body: string) => {
    const next = countTasks(body);
    const previous = tasksRef.current;
    tasksRef.current = next;
    // Fire only on the crossing: the list was genuinely unfinished a moment
    // ago and is complete now. Opening an already-done note stays quiet.
    const crossedToComplete =
      next.total > 0 &&
      next.done === next.total &&
      previous.total > 0 &&
      previous.done < previous.total;
    if (crossedToComplete) {
      const box = containerRef.current?.getBoundingClientRect();
      if (box !== undefined) {
        confettiBurst(box.left + box.width / 2, box.top + box.height / 3);
      }
    }
  }, []);

  const noteId = note.id;
  const onSave = useCallback(
    (body: string) => {
      notesStore.saveBody(noteId, body).catch(() => {
        toast.error("Note could not be saved — it will retry on next edit.");
      });
    },
    [noteId],
  );

  const onPasteImage = useCallback(
    async (file: File) => {
      const dataBase64 = await fileToBase64(file);
      const { id } = await rpc.call("uploadAttachment", {
        noteId,
        mime: file.type,
        dataBase64,
      });
      return id;
    },
    [noteId],
  );

  const resolveAttachment = useCallback(async (id: string) => {
    const { attachment } = await rpc.call("getAttachment", { id });
    if (attachment === null) return null;
    return `data:${attachment.mime};base64,${attachment.dataBase64}`;
  }, []);

  const onOpenLink = useCallback((href: string) => {
    window.open(href, "_blank", "noopener,noreferrer");
  }, []);

  // Remount cleanly per note (and per adopted external body); the editor
  // flushes the old note's save first.
  const editor = useMemo(
    () => (
      <MarkdownEditor
        key={`${note.id}:${externalVersion}`}
        ref={handleRef}
        noteId={note.id}
        initialBody={note.body}
        onSave={onSave}
        onChange={onChange}
        onPasteImage={onPasteImage}
        resolveAttachment={resolveAttachment}
        onOpenLink={onOpenLink}
        placeholder={placeholder ?? "Write…"}
        autoFocus={autoFocus}
        className="size-full"
      />
    ),
    // note.body is deliberately not a dependency: the editor owns the doc
    // after mount, and our own saves echoing back in would move the caret.
    // externalVersion is how a genuinely external body gets in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note.id, externalVersion, onSave, onChange, onPasteImage, resolveAttachment, onOpenLink],
  );

  return (
    <div ref={containerRef} className={cn("min-h-0 flex-1 overflow-hidden", className)}>
      {editor}
    </div>
  );
}
