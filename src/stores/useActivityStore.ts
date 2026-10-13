import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { ClaudeEvent } from "@/types/claude-events";

interface SessionActivity {
  events: ClaudeEvent[];
  totalInputTokens: number;
  totalOutputTokens: number;
  filesModified: string[];
  /**
   * Every Claude conversation UUID that has run in this terminal. Unlike
   * `events` (capped at MAX_EVENTS_PER_SESSION) these are never evicted —
   * the History tab's double-resume guard reads them, and a guard derived
   * from the capped event list broke on long sessions.
   */
  conversationUuids: string[];
}

interface ActivityState {
  sessions: Record<number, SessionActivity>;
  /**
   * Fold a whole batch of events into the store in ONE set() call. The backend
   * coalesces events on a 16ms timer, so a transcript replay arrives as a few
   * hundred-event batches instead of hundreds of individual messages; folding
   * them together collapses hundreds of renders into one.
   */
  addEvents: (events: ClaudeEvent[]) => void;
  getSession: (sessionId: number) => SessionActivity;
  clearSession: (sessionId: number) => void;
}

const MAX_EVENTS_PER_SESSION = 500;

function createEmptySession(): SessionActivity {
  return {
    events: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    filesModified: [],
    conversationUuids: [],
  };
}

// Returned by getSession for sessions with no activity yet. Must be a single
// stable reference: getSession runs as a zustand selector (getSnapshot), and
// returning a fresh object every call makes React re-render in an infinite
// loop ("Maximum update depth exceeded").
const EMPTY_SESSION: SessionActivity = Object.freeze(createEmptySession());

/**
 * Apply a batch of events to the sessions map and return the new map.
 *
 * Each touched session is copied exactly once (one events-array copy, one
 * record spread) no matter how many events the batch carries, and the
 * MAX_EVENTS_PER_SESSION cap is applied once at the end — "keep the last N"
 * gives the same result applied per-event or once, and a SessionStarted reset
 * mid-batch restarts the array so each run is capped on its own events.
 */
function foldEvents(
  sessions: Record<number, SessionActivity>,
  batch: ClaudeEvent[],
): Record<number, SessionActivity> {
  // Mutable working copies, keyed by session. `events` is always a fresh array
  // so pushing into it never touches the previous state.
  const drafts = new Map<number, SessionActivity>();

  for (const event of batch) {
    const sessionId = event.session_id;
    let draft = drafts.get(sessionId);
    if (!draft) {
      const session = sessions[sessionId] ?? createEmptySession();
      draft = { ...session, events: [...session.events] };
      drafts.set(sessionId, draft);
    }

    // A SessionStarted hook marks a fresh claude process in this terminal,
    // and the transcript watcher then replays its conversation from byte 0.
    // Reset the activity so the replay rebuilds it exactly once —
    // accumulating across runs double-counted every resumed token. The
    // conversation UUIDs survive the reset: they are identity, not activity.
    if (event.event_type === "SessionStarted") {
      const conversationUuids = draft.conversationUuids.includes(event.claude_session_uuid)
        ? draft.conversationUuids
        : [...draft.conversationUuids, event.claude_session_uuid];
      drafts.set(sessionId, { ...createEmptySession(), events: [event], conversationUuids });
      continue;
    }

    draft.events.push(event);

    // Update aggregates
    if (event.event_type === "TokenUsageUpdate") {
      draft.totalInputTokens += event.input_tokens;
      draft.totalOutputTokens += event.output_tokens;
    } else if (event.event_type === "FileEdited" || event.event_type === "FileCreated") {
      if (!draft.filesModified.includes(event.file_path)) {
        draft.filesModified = [...draft.filesModified, event.file_path];
      }
    }
  }

  const next = { ...sessions };
  for (const [sessionId, draft] of drafts) {
    // Apply the cap once, to the folded array
    if (draft.events.length > MAX_EVENTS_PER_SESSION) {
      draft.events.splice(0, draft.events.length - MAX_EVENTS_PER_SESSION);
    }
    next[sessionId] = draft;
  }
  return next;
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  sessions: {},

  getSession: (sessionId: number) => {
    return get().sessions[sessionId] ?? EMPTY_SESSION;
  },

  addEvents: (events: ClaudeEvent[]) => {
    if (events.length === 0) return;
    set((state) => ({ sessions: foldEvents(state.sessions, events) }));
  },

  clearSession: (sessionId: number) => {
    set((state) => {
      const { [sessionId]: _, ...rest } = state.sessions;
      return { sessions: rest };
    });
  },
}));

// Global event listener. `active` tracks the *desired* state so an init/stop
// pair that races the pending listen() promise (React StrictMode's dev
// double-mount) can't leak a second listener. Mirrors useAgentStore.
let unlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;
let active = false;

export async function initActivityListener(): Promise<void> {
  active = true;
  if (unlisten || starting) return;
  starting = listen<ClaudeEvent[]>("claude-events", (event) => {
    useActivityStore.getState().addEvents(event.payload);
  })
    .then((fn) => {
      if (!active) {
        fn();
        return;
      }
      unlisten = fn;
    })
    .finally(() => {
      starting = null;
    });
  await starting;
}

export function stopActivityListener(): void {
  active = false;
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}
