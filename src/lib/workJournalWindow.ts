import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import {
  useWorkJournalCandidateRunStore,
  type WorkJournalCandidateRunState,
} from "@/stores/useWorkJournalCandidateRunStore";
import { flushWorkJournalSaves } from "@/stores/useWorkJournalStore";

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
/**
 * Pop-out window → main window: open Maestro Settings at the Work Journal
 * section. Settings opens only in the main window, so the pop-out's own
 * copies of other stores never write stale values back.
 */
export const WORK_JOURNAL_OPEN_SETTINGS_EVENT = "work-journal:open-settings";

/**
 * Backend → every window: Maestro is quitting; save the Work Journal text
 * still waiting here, then answer with {@link WORK_JOURNAL_QUIT_FLUSHED_EVENT}.
 * See `QUIT_FLUSH_EVENT` in `src-tauri/src/core/work_journal_quit.rs`.
 */
export const WORK_JOURNAL_QUIT_FLUSH_EVENT = "work-journal:quit-flush";
/** Window → backend: this window's saves have finished (payload: its label). */
export const WORK_JOURNAL_QUIT_FLUSHED_EVENT = "work-journal:quit-flushed";

/** Payload of {@link WORK_JOURNAL_QUIT_FLUSHED_EVENT}. */
export interface WorkJournalQuitFlushedPayload {
  /** Label of the window whose saves have finished. */
  label: string | null;
}

/**
 * What a {@link WORK_JOURNAL_CHANGED_EVENT} changed (`ChangeKind` in
 * `src-tauri/src/commands/work_journal.rs`): day pages, the settings, the
 * suggestions, a candidate run (suggestions and settings), or the whole
 * journal (restore or undo).
 */
export type WorkJournalChangeKind = "page" | "settings" | "candidates" | "run" | "replaced";

/** The part of the journal a listener shows and re-reads. */
export type WorkJournalChangeArea = "pages" | "settings" | "candidates";

/** Payload of {@link WORK_JOURNAL_CHANGED_EVENT}. */
export interface WorkJournalChangedPayload {
  /** Label of the window whose command made the change; null for the backend itself. */
  source: string | null;
  /** The whole journal was replaced (restore or undo). */
  replaced: boolean;
  /** What changed; missing (an older payload) means anything may have. */
  kind?: WorkJournalChangeKind;
}

/** The areas each change kind touches. */
const CHANGE_KIND_AREAS: Record<WorkJournalChangeKind, WorkJournalChangeArea[]> = {
  page: ["pages"],
  settings: ["settings"],
  candidates: ["candidates"],
  run: ["candidates", "settings"],
  replaced: ["pages", "settings", "candidates"],
};

/**
 * Whether `change` may have changed `area`. A replaced journal, and a
 * payload without a known kind, count as everything.
 */
export function workJournalChangeTouches(
  change: WorkJournalChangedPayload,
  area: WorkJournalChangeArea,
): boolean {
  if (change.replaced) return true;
  const areas = change.kind ? CHANGE_KIND_AREAS[change.kind] : undefined;
  return areas ? areas.includes(area) : true;
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

/** Close the journal window if it is open (the user turned the journal off). */
export async function closeWorkJournalWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(WORK_JOURNAL_WINDOW_LABEL);
  await existing?.close();
}

/**
 * Calls `onChange` when another window (or the backend) changed the journal;
 * with `area`, only when the change may have touched that part of it.
 * This window's own changes are skipped: it already shows them, and re-reading
 * could put older text over what is being typed.
 */
export async function listenWorkJournalChanged(
  onChange: (payload: WorkJournalChangedPayload) => void,
  area?: WorkJournalChangeArea,
): Promise<UnlistenFn> {
  const own = currentWindowLabel();
  return listen<WorkJournalChangedPayload>(WORK_JOURNAL_CHANGED_EVENT, (event) => {
    const payload = event.payload ?? { source: null, replaced: false };
    if (own !== null && payload.source === own) return;
    if (area && !workJournalChangeTouches(payload, area)) return;
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

/**
 * Both windows: when Maestro quits, the backend asks every window to save
 * the text (and a page title) still waiting for the debounce, or whose save
 * failed, and waits a short while for each answer before closing the
 * windows. The answer is sent even when a save failed, so quitting is never
 * held up longer than needed. Returns the stop function.
 */
export async function answerWorkJournalQuitFlush(): Promise<UnlistenFn> {
  const label = currentWindowLabel();
  return listen(WORK_JOURNAL_QUIT_FLUSH_EVENT, async () => {
    try {
      await flushWorkJournalSaves();
    } catch (err) {
      console.error("Failed to save the Work Journal before quitting:", err);
    }
    const payload: WorkJournalQuitFlushedPayload = { label };
    await emit(WORK_JOURNAL_QUIT_FLUSHED_EVENT, payload).catch((err) =>
      console.error("Failed to tell Maestro the Work Journal is saved:", err),
    );
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
  const stopSettings = await listen(WORK_JOURNAL_OPEN_SETTINGS_EVENT, () =>
    useWorkJournalBackupStore.getState().openSettings(),
  );
  // The pop-out window can change the run settings (the Granola question).
  const stopChanged = await listenWorkJournalChanged(() => {
    void useWorkJournalCandidateRunStore.getState().load();
  }, "settings");
  // This window's own unsaved journal text is saved when Maestro quits.
  const stopQuitFlush = await answerWorkJournalQuitFlush();
  const unsubscribe = useWorkJournalCandidateRunStore.subscribe(send);
  return () => {
    stopRunNow();
    stopRequest();
    stopSettings();
    stopChanged();
    stopQuitFlush();
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

/**
 * Pop-out window side: asks the main window to open Maestro Settings at the
 * Work Journal section, and brings the main window forward to show it.
 */
export async function openWorkJournalSettingsInMainWindow(): Promise<void> {
  await emitTo("main", WORK_JOURNAL_OPEN_SETTINGS_EVENT);
  const main = await WebviewWindow.getByLabel("main");
  if (!main) return;
  await main.unminimize();
  await main.setFocus();
}
