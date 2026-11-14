import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { samePath } from "@/lib/path";
import type { AiMode } from "@/lib/terminal";
import { useActivityStore } from "@/stores/useActivityStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

/**
 * Crash recovery (issue #608). While Maestro runs, the list of open terminals
 * is kept on disk in Maestro's app data (`core::open_terminals` in the
 * backend). Every normal close removes it, so a list found on start means
 * Maestro stopped unexpectedly: the start-up dialog offers to bring the
 * terminals back, and this store reopens the ticked ones. A list the update
 * install marked (issue #609) is brought back whole with no dialog.
 */

/** One open terminal as the saved list holds it (mirrors the Rust `OpenTerminal`). */
export interface OpenTerminal {
  projectPath: string;
  name: string | null;
  kind: AiMode;
  /** The folder it ran in: the project, or a worktree. */
  workingDirectory: string;
  branch: string | null;
  pinned: boolean;
  parked: boolean;
  /** Owned by a Samurai run: never offered, only counted. */
  samurai: boolean;
  /** The Claude conversation it was on, from the SessionStart hook. */
  conversationId: string | null;
}

/** A terminal from the list found on start, with what is still on disk. */
export interface OfferedTerminal extends OpenTerminal {
  folderExists: boolean;
  conversationFound: boolean;
}

/** The list found on start (an unexpected stop, or an update). */
export interface OpenTerminalsOffer {
  /** Epoch milliseconds of the last save, the closest record of the stop. */
  savedAt: number;
  /** Maestro closed to install an update: bring everything back with no dialog. */
  afterUpdate: boolean;
  terminals: OfferedTerminal[];
}

/**
 * A change is saved this long after it, so a burst is one write. Not reset by
 * later changes: a busy Claude stream changes the activity store many times a
 * second and must not hold a new terminal's save back.
 */
const SAVE_DEBOUNCE_MS = 300;
/**
 * While terminals are open the list is saved again this often, so its time
 * stays close to the moment Maestro stopped (the dialog shows it).
 */
const HEARTBEAT_MS = 60_000;
/**
 * How long a reopened terminal's settings (pin, park, warning) wait for its
 * session. A launch that failed must not hand them to a terminal the user
 * opens later.
 */
const RESTORE_MARK_TTL_MS = 2 * 60_000;

/** The status message a terminal brought back onto the shelf shows. */
export const BROUGHT_BACK_MESSAGE = "Brought back after Maestro stopped";

/** What the saved list needs from the app's stores. */
export interface OpenTerminalsInput {
  tabs: WorkspaceTab[];
  sessions: SessionConfig[];
  parkedSessionIds: number[];
  pinnedSessionIds: number[];
  /** Ids of terminals a Samurai run supervises. */
  samuraiSessionIds: number[];
  /** Each terminal's current Claude conversation, by session id. */
  conversationBySessionId: Record<number, string | undefined>;
}

function toOpenTerminal(session: SessionConfig, input: OpenTerminalsInput): OpenTerminal {
  return {
    projectPath: session.project_path,
    name: session.name?.trim() || null,
    kind: session.mode,
    workingDirectory: session.working_directory ?? session.worktree_path ?? session.project_path,
    branch: session.branch,
    pinned: input.pinnedSessionIds.includes(session.id),
    parked: input.parkedSessionIds.includes(session.id),
    samurai: input.samuraiSessionIds.includes(session.id),
    conversationId:
      session.mode === "Claude" ? (input.conversationBySessionId[session.id] ?? null) : null,
  };
}

/**
 * The list of open terminals to save: grouped by project in the order of the
 * project tabs, and within a project in the order its terminals were opened.
 * Terminals of a project with no tab come last, in the order they were opened.
 */
