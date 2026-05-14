import { Plus, Trash2, X } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNotesStore } from "@/stores/useNotesStore";

/**
 * Right-pane Notepad view. Shows a horizontal strip of note tabs and a single
 * textarea for the active note's content.
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
    // Notes can contain useful content — confirm before nuking.
    const note = notes.find((n) => n.id === id);
    const title = note?.title ?? "this note";
    if (!window.confirm(`Delete "${title}"? Its content will be lost.`)) return;
    deleteNote(id);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-px overflow-x-auto border-b border-maestro-border bg-maestro-bg">
        {notes.map((note) => {
          const isActive = note.id === activeNoteId;
          const isRenaming = note.id === renamingId;
          return (
            <div
              key={note.id}
              className={`group flex shrink-0 items-center gap-1 border-r border-maestro-border px-2 py-1.5 text-xs transition-colors ${
                isActive
                  ? "bg-maestro-surface text-maestro-text"
                  : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
              }`}
              title={
                note.boundSessionId !== undefined
                  ? `Bound to session #${note.boundSessionId}`
                  : "Manual note"
              }
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
                  onClick={() => setActiveNote(note.id)}
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
              {activeNote.boundSessionId !== undefined && !activeNote.manuallyRenamed && (
                <span className="ml-1 text-maestro-muted/60">(follows session)</span>
              )}
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
