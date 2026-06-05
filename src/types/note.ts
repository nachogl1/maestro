/**
 * A single notepad tab. Notes live in the right-side pane next to the GitHub
 * views and are persisted across app restarts via {@link useNotesStore}.
 *
 * Notes are fully user-managed: they are only ever created and deleted by
 * explicit user action. (They used to be auto-created per terminal session,
 * but that meant deleted notes kept resurfacing while their session lived.)
 */
export interface Note {
  /** Stable identifier — never reused. */
  id: string;
  /** Tab title. */
  title: string;
  /** Plain-text note body. */
  content: string;
  createdAt: number;
  updatedAt: number;
}