export function buildOpenTerminals(input: OpenTerminalsInput): OpenTerminal[] {
  const listed = new Set<number>();
  const ordered: SessionConfig[] = [];
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  for (const tab of input.tabs) {
    const own = tab.sessionIds
      .map((id) => byId.get(id))
      .filter(
        (s): s is SessionConfig => s !== undefined && samePath(s.project_path, tab.projectPath),
      );
    const rest = input.sessions.filter(
      (s) => samePath(s.project_path, tab.projectPath) && !own.includes(s),
    );
    for (const session of [...own, ...rest]) {
      if (listed.has(session.id)) continue;
      listed.add(session.id);
      ordered.push(session);
    }
  }
  for (const session of input.sessions) {
    if (!listed.has(session.id)) ordered.push(session);
  }
  return ordered.map((s) => toOpenTerminal(s, input));
}

/** Reads the saved-list input from the live stores. */
function currentInput(): OpenTerminalsInput {
  const session = useSessionStore.getState();
  const activity = useActivityStore.getState().sessions;
  const conversationBySessionId: Record<number, string | undefined> = {};
  for (const s of session.sessions) {
    const conversations = activity[s.id]?.conversationUuids ?? [];
    conversationBySessionId[s.id] = conversations[conversations.length - 1];
  }
  return {
    tabs: useWorkspaceStore.getState().tabs,
    sessions: session.sessions,
    parkedSessionIds: session.parkedSessionIds,
    pinnedSessionIds: session.pinnedSessionIds,
    samuraiSessionIds: Object.keys(session.samuraiBySessionId).map(Number),
    conversationBySessionId,
  };
}

/** Whether a terminal from the list can be ticked and brought back. */
export function canBringBack(terminal: OfferedTerminal): boolean {
  return terminal.folderExists && !terminal.samurai;
}

/** Whether a terminal comes back as a resumed Claude conversation. */
function resumes(terminal: OfferedTerminal): boolean {
  return terminal.kind === "Claude" && terminal.conversationFound && !!terminal.conversationId;
}

/** What a reopened terminal must get once its session exists. */
interface RestoreMark {
  pinned: boolean;
  parked: boolean;
  /** Show the amber "earlier content could not be retrieved" line. */
  warn: boolean;
  expiresAt: number;
}

/**
 * Marks waiting for their session, per project, in launch order. A project's
 * queued launches open one after another in that order, so its next new
 * terminal is the next mark's.
 */
const pendingMarks: Array<{ projectPath: string; marks: RestoreMark[] }> = [];
/** Sessions already seen, so only a new one takes a mark. */
let knownSessionIds = new Set<number>();
/**
 * Parked Claude terminals brought back, by session id, with when to stop
 * watching. Their resumed claude reports "Session started" (Idle) a moment
 * after launch, which would wipe the needs-you signal; it is painted again
 * once, right after that.
 */
const needsYouAfterStart = new Map<number, number>();
let markWatcher: (() => void) | null = null;

let syncUnsubscribers: Array<() => void> = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let lastSaved: string | null = null;
let begun = false;

async function save(force: boolean): Promise<void> {
  const terminals = buildOpenTerminals(currentInput());
  const text = JSON.stringify(terminals);
  if (!force && text === lastSaved) return;
  lastSaved = text;
  try {
    await invoke("open_terminals_save", { terminals });
  } catch (err) {
    console.error("Failed to save the list of open terminals:", err);
    lastSaved = null;
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save(false);
  }, SAVE_DEBOUNCE_MS);
}

/** A closed terminal's warning goes with it. */
function forgetClosedWarnings(state: { sessions: SessionConfig[] }): void {
  const { warnedSessionIds } = useOpenTerminalsSnapshotStore.getState();
  const kept = warnedSessionIds.filter((id) => state.sessions.some((s) => s.id === id));
  if (kept.length !== warnedSessionIds.length) {
    useOpenTerminalsSnapshotStore.setState({ warnedSessionIds: kept });
  }
}

