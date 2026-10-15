import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import {
  followWorkJournalRunState,
  isWorkJournalWindowView,
  listenWorkJournalChanged,
  openWorkJournalSettingsInMainWindow,
  openWorkJournalWindow,
  serveWorkJournalWindow,
  WORK_JOURNAL_CHANGED_EVENT,
  WORK_JOURNAL_OPEN_SETTINGS_EVENT,
  WORK_JOURNAL_RUN_NOW_EVENT,
  WORK_JOURNAL_RUN_STATE_EVENT,
  WORK_JOURNAL_RUN_STATE_REQUEST_EVENT,
  WORK_JOURNAL_VIEW,
  WORK_JOURNAL_WINDOW_LABEL,
} from "../workJournalWindow";

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => {
  const WebviewWindow = vi.fn(function (this: { once: unknown }) {
    this.once = vi.fn();
  }) as unknown as { getByLabel: unknown };
  WebviewWindow.getByLabel = vi.fn();
  return { WebviewWindow, getCurrentWebviewWindow: vi.fn(() => ({ label: "main" })) };
});

const getByLabel = WebviewWindow.getByLabel as unknown as ReturnType<typeof vi.fn>;
const listenMock = vi.mocked(listen);
const INITIAL_RUN_STATE = useWorkJournalCandidateRunStore.getState();

type Handler = (event: { payload: unknown }) => void;

/** The handlers registered through `listen`, by event name. */
let handlers: Record<string, Handler>;

beforeEach(() => {
  vi.clearAllMocks();
  handlers = {};
  listenMock.mockImplementation(async (event, handler) => {
    handlers[event] = handler as Handler;
    return () => {};
  });
});

afterEach(() => {
  useWorkJournalCandidateRunStore.setState(INITIAL_RUN_STATE, true);
});

describe("isWorkJournalWindowView", () => {
  it("is true only for the journal window's URL", () => {
    expect(isWorkJournalWindowView(`?view=${WORK_JOURNAL_VIEW}`)).toBe(true);
    expect(isWorkJournalWindowView("")).toBe(false);
    expect(isWorkJournalWindowView("?view=issue-map")).toBe(false);
  });
});

describe("openWorkJournalWindow", () => {
  it("creates a separate window whose URL renders the journal", async () => {
    getByLabel.mockResolvedValue(null);
    await openWorkJournalWindow();

    expect(WebviewWindow).toHaveBeenCalledTimes(1);
    const [label, options] = vi.mocked(WebviewWindow).mock.calls[0];
    expect(label).toBe(WORK_JOURNAL_WINDOW_LABEL);
    const query = (options?.url ?? "").split("?")[1];
    expect(isWorkJournalWindowView(`?${query}`)).toBe(true);
  });

  it("brings an already open window forward instead of opening another", async () => {
    const existing = {
      unminimize: vi.fn(() => Promise.resolve()),
      setFocus: vi.fn(() => Promise.resolve()),
    };
    getByLabel.mockResolvedValue(existing);
    await openWorkJournalWindow();

    expect(WebviewWindow).not.toHaveBeenCalled();
    expect(existing.unminimize).toHaveBeenCalled();
    expect(existing.setFocus).toHaveBeenCalled();
  });
});

describe("listenWorkJournalChanged", () => {
  it("skips this window's own changes and passes on the others", async () => {
    const onChange = vi.fn();
    await listenWorkJournalChanged(onChange);
    const changed = handlers[WORK_JOURNAL_CHANGED_EVENT];

    changed({ payload: { source: "main", replaced: false } });
    expect(onChange).not.toHaveBeenCalled();

    changed({ payload: { source: WORK_JOURNAL_WINDOW_LABEL, replaced: true } });
    changed({ payload: { source: null, replaced: false } });
    expect(onChange.mock.calls).toEqual([
      [{ source: WORK_JOURNAL_WINDOW_LABEL, replaced: true }],
      [{ source: null, replaced: false }],
    ]);
  });
});

describe("candidate runs from the pop-out window", () => {
  it("the main window runs a pop-out 'run now' and sends its run state on request", async () => {
    const runNow = vi.fn();
    const stop = await serveWorkJournalWindow(runNow);

    handlers[WORK_JOURNAL_RUN_NOW_EVENT]({ payload: null });
    expect(runNow).toHaveBeenCalledTimes(1);

    handlers[WORK_JOURNAL_RUN_STATE_REQUEST_EVENT]({ payload: null });
    const [target, event, snapshot] = vi.mocked(emitTo).mock.calls[0];
    expect(target).toBe(WORK_JOURNAL_WINDOW_LABEL);
    expect(event).toBe(WORK_JOURNAL_RUN_STATE_EVENT);
    expect(snapshot).toMatchObject({ running: false, projects: [] });
    expect(Object.values(snapshot as object).some((v) => typeof v === "function")).toBe(false);

    // Every later change of the run state is sent too.
    vi.mocked(emitTo).mockClear();
    useWorkJournalCandidateRunStore.setState({ running: true });
    expect(emitTo).toHaveBeenCalledWith(
      WORK_JOURNAL_WINDOW_LABEL,
      WORK_JOURNAL_RUN_STATE_EVENT,
      expect.objectContaining({ running: true }),
    );
    stop();
  });

  it("the pop-out window follows the main window's run state and sends 'run now' there", async () => {
    await followWorkJournalRunState();
    expect(emitTo).toHaveBeenCalledWith("main", WORK_JOURNAL_RUN_STATE_REQUEST_EVENT);

    handlers[WORK_JOURNAL_RUN_STATE_EVENT]({
      payload: { running: true, projects: ["C:/git/p"], nextRunAt: 42 },
    });
    const state = useWorkJournalCandidateRunStore.getState();
    expect(state.running).toBe(true);
    expect(state.projects).toEqual(["C:/git/p"]);

    vi.mocked(emitTo).mockClear();
    await state.runNow(state.projects);
    expect(emitTo).toHaveBeenCalledWith("main", WORK_JOURNAL_RUN_NOW_EVENT);
  });
});

describe("Settings from the pop-out window", () => {
  afterEach(() => {
    useWorkJournalBackupStore.setState({ settingsRequested: false });
  });

  it("the pop-out asks the main window and focuses it; the main window opens Settings", async () => {
    const main = { unminimize: vi.fn(), setFocus: vi.fn() };
    getByLabel.mockResolvedValue(main);
    await openWorkJournalSettingsInMainWindow();
    expect(emitTo).toHaveBeenCalledWith("main", WORK_JOURNAL_OPEN_SETTINGS_EVENT);
    expect(getByLabel).toHaveBeenCalledWith("main");
    expect(main.setFocus).toHaveBeenCalled();

    const stop = await serveWorkJournalWindow(vi.fn());
    handlers[WORK_JOURNAL_OPEN_SETTINGS_EVENT]({ payload: null });
    expect(useWorkJournalBackupStore.getState().settingsRequested).toBe(true);
    stop();
  });
});
