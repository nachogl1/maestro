/**
 * A single notepad tab. Notes live in the right-side pane next to the GitHub
 * views and are persisted across app restarts via {@link useNotesStore}.
 *
 * One note can optionally be "bound" to a session — its title then tracks the
 * session's terminal name unless the user has manually renamed it.
 */
export interface Note {
  /** Stable identifier — never reused, even after a session is closed. */
  id: string;
  /** Tab title. May follow the bound session's name (see `manuallyRenamed`). */
  title: string;
  /** Plain-text note body. */
  content: string;
  /**
   * Numeric session id this note was auto-created for, if any.
   * Stays set after the session disappears so we can still match on resurrect,
   * but the title is frozen at that point (sessions are ephemeral and the same
   * id can be reused; we treat a re-appeared session as a fresh one and never
   * re-bind an unbound note).
   *
   * Cleared when the bound session is removed.
   */
  boundSessionId?: number;
  /**
   * `true` if the user has manually edited the tab name. Once set, the title
   * is no longer auto-updated from the session.
   */
  manuallyRenamed?: boolean;
  createdAt: number;
  updatedAt: number;
}