/** Keeps the saved list in step with the open terminals from now on. */
function startSync(): void {
  if (syncUnsubscribers.length > 0) return;
  syncUnsubscribers = [
    useSessionStore.subscribe(scheduleSave),
    useSessionStore.subscribe(forgetClosedWarnings),
    useWorkspaceStore.subscribe(scheduleSave),
    useActivityStore.subscribe(scheduleSave),
  ];
  heartbeat = setInterval(() => {
    if (useSessionStore.getState().sessions.length > 0) void save(true);
  }, HEARTBEAT_MS);
  void save(true);
}

/** Hands each new session in a project with waiting marks the next mark. */
function applyMarks(sessions: SessionConfig[]): void {
  const now = Date.now();
  for (const entry of pendingMarks) {
    entry.marks = entry.marks.filter((m) => m.expiresAt > now);
  }
  for (const session of sessions) {
    if (knownSessionIds.has(session.id)) continue;
    knownSessionIds.add(session.id);
    const entry = pendingMarks.find(
      (e) => e.marks.length > 0 && samePath(e.projectPath, session.project_path),
    );
    const mark = entry?.marks.shift();
    if (mark) applyMark(session, mark);
  }
  knownSessionIds = new Set(sessions.map((s) => s.id));
}

/** Paints the needs-you signal again on a parked Claude terminal its start just turned Idle. */
function keepNeedsYou(): void {
  // Read live, not the notified state: painting it from inside this listener
  // notifies again, so the state an outer call was handed may be stale.
  const { sessions } = useSessionStore.getState();
  const now = Date.now();
  for (const [sessionId, expiresAt] of needsYouAfterStart) {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || expiresAt <= now) {
      needsYouAfterStart.delete(sessionId);
    } else if (session.status === "Idle") {
      needsYouAfterStart.delete(sessionId);
      markNeedsYou(sessionId);
    }
  }
}

/** The shelf's "needs you" signal: it was cut off, so it waits on the user. */
function markNeedsYou(sessionId: number): void {
  useSessionStore.getState().updateSession(sessionId, {
    status: "NeedsInput",
    statusMessage: BROUGHT_BACK_MESSAGE,
  });
}

function applyMark(session: SessionConfig, mark: RestoreMark): void {
  const sessionId = session.id;
  const sessions = useSessionStore.getState();
  if (mark.pinned && !sessions.pinnedSessionIds.includes(sessionId)) {
    sessions.toggleSessionPin(sessionId);
  }
  if (mark.parked) {
    if (session.mode === "Claude") needsYouAfterStart.set(sessionId, mark.expiresAt);
    sessions.parkSession(sessionId);
    markNeedsYou(sessionId);
  }
  if (mark.warn) {
    useOpenTerminalsSnapshotStore.setState((s) => ({
      warnedSessionIds: [...s.warnedSessionIds, sessionId],
    }));
  }
}

function startMarkWatcher(): void {
  if (markWatcher) return;
  knownSessionIds = new Set(useSessionStore.getState().sessions.map((s) => s.id));
  markWatcher = useSessionStore.subscribe((state, prev) => {
    if (state.sessions === prev.sessions) return;
    applyMarks(state.sessions);
    keepNeedsYou();
    const waiting = pendingMarks.some((e) => e.marks.length > 0) || needsYouAfterStart.size > 0;
    if (!waiting) stopMarkWatcher();
  });
}

function stopMarkWatcher(): void {
  markWatcher?.();
  markWatcher = null;
}

/** The project tab for `projectPath`, opening it when it is not open any more. */
async function tabFor(projectPath: string): Promise<WorkspaceTab | null> {
  const find = () =>
    useWorkspaceStore.getState().tabs.find((t) => samePath(t.projectPath, projectPath));
  const open = find();
  if (open) return open;
  try {
    await useWorkspaceStore.getState().openProject(projectPath);
  } catch (err) {
    console.error("Failed to reopen the project of a terminal:", err);
  }
  return find() ?? null;
}

