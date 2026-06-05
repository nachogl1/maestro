import { Plus, Trash2, X } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNotesStore } from "@/stores/useNotesStore";

/**
 * Right-pane Notepad view. Shows a horizontal strip of note tabs and a single
 * textarea for the active note's content.
 *
 * Notes are fully user-managed: created via the "New" button, deleted via the
 * X — nothing is auto-created or auto-removed behind the user's back.
 *
 * Layout note: this lives inside the existing `GitGraphPanel`'s flex column,
 * so it fills the remaining height under the tab bar without needing fixed
 * sizing.
 */
export function NotepadPanel() {
  const notes = useNotesStore((s) => s.notes);
  const activeNoteId = useNotesStore((s) => s.activeNoteId);
  const setActiveNote = useNotesStore((s) => s.setActiveNote);
  const addManualNote = useNotesStore((s) => s.addManualNote);
  const renameNote = useNotesStore((s) => s.renameNote);
  const setContent = useNotesStore((s) => s.setContent);
  const deleteNote = useNotesStore((s) => s.deleteNote);
  const moveNote = useNotesStore((s) => s.moveNote);

  const activeNote = useMemo(
    () => notes.find((n) => n.id === activeNoteId) ?? null,
    [notes, activeNoteId],
  );

  // Auto-select the first note if nothing is active but notes exist.
  useEffect(() => {
    if (!activeNoteId && notes.length > 0) {
      setActiveNote(notes[0].id);
    }
  }, [activeNoteId, notes, setActiveNote]);

  // Inline rename state — we render an input in place of the tab label.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // --- Tab drag-reorder ---
  // Pointer events instead of HTML5 DnD: Tauri's WebView2 shows a "no drop"
  // cursor for custom drags (same reason TerminalGrid's DraggablePane uses
  // pointer events). A small movement threshold keeps click (select) and
  // double-click (rename) working on the same tab.
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const suppressClickRef = useRef(false);

  const startTabDrag = (e: React.PointerEvent<HTMLDivElement>, noteId: string) => {
    // Left button / touch only, and never while renaming this tab.
    if ((e.button !== 0 && e.pointerType !== "touch") || renamingId === noteId) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) {
          return; // below threshold — still a click
        }
        dragging = true;
        setDraggingNoteId(noteId);
      }
      // Live-reorder: drop the dragged note into the slot under the pointer.
      const el = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>("[data-note-tab-id]");
      const overId = el?.dataset.noteTabId;
      if (!overId || overId === noteId) return;
      const current = useNotesStore.getState().notes;
      const toIndex = current.findIndex((n) => n.id === overId);
      if (toIndex >= 0) moveNote(noteId, toIndex);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (dragging) {
        // Swallow the click that follows pointerup so the drag doesn't also
        // change tab selection / trigger buttons under the pointer.
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      setDraggingNoteId(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const startRename = (id: string, currentTitle: string) => {
    setRenamingId(id);
    setRenameValue(currentTitle);
  };

  const commitRename = () => {
    if (!renamingId) return;
    renameNote(renamingId, renameValue);
    setRenamingId(null);
    setRenameValue("");
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const handleRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  };

  const handleContentChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    if (!activeNote) return;
    setContent(activeNote.id, e.target.value);
  };

  const handleDelete = (id: string) => {
    if (suppressClickRef.current) return;
    // Notes can contain useful content — confirm before nuking.
    const note = notes.find((n) => n.id === id);
    const title = note?.title ?? "this note";
    if (!window.confirm(`Delete "${title}"? Its content will be lost.`)) return;
    deleteNote(id);
  };

  const handleSelect = (id: string) => {
    if (suppressClickRef.current) return;
    setActiveNote(id);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-px overflow-x-auto border-b border-maestro-border bg-maestro-bg">
        {notes.map((note) => {
          const isActive = note.id === activeNoteId;
          const isRenaming = note.id === renamingId;
          const isDragging = note.id === draggingNoteId;
          return (
            <div
              key={note.id}
              data-note-tab-id={note.id}
              onPointerDown={(e) => startTabDrag(e, note.id)}
              className={`group flex shrink-0 items-center gap-1 border-r border-maestro-border px-2 py-1.5 text-xs transition-colors ${
                isActive
                  ? "bg-maestro-surface text-maestro-text"
                  : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
              } ${isDragging ? "opacity-50" : ""}`}
              title="Drag to reorder"
            >
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={handleRenameKey}
                  className="w-24 rounded bg-maestro-card px-1 py-0.5 text-xs text-maestro-text outline-none focus:ring-1 focus:ring-maestro-accent"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => handleSelect(note.id)}
                  onDoubleClick={() => startRename(note.id, note.title)}
                  className="max-w-[140px] truncate"
                >
                  {note.title}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleDelete(note.id)}
                className="rounded p-0.5 text-maestro-muted opacity-0 transition-opacity hover:bg-maestro-border hover:text-maestro-text group-hover:opacity-100"
                aria-label={`Delete note ${note.title}`}
                title="Delete note"
              >
                <X size={10} />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => addManualNote()}
          className="flex shrink-0 items-center gap-1 px-2 py-1.5 text-xs text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
          title="Create a new note"
        >
          <Plus size={12} />
          <span>New</span>
        </button>
      </div>

      {/* Editor */}
      {activeNote ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-maestro-border px-3 py-1.5 text-[10px] text-maestro-muted">
            <button
              type="button"
              onClick={() => startRename(activeNote.id, activeNote.title)}
              className="truncate text-left hover:text-maestro-text"
              title="Click to rename"
            >
              {activeNote.title}
            </button>
            <button
              type="button"
              onClick={() => handleDelete(activeNote.id)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-red"
              title="Delete this note"
            >
              <Trash2 size={11} />
            </button>
          </div>
          <textarea
            // Keying on the id ensures the textarea remounts when switching
            // tabs, so cursor position is reset cleanly per note.
            key={activeNote.id}
            value={activeNote.content}
            onChange={handleContentChange}
            placeholder="Jot something down..."
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-maestro-surface px-3 py-2 font-mono text-xs text-maestro-text outline-none placeholder:text-maestro-muted/40"
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <div className="flex flex-col items-center gap-2 text-maestro-muted/60">
            <p className="text-xs">No notes yet.</p>
            <button
              type="button"
              onClick={() => addManualNote()}
              className="flex items-center gap-1 rounded bg-maestro-card px-2 py-1 text-xs text-maestro-text transition-colors hover:bg-maestro-border"
            >
              <Plus size={12} />
              <span>Create a note</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
