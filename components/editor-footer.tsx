// The editor's status line, shared by the floating window and the nav panel:
// where the note lives (clickable — jumps to the thread), its tags (add,
// remove, filter), backlinks, autosave history, attachments, and the counts.
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { controller } from "@/lib/controller";
import { notesStore, rpc } from "@/lib/store";
import { displayTitle } from "@/components/note-list";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import type { ListedNote } from "@/lib/contract";
import { cn } from "@/lib/utils";

function wordCount(body: string): number {
  return body.trim().split(/\s+/).filter((word) => word.length > 0).length;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface RevisionMeta {
  id: string;
  createdAt: number;
  chars: number;
}

interface AttachmentMeta {
  id: string;
  mime: string;
  bytes: number;
  createdAt: number;
}

const CHIP =
  "flex shrink-0 items-center gap-0.5 rounded-full border border-border px-1.5 leading-4 transition-colors hover:bg-accent hover:text-foreground";

export function EditorFooter({
  note,
  notes,
  onTagClick,
  onOpenNote,
}: {
  note: ListedNote;
  notes: readonly ListedNote[];
  onTagClick: (tag: string) => void;
  onOpenNote: (id: string) => void;
}) {
  const compact = useIsCompactViewport();
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [revisions, setRevisions] = useState<RevisionMeta[] | null>(null);
  const [attachments, setAttachments] = useState<AttachmentMeta[] | null>(null);

  // ------------------------------------------------------------- scope

  const boundThreadId =
    note.kind === "scratchpad"
      ? note.originThreadId
      : (note.pinnedThreadId ?? note.originThreadId);

  const scopeLabel =
    note.kind === "scratchpad"
      ? `Scratchpad${note.threadTitle !== null ? ` · ${note.threadTitle}` : ""}`
      : note.kind === "daily"
        ? "Daily note"
        : note.kind === "inbox"
          ? "Inbox"
          : note.threadTitle !== null
            ? `from ${note.threadTitle}`
            : null;

  const jumpToThread = useCallback(() => {
    if (boundThreadId === null) return;
    controller.openThread(boundThreadId);
    // On the sheet the window covers everything; get out of the way.
    if (compact) controller.hideWindow();
  }, [boundThreadId, compact]);

  // -------------------------------------------------------------- tags

  const removeTag = useCallback(
    (tag: string) => {
      const stripped = note.body.replace(
        new RegExp(`(^|[\\s(])#${escapeRegExp(tag)}\\b`, "gi"),
        "$1",
      );
      void notesStore
        .updateNote({
          id: note.id,
          tags: note.tags.filter((existing) => existing !== tag),
          ...(stripped !== note.body ? { body: stripped } : {}),
        })
        .then(() => {
          toast.success(
            stripped !== note.body
              ? `Removed #${tag} (inline hashtags stripped)`
              : `Removed #${tag}`,
          );
        });
    },
    [note.id, note.body, note.tags],
  );

  const commitNewTag = useCallback(() => {
    const cleaned = newTag.trim().replace(/^#/, "").toLowerCase();
    setAddingTag(false);
    setNewTag("");
    if (cleaned.length === 0 || note.tags.includes(cleaned)) return;
    void notesStore.updateNote({ id: note.id, tags: [...note.tags, cleaned] });
  }, [newTag, note.id, note.tags]);

  // --------------------------------------------------------- backlinks

  const backlinks = useMemo(() => {
    const needle = `[[${displayTitle(note).toLowerCase()}]]`;
    return notes.filter(
      (other) => other.id !== note.id && other.body.toLowerCase().includes(needle),
    );
  }, [notes, note]);

  // ------------------------------------------------- history/attachments

  const loadRevisions = useCallback(() => {
    void rpc
      .call("listRevisions", { noteId: note.id })
      .then((result) => setRevisions(result.revisions))
      .catch(() => setRevisions([]));
  }, [note.id]);

  const restore = useCallback(
    (revisionId: string) => {
      void rpc
        .call("restoreRevision", { id: revisionId })
        .then(() => {
          void notesStore.refresh();
          toast.success("Restored — the previous state was saved to history");
        })
        .catch((error) =>
          toast.error(error instanceof Error ? error.message : "Restore failed"),
        );
    },
    [],
  );

  const loadAttachments = useCallback(() => {
    void rpc
      .call("listAttachments", { noteId: note.id })
      .then((result) => setAttachments(result.attachments))
      .catch(() => setAttachments([]));
  }, [note.id]);

  const removeAttachment = useCallback((attachmentId: string) => {
    void rpc
      .call("deleteAttachment", { id: attachmentId })
      .then(() => {
        setAttachments(
          (current) => current?.filter((a) => a.id !== attachmentId) ?? null,
        );
        void notesStore.refresh();
        toast.success("Image removed from the note");
      })
      .catch(() => toast.error("Could not remove the image"));
  }, []);

  // ------------------------------------------------------------- render

  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-hidden border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
      {scopeLabel !== null ? (
        boundThreadId !== null ? (
          <button
            type="button"
            onClick={jumpToThread}
            title="Go to thread"
            className={cn(CHIP, "max-w-40 hover:border-primary")}
          >
            <span className="truncate">{scopeLabel}</span>
            <Icon name="ArrowUpRight" className="size-2.5 shrink-0" aria-hidden />
          </button>
        ) : (
          <span className="shrink-0 truncate">{scopeLabel}</span>
        )
      ) : null}

      {note.tags.slice(0, 5).map((tag) => (
        <span key={tag} className={cn(CHIP, "group/tag")}>
          <button type="button" onClick={() => onTagClick(tag)}>
            #{tag}
          </button>
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => removeTag(tag)}
            className="hidden group-hover/tag:inline-flex"
          >
            <Icon name="X" className="size-2.5" aria-hidden />
          </button>
        </span>
      ))}
      {addingTag ? (
        <input
          autoFocus
          value={newTag}
          onChange={(event) => setNewTag(event.target.value)}
          onBlur={commitNewTag}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitNewTag();
            if (event.key === "Escape") {
              setAddingTag(false);
              setNewTag("");
            }
          }}
          placeholder="tag"
          aria-label="New tag"
          className="bb-fn-input w-16 rounded-full border border-border bg-transparent px-1.5 leading-4 outline-none"
        />
      ) : (
        <button
          type="button"
          aria-label="Add tag"
          onClick={() => setAddingTag(true)}
          className={CHIP}
        >
          <Icon name="Plus" className="size-2.5" aria-hidden />
          tag
        </button>
      )}

      {backlinks.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={CHIP} aria-label="Backlinks">
              <Icon name="ArrowTurnBackward" className="size-2.5" aria-hidden />
              {backlinks.length}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" style={{ zIndex: 68 }}>
            {backlinks.slice(0, 10).map((link) => (
              <DropdownMenuItem key={link.id} onSelect={() => onOpenNote(link.id)}>
                <Icon name="FileText" className="size-3.5" aria-hidden />
                {displayTitle(link)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <span className="min-w-0 flex-1 truncate text-right">
        {note.taskTotal > 0 ? `${note.taskDone}/${note.taskTotal} tasks · ` : ""}
        {wordCount(note.body)} words
      </span>

      <DropdownMenu
        onOpenChange={(open) => {
          if (open) loadAttachments();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button type="button" className={CHIP} aria-label="Attachments">
            <Icon name="FileAttachment" className="size-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" style={{ zIndex: 68 }}>
          {attachments === null ? (
            <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
          ) : attachments.length === 0 ? (
            <DropdownMenuItem disabled>No images — paste one in</DropdownMenuItem>
          ) : (
            attachments.map((attachment) => (
              <DropdownMenuItem
                key={attachment.id}
                onSelect={() => removeAttachment(attachment.id)}
              >
                <Icon name="Trash2" className="size-3.5" aria-hidden />
                {attachment.mime.replace("image/", "")} ·{" "}
                {Math.max(1, Math.round(attachment.bytes / 1024))} KB
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu
        onOpenChange={(open) => {
          if (open) loadRevisions();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button type="button" className={CHIP} aria-label="History">
            <Icon name="Clock" className="size-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" style={{ zIndex: 68 }}>
          {revisions === null ? (
            <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
          ) : revisions.length === 0 ? (
            <DropdownMenuItem disabled>No history yet</DropdownMenuItem>
          ) : (
            revisions.slice(0, 15).map((revision) => (
              <DropdownMenuItem
                key={revision.id}
                onSelect={() => restore(revision.id)}
              >
                <Icon name="RotateCcw" className="size-3.5" aria-hidden />
                {new Date(revision.createdAt).toLocaleString()} ·{" "}
                {revision.chars.toLocaleString()} chars
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="shrink-0">
        {new Date(note.updatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </div>
  );
}