interface OpenTerminalsSnapshotState {
  /** The list found on start, while the dialog asks about it; null otherwise. */
  offer: OpenTerminalsOffer | null;
  /** Reopened terminals that show the amber warning line until it is closed. */
  warnedSessionIds: number[];
  /**
   * Reads the list a previous run left: brings it back at once when an update
   * closed Maestro, offers it after an unexpected stop, or starts saving.
   */
  begin: () => Promise<void>;
  /** "Don't bring back", × or Esc: the list is removed for good. */
  decline: () => Promise<void>;
  /** "Bring back N": reopens these terminals, in the list's order. */
  bringBack: (terminals: OfferedTerminal[]) => Promise<void>;
  /** The × on a terminal's warning line. */
  dismissWarning: (sessionId: number) => void;
}

async function clearSavedList(): Promise<void> {
  try {
    await invoke("open_terminals_clear");
  } catch (err) {
    console.error("Failed to remove the list of open terminals:", err);
  }
}

/**
 * Removes the saved list, then reopens the given terminals that can come
 * back, in the list's order, and starts saving the new list.
 */
async function restore(terminals: OfferedTerminal[]): Promise<void> {
  await clearSavedList();
  const chosen = terminals.filter(canBringBack);
  const expiresAt = Date.now() + RESTORE_MARK_TTL_MS;
  startMarkWatcher();
  for (const [position, terminal] of chosen.entries()) {
    const tab = await tabFor(terminal.projectPath);
    if (!tab) continue;
    const resume = resumes(terminal);
    let entry = pendingMarks.find((e) => samePath(e.projectPath, tab.projectPath));
    if (!entry) {
      entry = { projectPath: tab.projectPath, marks: [] };
      pendingMarks.push(entry);
    }
    entry.marks.push({
      pinned: terminal.pinned,
      parked: terminal.parked,
      warn: !resume,
      expiresAt,
    });
    usePendingLaunchStore.getState().request({
      tabId: tab.id,
      mode: terminal.kind,
      resumeSessionId: resume ? terminal.conversationId : null,
      workingDirOverride: terminal.workingDirectory,
      branch: terminal.branch,
      customName: terminal.name,
      restoreKey: `${expiresAt}:${position}`,
    });
    useWorkspaceStore.getState().setSessionsLaunched(tab.id, true);
  }
  startSync();
}

export const useOpenTerminalsSnapshotStore = create<OpenTerminalsSnapshotState>((set, get) => ({
  offer: null,
  warnedSessionIds: [],

  begin: async () => {
    if (begun) return;
    begun = true;
    let offer: OpenTerminalsOffer | null = null;
    try {
      offer = await invoke<OpenTerminalsOffer | null>("open_terminals_load");
    } catch (err) {
      console.error("Failed to read the list of open terminals:", err);
    }
    if (offer?.afterUpdate === true) {
      await restore(offer.terminals);
      return;
    }
    if (offer?.terminals.some((t) => !t.samurai)) {
      set({ offer });
      return;
    }
    // Nothing to offer: no list, or only Samurai terminals (which recover
    // from their own panel). Saving the new list replaces the old one.
    startSync();
  },

  decline: async () => {
    if (!get().offer) return;
    set({ offer: null });
    await clearSavedList();
    startSync();
  },

  bringBack: async (terminals: OfferedTerminal[]) => {
    if (!get().offer) return;
    set({ offer: null });
    await restore(terminals);
  },

  dismissWarning: (sessionId: number) => {
    set((s) => ({ warnedSessionIds: s.warnedSessionIds.filter((id) => id !== sessionId) }));
  },
}));

/** Test seam: forgets every module-level bit of state between tests. */
export function resetOpenTerminalsSnapshotForTests(): void {
  for (const unsubscribe of syncUnsubscribers) unsubscribe();
  syncUnsubscribers = [];
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  stopMarkWatcher();
  pendingMarks.length = 0;
  needsYouAfterStart.clear();
  knownSessionIds = new Set();
  lastSaved = null;
  begun = false;
  useOpenTerminalsSnapshotStore.setState({ offer: null, warnedSessionIds: [] });
}
