import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORK_JOURNAL_CHANGED_EVENT,
  WORK_JOURNAL_OPEN_SETTINGS_EVENT,
  WORK_JOURNAL_WINDOW_LABEL,
  type WorkJournalChangedPayload,
} from "@/lib/workJournalWindow";
import {
  useWorkJournalBackupStore,
  type WorkJournalBackupSettings,
} from "@/stores/useWorkJournalBackupStore";
import { BACKUP_REMINDER_TEXT, WorkJournalBackupReminder } from "../WorkJournalBackupReminder";

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: vi.fn(async () => () => {}),
}));

const mainWindow = vi.hoisted(() => ({ unminimize: vi.fn(), setFocus: vi.fn() }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => ({ label: "main" })),
  WebviewWindow: { getByLabel: vi.fn(async () => mainWindow) },
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const INITIAL_STATE = useWorkJournalBackupStore.getState();

/** The journal settings `load_work_journal` returns. */
let settings: WorkJournalBackupSettings;

/** Delivers a `work-journal:changed` event as the backend would. */
let changed: (payload: WorkJournalChangedPayload) => void;

describe("WorkJournalBackupReminder", () => {
  beforeEach(() => {
    settings = {};
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "load_work_journal") {
        return { layout_version: 1, pages: {}, deleted_dates: [], settings };
      }
      throw new Error(`unexpected command ${cmd}`);
    });
    changed = () => {};
    listenMock.mockImplementation(async (event, handler) => {
      if (event === WORK_JOURNAL_CHANGED_EVENT) {
        changed = (payload) => (handler as (e: { payload: unknown }) => void)({ payload });
      }
      return () => {};
    });
    useWorkJournalBackupStore.setState(INITIAL_STATE, true);
  });

  it("shows the reminder while no backup folder is chosen", async () => {
    render(<WorkJournalBackupReminder />);

    expect(await screen.findByText(BACKUP_REMINDER_TEXT)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("load_work_journal");
  });

  it("stays hidden when a backup folder is set", async () => {
    settings = { backup_folder: "D:\\Backups" };
    render(<WorkJournalBackupReminder />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(useWorkJournalBackupStore.getState().backupFolder).toBe("D:\\Backups");
    expect(screen.queryByText(BACKUP_REMINDER_TEXT)).not.toBeInTheDocument();
  });

  it("stays hidden when the journal settings cannot be read", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("disk gone");
    });
    render(<WorkJournalBackupReminder />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(useWorkJournalBackupStore.getState().loadError).toBe("disk gone");
    expect(screen.queryByText(BACKUP_REMINDER_TEXT)).not.toBeInTheDocument();
  });

  it("hides for this session when dismissed, also after a remount", async () => {
    const { unmount } = render(<WorkJournalBackupReminder />);
    await screen.findByText(BACKUP_REMINDER_TEXT);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss backup reminder" }));
    expect(screen.queryByText(BACKUP_REMINDER_TEXT)).not.toBeInTheDocument();

    unmount();
    render(<WorkJournalBackupReminder />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(BACKUP_REMINDER_TEXT)).not.toBeInTheDocument();
  });

  it("opens Settings at the Work Journal section in the main window", async () => {
    render(<WorkJournalBackupReminder />);
    await screen.findByText(BACKUP_REMINDER_TEXT);

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(useWorkJournalBackupStore.getState().settingsRequested).toBe(true);
    expect(emitTo).not.toHaveBeenCalled();
  });

  it("asks the main window to open Settings from the pop-out window, and focuses it", async () => {
    vi.mocked(emitTo).mockClear();
    render(<WorkJournalBackupReminder inWindow />);
    await screen.findByText(BACKUP_REMINDER_TEXT);

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    await waitFor(() => expect(mainWindow.setFocus).toHaveBeenCalled());
    expect(emitTo).toHaveBeenCalledWith("main", WORK_JOURNAL_OPEN_SETTINGS_EVENT);
    expect(useWorkJournalBackupStore.getState().settingsRequested).toBe(false);
  });

  it("re-reads on a change only while no folder is set, or after a whole-journal replace", async () => {
    settings = { backup_folder: "D:\\Backups" };
    render(<WorkJournalBackupReminder />);
    await act(async () => {
      await Promise.resolve();
    });
    const reads = (): number =>
      invokeMock.mock.calls.filter(([cmd]) => cmd === "load_work_journal").length;
    expect(reads()).toBe(1);

    await act(async () => changed({ source: WORK_JOURNAL_WINDOW_LABEL, replaced: false }));
    expect(reads()).toBe(1);

    await act(async () => changed({ source: WORK_JOURNAL_WINDOW_LABEL, replaced: true }));
    expect(reads()).toBe(2);
  });

  it("goes away once a folder is chosen here or in the other window", async () => {
    render(<WorkJournalBackupReminder />);
    await screen.findByText(BACKUP_REMINDER_TEXT);

    // Chosen in the other window: the backend's change event makes it re-read.
    settings = { backup_folder: "D:\\Backups" };
    await act(async () => changed({ source: WORK_JOURNAL_WINDOW_LABEL, replaced: false }));
    expect(screen.queryByText(BACKUP_REMINDER_TEXT)).not.toBeInTheDocument();

    // Cleared again, then chosen in this window's Settings (the store update).
    act(() => useWorkJournalBackupStore.setState({ backupFolder: null }));
    expect(screen.getByText(BACKUP_REMINDER_TEXT)).toBeInTheDocument();
    act(() => useWorkJournalBackupStore.setState({ backupFolder: "E:\\Sync" }));
    expect(screen.queryByText(BACKUP_REMINDER_TEXT)).not.toBeInTheDocument();
  });
});
