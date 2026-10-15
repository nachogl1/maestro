import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  useWorkJournalCandidateRunStore,
  type WorkJournalCandidateRunState,
} from "@/stores/useWorkJournalCandidateRunStore";

/**
 * The Work Journal can pop out of the right pane into its own OS window
 * (layout B), so it can sit on a second screen next to the terminals.
 */
export const WORK_JOURNAL_WINDOW_LABEL = "work-journal";

/** Query value of `?view=` that makes `main.tsx` render the journal window. */
export const WORK_JOURNAL_VIEW = "work-journal";

/**
 * Backend → every window: a command changed the journal or the candidates
 * (see `CHANGED_EVENT` in `src-tauri/src/commands/work_journal.rs`).
 */
export const WORK_JOURNAL_CHANGED_EVENT = "work-journal:changed";

/**
 * Backend → every window: a restore or undo is about to replace the journal
 * (`active`), or one failed (not `active`). See `REPLACING_EVENT` in
 * `src-tauri/src/commands/work_journal.rs`.
 */
export const WORK_JOURNAL_REPLACING_EVENT = "work-journal:replacing";

/** Pop-out window → main window: "run now" was clicked (the main window owns the runs). */
export const WORK_JOURNAL_RUN_NOW_EVENT = "work-journal:run-now";
/** Pop-out window → main window: send me the run state now (the window just opened). */
export const WORK_JOURNAL_RUN_STATE_REQUEST_EVENT = "work-journal:run-state-request";
/** Main window → pop-out window: the candidate-run state, whenever it changes. */
export const WORK_JOURNAL_RUN_STATE_EVENT = "work-journal:run-state";

/** Payload of {@link WORK_JOURNAL_CHANGED_EVENT}. */
export interface WorkJournalChangedPayload {
  /** Label of the window whose command made the change; null for the backend itself. */
  source: string | null;
  /** The whole journal was replaced (restore or undo). */
  replaced: boolean;
}

/** Payload of {@link WORK_JOURNAL_REPLACING_EVENT}. */
export interface WorkJournalReplacingPayload {
  /** Label of the window that started the restore or undo. */
  source: string | null;
  /** True before the journal is replaced; false when the replace failed. */
  active: boolean;
}

/** The data part of the candidate-run store, mirrored into the pop-out window. */
export type WorkJournalRunStateSnapshot = Partial<WorkJournalCandidateRunState>;

/** Whether this page was loaded as the journal window (from its URL query). */
export function isWorkJournalWindowView(query: string): boolean {
  return new URLSearchParams(query).get("view") === WORK_JOURNAL_VIEW;
}

/** This window's label, or null outside Tauri (tests). */
export function currentWindowLabel(): string | null {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
}

/** Open the journal window, or bring the open one forward (never a second one). */
export async function openWorkJournalWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(WORK_JOURNAL_WINDOW_LABEL);
  if (existing) {
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const params = new URLSearchParams({ view: WORK_JOURNAL_VIEW });
  const created = new WebviewWindow(WORK_JOURNAL_WINDOW_LABEL, {
    url: `index.html?${params.toString()}`,
    title: "Maestro: Work Journal",
    width: 1000,
    height: 760,
    minWidth: 560,
    minHeight: 400,
  });
  created.once("tauri://error", (event) => {
    console.error("Failed to open the Work Journal window:", event.payload);
  });
}

/**
 * Calls `onChange` when another window (or the backend) changed the journal.
 * This window's own changes are skipped: it already shows them, and re-reading
 * could put older text over what is being typed.
 */
export async function listenWorkJournalChanged(
  onChange: (payload: WorkJournalChangedPayload) => void,
): Promise<UnlistenFn> {
  const own = currentWindowLabel();
  return listen<WorkJournalChangedPayload>(WORK_JOURNAL_CHANGED_EVENT, (event) => {
    const payload = event.payload ?? { source: null, replaced: false };
    if (own !== null && payload.source === own) return;
    onChange(payload);
  });
}

/**
 * Calls `onReplacing` when a restore or undo started in another window is
 * about to replace the journal (`true`) or failed (`false`). The window that
 * started it already knows.
 */
export async function listenWorkJournalReplacing(
  onReplacing: (active: boolean) => void,
): Promise<UnlistenFn> {
  const own = currentWindowLabel();
  return listen<WorkJournalReplacingPayload>(WORK_JOURNAL_REPLACING_EVENT, (event) => {
    const payload = event.payload;
    if (!payload || (own !== null && payload.source === own)) return;
    onReplacing(payload.active);
  });
}

/** The data fields of the run store (functions are left out). */
function runStateSnapshot(state: WorkJournalCandidateRunState): WorkJournalRunStateSnapshot {
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => typeof value !== "function"),
  ) as WorkJournalRunStateSnapshot;
}

/**
 * Main window side: candidate runs belong to the main window (it knows the
 * open projects and owns the timer), so a "run now" from the pop-out window
 * runs here, and the run state (running, next run, notices, settings) is
 * sent to the pop-out window whenever it changes. Returns the stop function.
 */
export async function serveWorkJournalWindow(runNow: () => void): Promise<UnlistenFn> {
  const send = (): void => {
    const snapshot = runStateSnapshot(useWorkJournalCandidateRunStore.getState());
    void emitTo(WORK_JOURNAL_WINDOW_LABEL, WORK_JOURNAL_RUN_STATE_EVENT, snapshot).catch(() => {});
  };
  const stopRunNow = await listen(WORK_JOURNAL_RUN_NOW_EVENT, () => runNow());
  const stopRequest = await listen(WORK_JOURNAL_RUN_STATE_REQUEST_EVENT, send);
  // The pop-out window can change the run settings (the Granola question).
  const stopChanged = await listenWorkJournalChanged(() => {
    void useWorkJournalCandidateRunStore.getState().load();
  });
  const unsubscribe = useWorkJournalCandidateRunStore.subscribe(send);
  return () => {
    stopRunNow();
    stopRequest();
    stopChanged();
    unsubscribe();
  };
}

/**
 * Pop-out window side: follows the main window's run state, asks for it once
 * now, and sends this window's "run now" to the main window (this window's
 * store has no timer and no open projects of its own). Returns the stop
 * function.
 */
export async function followWorkJournalRunState(): Promise<UnlistenFn> {
  const stop = await listen<WorkJournalRunStateSnapshot>(WORK_JOURNAL_RUN_STATE_EVENT, (event) =>
    useWorkJournalCandidateRunStore.setState(event.payload ?? {}),
  );
  useWorkJournalCandidateRunStore.setState({
    runNow: async () => {
      await emitTo("main", WORK_JOURNAL_RUN_NOW_EVENT).catch(() => {});
    },
  });
  await emitTo("main", WORK_JOURNAL_RUN_STATE_REQUEST_EVENT).catch(() => {});
  return stop;
}
