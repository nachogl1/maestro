import type { Note } from "@/types/note";

/**
 * Minimal projection of a session needed for notes reconciliation.
 * Decoupled from the full `SessionConfig` so the logic is easy to unit-test.
 */
export interface NotesSessionInput {
  id: number;
  /** User-facing terminal name, or null if the session has no custom name. */
  name?: string | null;
}

/**
 * Default tab title for a session that has no custom name.
 * Mirrors the sidebar's fallback (`#${id}`) so behaviour is consistent.
 */
export function defaultTitleForSession(s: NotesSessionInput): string {
  return s.name && s.name.trim().length > 0 ? s.name : `#${s.id}`;
}

/**
 * Reconcile the notes list against the current set of sessions.
 *
 * Rules:
 *   1. A new session with no existing bound note gets a freshly-created note,
 *      bound to it, titled after the session.
 *   2. A bound session whose name changes updates its note's title — UNLESS
 *      the user has manually renamed the tab.
 *   3. A bound session that disappears: the note stays, but its `boundSessionId`
 *      is cleared so a future session with the same id won't reattach.
 *
 * Returns `null` when no changes are needed (callers can skip the state write
 * to avoid extra renders).
 */
export function reconcileNotesWithSessions(
  notes: Note[],
  sessions: NotesSessionInput[],
  now: number = Date.now(),
): Note[] | null {
  let changed = false;
  const sessionsById = new Map<number, NotesSessionInput>();
  for (const s of sessions) sessionsById.set(s.id, s);

  // Pass 1: walk existing notes — update titles, unbind disappeared sessions.
  const updated: Note[] = notes.map((note) => {
    if (note.boundSessionId === undefined) return note;

    const session = sessionsById.get(note.boundSessionId);
    if (!session) {
      // Bound session disappeared — keep the note, just unbind it.
      changed = true;
      const { boundSessionId: _drop, ...rest } = note;
      return { ...rest, updatedAt: now };
    }

    // Bound session exists — sync the title unless the user took ownership.
    if (!note.manuallyRenamed) {
      const desired = defaultTitleForSession(session);
      if (note.title !== desired) {
        changed = true;
        return { ...note, title: desired, updatedAt: now };
      }
    }
    return note;
  });

  // Pass 2: auto-create notes for sessions that don't yet have a bound note.
  const boundIds = new Set<number>();
  for (const n of updated) {
    if (n.boundSessionId !== undefined) boundIds.add(n.boundSessionId);
  }

  const toAdd: Note[] = [];
  for (const s of sessions) {
    if (boundIds.has(s.id)) continue;
    toAdd.push({
      id: makeNoteId(),
      title: defaultTitleForSession(s),
      content: "",
      boundSessionId: s.id,
      manuallyRenamed: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (toAdd.length > 0) changed = true;

  if (!changed) return null;
  return [...updated, ...toAdd];
}

/**
 * ID factory split out so tests can deterministically stub it via Math.random.
 * `crypto.randomUUID` would also work but the existing stores mix both styles.
 */
function makeNoteId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `note-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
