import { invoke } from "@tauri-apps/api/core";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_BACKUP_SKIPPED_TITLE,
  AUTO_BACKUP_WARNING_TITLE,
  type AutoBackupAfterRestore,
  RESTORE_NOTICES,
  UNDO_RESTORE_NOTICES,
  useWorkJournalBackupStore,
  type WorkJournalBackupFile,
  type WorkJournalBackupSettings,
} from "@/stores/useWorkJournalBackupStore";
import { useWorkJournalStore, type WorkJournalPage } from "@/stores/useWorkJournalStore";
import { WorkJournalSettingsSection } from "../WorkJournalSettingsSection";

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);
const messageMock = vi.mocked(message);

const INITIAL_STATE = useWorkJournalBackupStore.getState();

function journal(settings: WorkJournalBackupSettings): WorkJournalBackupFile {
  return { layout_version: 1, pages: {}, deleted_dates: [], settings };
}

/** Routes `invoke` by command name; each handler returns the reply or throws. */
function routeInvoke(handlers: Record<string, (args?: unknown) => unknown>): void {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const handler =
      handlers[cmd] ??
      (cmd === "work_journal_restore_state" ? () => ({ canUndo: false }) : undefined);
    if (!handler) throw new Error(`unexpected command ${cmd}`);
    return handler(args);
  });
}

function shownTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

describe("WorkJournalSettingsSection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    messageMock.mockReset();
    useWorkJournalBackupStore.setState(INITIAL_STATE, true);
  });

  it("shows a reminder and disables Back up now while no folder is chosen", async () => {
    routeInvoke({ load_work_journal: () => journal({}) });

    render(<WorkJournalSettingsSection />);

    expect(await screen.findByText(/No backup folder chosen/)).toBeInTheDocument();
    expect(screen.getByText("Never backed up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();
    expect(invokeMock).not.toHaveBeenCalledWith("work_journal_backup_now");
  });

  it("shows the folder and updates the last backup time on Back up now", async () => {
    const before = "2026-10-14T08:00:00Z";
    const after = "2026-10-15T12:34:00Z";
    routeInvoke({
      load_work_journal: () =>
        journal({ backup_folder: "D:\\OneDrive\\Journal", last_backup_at: before }),
      work_journal_backup_now: () =>
        journal({ backup_folder: "D:\\OneDrive\\Journal", last_backup_at: after }),
    });

    render(<WorkJournalSettingsSection />);

    expect(await screen.findByText("D:\\OneDrive\\Journal")).toBeInTheDocument();
    expect(screen.getByText(`Last backup: ${shownTime(before)}`)).toBeInTheDocument();
    expect(screen.queryByText(/No backup folder chosen/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));

    expect(await screen.findByText(`Last backup: ${shownTime(after)}`)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("work_journal_backup_now");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a visible error when the backup fails", async () => {
    const lastBackupAt = "2026-10-14T08:00:00Z";
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\Gone", last_backup_at: lastBackupAt }),
      work_journal_backup_now: () => {
        throw "Backup failed: the backup folder D:\\Gone does not exist.";
      },
    });

    render(<WorkJournalSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Backup failed: the backup folder D:\\Gone does not exist.",
    );
    expect(screen.getByText(`Last backup: ${shownTime(lastBackupAt)}`)).toBeInTheDocument();
    expect(messageMock).not.toHaveBeenCalled();
  });

  it("shows an automatic skip inline and as a one-time warning", async () => {
    const skipped =
      "Automatic backup skipped: this folder already holds a backup that this Maestro has " +
      "never written. Press Back up now to replace it, or choose another folder.";
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      work_journal_backup_if_due: () => ({ status: "skipped", message: skipped }),
      work_journal_backup_now: () =>
        journal({ backup_folder: "D:\\OneDrive", last_backup_at: "2026-10-15T09:00:00Z" }),
    });
    const backUpIfDue = useWorkJournalBackupStore.getState().backUpIfDue;

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    await act(() => backUpIfDue());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(skipped);
    expect(messageMock).toHaveBeenCalledWith(skipped, {
      title: AUTO_BACKUP_SKIPPED_TITLE,
      kind: "warning",
    });
    await act(() => backUpIfDue());
    expect(messageMock).toHaveBeenCalledTimes(1);

    // A real failure after a skip still warns once, with its own title.
    invokeMock.mockImplementationOnce(async () => {
      throw "Backup failed: the backup folder D:\\OneDrive does not exist.";
    });
    await act(() => backUpIfDue());
    expect(messageMock).toHaveBeenCalledTimes(2);
    expect(messageMock).toHaveBeenLastCalledWith(
      "Backup failed: the backup folder D:\\OneDrive does not exist.",
      { title: AUTO_BACKUP_WARNING_TITLE, kind: "warning" },
    );

    // "Back up now" is the override: it writes and clears the skip.
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    expect(
      await screen.findByText(`Last backup: ${shownTime("2026-10-15T09:00:00Z")}`),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears an earlier load error once a load succeeds", async () => {
    let fail = true;
    routeInvoke({
      load_work_journal: () => {
        if (fail) throw "Failed to read the work journal: busy";
        return journal({ backup_folder: "D:\\OneDrive" });
      },
    });

    const { unmount } = render(<WorkJournalSettingsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("busy");
    unmount();

    fail = false;
    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves a chosen folder, clears the last backup time and runs the automatic backup", async () => {
    const at = "2026-10-15T09:00:00Z";
    routeInvoke({
      load_work_journal: () =>
        journal({ backup_folder: "D:\\Old", last_backup_at: "2026-10-14T08:00:00Z" }),
      update_work_journal_settings: () => journal({ backup_folder: "E:\\Backups" }),
      work_journal_backup_if_due: () => ({
        status: "written",
        journal: journal({ backup_folder: "E:\\Backups", last_backup_at: at }),
      }),
    });
    openMock.mockResolvedValue("E:\\Backups");

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\Old");
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));

    expect(await screen.findByText(`Last backup: ${shownTime(at)}`)).toBeInTheDocument();
    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(invokeMock).toHaveBeenCalledWith("update_work_journal_settings", {
      settings: { backup_folder: "E:\\Backups", last_backup_at: null },
    });
    expect(invokeMock).toHaveBeenCalledWith("work_journal_backup_if_due");
    expect(invokeMock).not.toHaveBeenCalledWith("work_journal_backup_now");
    expect(screen.getByText("E:\\Backups")).toBeInTheDocument();
  });

  it("shows Never backed up after a folder change the guard skipped", async () => {
    routeInvoke({
      load_work_journal: () =>
        journal({ backup_folder: "D:\\Old", last_backup_at: "2026-10-14T08:00:00Z" }),
      update_work_journal_settings: () => journal({ backup_folder: "E:\\Shared" }),
      work_journal_backup_if_due: () => ({
        status: "skipped",
        message: "Automatic backup skipped: this folder already holds a backup.",
      }),
    });
    openMock.mockResolvedValue("E:\\Shared");

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\Old");
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Automatic backup skipped");
    expect(screen.getByText("E:\\Shared")).toBeInTheDocument();
    expect(screen.getByText("Never backed up")).toBeInTheDocument();
  });

  it("does nothing when the current folder is chosen again", async () => {
    const at = "2026-10-14T08:00:00Z";
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive", last_backup_at: at }),
    });
    openMock.mockResolvedValue("D:\\OneDrive");

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));

    await waitFor(() => expect(openMock).toHaveBeenCalled());
    await act(async () => {});
    expect(callsExceptRestoreState()).toHaveLength(1);
    expect(screen.getByText(`Last backup: ${shownTime(at)}`)).toBeInTheDocument();
  });

  it("changes nothing when the folder picker is cancelled", async () => {
    routeInvoke({ load_work_journal: () => journal({}) });
    openMock.mockResolvedValue(null);

    render(<WorkJournalSettingsSection />);
    await screen.findByText(/No backup folder chosen/);
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));

    await waitFor(() => expect(openMock).toHaveBeenCalled());
    expect(callsExceptRestoreState()).toHaveLength(1);
  });

  it("shows an automatic backup failure in the section and warns once per failure run", async () => {
    const failure = "Backup failed: the backup folder D:\\Gone does not exist.";
    let ifDueFails = true;
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\Gone" }),
      work_journal_backup_if_due: () => {
        if (ifDueFails) throw failure;
        return {
          status: "written",
          journal: journal({ backup_folder: "D:\\Gone", last_backup_at: "2026-10-15T09:00:00Z" }),
        };
      },
    });
    const backUpIfDue = useWorkJournalBackupStore.getState().backUpIfDue;

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\Gone");
    await act(() => backUpIfDue());

    expect(await screen.findByRole("alert")).toHaveTextContent(`Automatic backup: ${failure}`);
    expect(messageMock).toHaveBeenCalledTimes(1);
    expect(messageMock).toHaveBeenCalledWith(failure, {
      title: AUTO_BACKUP_WARNING_TITLE,
      kind: "warning",
    });

    // The hourly retry fails again: no second warning.
    await act(() => backUpIfDue());
    expect(messageMock).toHaveBeenCalledTimes(1);

    // A success ends the run; the next failure warns again.
    ifDueFails = false;
    await act(() => backUpIfDue());
    expect(screen.queryByRole("alert")).toBeNull();
    ifDueFails = true;
    await act(() => backUpIfDue());
    expect(messageMock).toHaveBeenCalledTimes(2);
  });

  it("warns again after the folder changes", async () => {
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\Gone" }),
      work_journal_backup_if_due: () => {
        throw "Backup failed: the backup folder does not exist.";
      },
      update_work_journal_settings: () => journal({ backup_folder: "E:\\Other" }),
    });
    openMock.mockResolvedValue("E:\\Other");
    const backUpIfDue = useWorkJournalBackupStore.getState().backUpIfDue;

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\Gone");
    await act(() => backUpIfDue());
    await act(() => backUpIfDue());
    expect(messageMock).toHaveBeenCalledTimes(1);

    // The folder change resets the run; its own automatic backup fails and warns.
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
    await screen.findByText("E:\\Other");
    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(2));

    await act(() => backUpIfDue());
    expect(messageMock).toHaveBeenCalledTimes(2);
  });
});

/** Every `invoke` call except the restore-state read the section makes on mount. */
function callsExceptRestoreState(): unknown[] {
  return invokeMock.mock.calls.filter(([cmd]) => cmd !== "work_journal_restore_state");
}

describe("WorkJournalSettingsSection restore", () => {
  const askMock = vi.mocked(ask);
  const restoredPage: WorkJournalPage = {
    date: "2026-09-01",
    title: "Tue 1 Sep 2026",
    body: { type: "doc", content: [{ type: "paragraph" }] },
    origin: "manual",
  };
  const PAGE_STORE_INITIAL = useWorkJournalStore.getState();

  /** A restore or undo reply: the saved journal with the given pages. */
  function reply(canUndo: boolean, pages: Record<string, WorkJournalPage>) {
    return {
      journal: {
        ...journal({ backup_folder: "D:\\OneDrive" }),
        pages,
        last_auto_created_date: null,
      },
      canUndo,
      autoBackup: "paused",
    };
  }

  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    messageMock.mockReset();
    askMock.mockReset();
    useWorkJournalBackupStore.setState(INITIAL_STATE, true);
    useWorkJournalStore.setState(PAGE_STORE_INITIAL, true);
  });

  it("enables Undo restore only while a safety copy exists", async () => {
    let canUndo = false;
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      work_journal_restore_state: () => ({ canUndo }),
    });

    const { unmount } = render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("work_journal_restore_state"));
    expect(screen.getByRole("button", { name: /Undo restore/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Restore from backup/ })).toBeEnabled();
    unmount();

    canUndo = true;
    render(<WorkJournalSettingsSection />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Undo restore/ })).toBeEnabled());
  });

  it("disables Restore from backup while no folder is chosen", async () => {
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_restore_state: () => ({ canUndo: false }),
    });

    render(<WorkJournalSettingsSection />);
    await screen.findByText(/No backup folder chosen/);

    expect(screen.getByRole("button", { name: /Restore from backup/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Browse/ })).toBeEnabled();
  });

  it("restores nothing when the confirm is cancelled", async () => {
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      work_journal_restore_state: () => ({ canUndo: false }),
    });
    askMock.mockResolvedValue(false);

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));

    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(askMock).toHaveBeenCalledWith(
      expect.stringContaining("with the backup D:\\OneDrive\\work-journal.json?"),
      { title: "Restore Work Journal", kind: "warning" },
    );
    expect(String(askMock.mock.calls[0][0])).toContain("Undo restore puts it back");
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalledWith("restore_work_journal", expect.anything());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("restores the folder's backup, shows the notice and reloads the pages", async () => {
    routeInvoke({
      load_work_journal: () =>
        journal({ backup_folder: "D:\\OneDrive", last_backup_at: "2026-10-14T08:00:00Z" }),
      work_journal_restore_state: () => ({ canUndo: false }),
      restore_work_journal: () => reply(true, { "2026-09-01": restoredPage }),
    });
    askMock.mockResolvedValue(true);
    useWorkJournalStore.setState({ pages: {} });
    const revisionBefore = useWorkJournalStore.getState().revision;

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));

    expect(await screen.findByRole("status")).toHaveTextContent(RESTORE_NOTICES.paused);
    expect(RESTORE_NOTICES.paused).toBe(
      "Restored. Automatic backups stay paused until you press Back up now.",
    );
    expect(invokeMock).toHaveBeenCalledWith("restore_work_journal", { file: null });
    expect(useWorkJournalStore.getState().pages).toEqual({ "2026-09-01": restoredPage });
    expect(useWorkJournalStore.getState().revision).toBe(revisionBefore + 1);
    expect(screen.getByText("Never backed up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Undo restore/ })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restores a browsed backup file", async () => {
    const chosen = "C:\\Users\\me\\Downloads\\work-journal.json";
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_restore_state: () => ({ canUndo: false }),
      restore_work_journal: () => reply(true, { "2026-09-01": restoredPage }),
    });
    openMock.mockResolvedValue(chosen);
    askMock.mockResolvedValue(true);

    render(<WorkJournalSettingsSection />);
    await screen.findByText(/No backup folder chosen/);
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));

    expect(await screen.findByRole("status")).toHaveTextContent(RESTORE_NOTICES.paused);
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        filters: [{ name: "Work Journal backup", extensions: ["json"] }],
      }),
    );
    expect(askMock).toHaveBeenCalledWith(
      expect.stringContaining(`with the backup ${chosen}?`),
      expect.objectContaining({ kind: "warning" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("restore_work_journal", { file: chosen });
  });

  it("asks nothing and restores nothing when the file picker is cancelled", async () => {
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_restore_state: () => ({ canUndo: false }),
    });
    openMock.mockResolvedValue(null);

    render(<WorkJournalSettingsSection />);
    await screen.findByText(/No backup folder chosen/);
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));

    await waitFor(() => expect(openMock).toHaveBeenCalled());
    await act(async () => {});
    expect(askMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("restore_work_journal", expect.anything());
  });

  it("shows a refused restore on the error line and keeps the pages", async () => {
    const refused =
      "The work journal was saved by a newer Maestro (layout version 2, this version reads up " +
      "to 1). Update Maestro first.";
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      work_journal_restore_state: () => ({ canUndo: false }),
      restore_work_journal: () => {
        throw refused;
      },
    });
    askMock.mockResolvedValue(true);
    useWorkJournalStore.setState({ pages: { "2026-10-15": restoredPage } });
    const revisionBefore = useWorkJournalStore.getState().revision;

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(`Restore failed: ${refused}`);
    expect(screen.queryByRole("status")).toBeNull();
    expect(useWorkJournalStore.getState().pages).toEqual({ "2026-10-15": restoredPage });
    expect(useWorkJournalStore.getState().revision).toBe(revisionBefore);
    expect(screen.getByRole("button", { name: /Undo restore/ })).toBeDisabled();
  });

  it("undoes a restore after confirming and disables Undo afterwards", async () => {
    const before: WorkJournalPage = { ...restoredPage, date: "2026-10-15", title: "Thu 15 Oct" };
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      work_journal_restore_state: () => ({ canUndo: true }),
      undo_work_journal_restore: () => reply(false, { "2026-10-15": before }),
    });
    askMock.mockResolvedValue(true);

    render(<WorkJournalSettingsSection />);
    const undo = await screen.findByRole("button", { name: /Undo restore/ });
    await waitFor(() => expect(undo).toBeEnabled());
    fireEvent.click(undo);

    expect(await screen.findByRole("status")).toHaveTextContent(UNDO_RESTORE_NOTICES.paused);
    expect(UNDO_RESTORE_NOTICES.paused).toContain(
      "Automatic backups stay paused until you press Back up now.",
    );
    expect(askMock).toHaveBeenCalledWith(
      expect.stringContaining("before the restore"),
      expect.objectContaining({ kind: "warning" }),
    );
    expect(String(askMock.mock.calls[0][0])).toContain("work-journal.before-undo.json");
    expect(invokeMock).toHaveBeenCalledWith("undo_work_journal_restore");
    expect(useWorkJournalStore.getState().pages).toEqual({ "2026-10-15": before });
    expect(screen.getByRole("button", { name: /Undo restore/ })).toBeDisabled();
  });

  it("does not undo when the undo confirm is cancelled", async () => {
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      work_journal_restore_state: () => ({ canUndo: true }),
    });
    askMock.mockResolvedValue(false);

    render(<WorkJournalSettingsSection />);
    const undo = await screen.findByRole("button", { name: /Undo restore/ });
    await waitFor(() => expect(undo).toBeEnabled());
    fireEvent.click(undo);

    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalledWith("undo_work_journal_restore");
  });

  it("clears the restore notice after Back up now", async () => {
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      work_journal_restore_state: () => ({ canUndo: false }),
      restore_work_journal: () => reply(true, {}),
      work_journal_backup_now: () =>
        journal({ backup_folder: "D:\\OneDrive", last_backup_at: "2026-10-15T12:00:00Z" }),
    });
    askMock.mockResolvedValue(true);

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
    await screen.findByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});

describe("WorkJournalSettingsSection restore notices and the backup pause", () => {
  const askMock = vi.mocked(ask);
  const PAGE_STORE_INITIAL = useWorkJournalStore.getState();
  const skipped =
    "Automatic backup skipped: this folder already holds a backup that this Maestro has " +
    "never written. Press Back up now to replace it, or choose another folder.";

  function restoreReply(autoBackup: AutoBackupAfterRestore, folder?: string) {
    return {
      journal: {
        ...journal(folder ? { backup_folder: folder } : {}),
        last_auto_created_date: null,
      },
      canUndo: true,
      autoBackup,
    };
  }

  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    messageMock.mockReset();
    askMock.mockReset();
    askMock.mockResolvedValue(true);
    useWorkJournalBackupStore.setState(INITIAL_STATE, true);
    useWorkJournalStore.setState(PAGE_STORE_INITIAL, true);
  });

  it.each([
    [
      "paused",
      "D:\\OneDrive",
      "Restored. Automatic backups stay paused until you press Back up now.",
    ],
    ["runs", "D:\\OneDrive", "Restored."],
    ["no_folder", undefined, "Restored. Choose a backup folder to turn on automatic backups."],
  ] as const)("words the restore notice for %s", async (autoBackup, folder, text) => {
    routeInvoke({
      load_work_journal: () => journal({}),
      restore_work_journal: () => restoreReply(autoBackup, folder),
    });
    openMock.mockResolvedValue("C:\\backup.json");

    render(<WorkJournalSettingsSection />);
    await screen.findByText(/No backup folder chosen/);
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));

    expect(await screen.findByRole("status")).toHaveTextContent(text);
    expect(screen.getByRole("status").textContent).toBe(text);
    expect(RESTORE_NOTICES[autoBackup]).toBe(text);
  });

  it("words the undo notice by what the automatic backup does next", () => {
    expect(UNDO_RESTORE_NOTICES.paused).toBe(
      "Restore undone: your journal from before the restore is back. Automatic backups stay " +
        "paused until you press Back up now.",
    );
    expect(UNDO_RESTORE_NOTICES.runs).toBe(
      "Restore undone: your journal from before the restore is back.",
    );
    expect(UNDO_RESTORE_NOTICES.no_folder).toBe(
      "Restore undone: your journal from before the restore is back. Choose a backup folder " +
        "to turn on automatic backups.",
    );
  });

  it("hides the backup-skipped warning and red line after a restore until Back up now", async () => {
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      restore_work_journal: () => restoreReply("paused", "D:\\OneDrive"),
      work_journal_backup_if_due: () => ({ status: "skipped", message: skipped }),
      work_journal_backup_now: () =>
        journal({ backup_folder: "D:\\OneDrive", last_backup_at: "2026-10-15T12:00:00Z" }),
    });
    const backUpIfDue = useWorkJournalBackupStore.getState().backUpIfDue;

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
    await screen.findByRole("status");

    await act(() => backUpIfDue());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(messageMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(RESTORE_NOTICES.paused);

    // "Back up now" ends the pause; a later skip warns again.
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    await act(() => backUpIfDue());
    expect(await screen.findByRole("alert")).toHaveTextContent(skipped);
    expect(messageMock).toHaveBeenCalledTimes(1);
  });

  it("brings the backup-skipped warning back after a folder change", async () => {
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      restore_work_journal: () => restoreReply("paused", "D:\\OneDrive"),
      update_work_journal_settings: () => journal({ backup_folder: "E:\\Shared" }),
      work_journal_backup_if_due: () => ({ status: "skipped", message: skipped }),
    });
    openMock.mockResolvedValue("E:\\Shared");
    const backUpIfDue = useWorkJournalBackupStore.getState().backUpIfDue;

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
    await screen.findByRole("status");
    await act(() => backUpIfDue());
    expect(messageMock).not.toHaveBeenCalled();

    // The folder change runs its own automatic backup, which the guard skips.
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(skipped);
    await waitFor(() => expect(messageMock).toHaveBeenCalledTimes(1));
  });

  it("reads Undo again after a failed restore", async () => {
    let canUndo = false;
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      work_journal_restore_state: () => ({ canUndo }),
      restore_work_journal: () => {
        // Failed at the last step: the safety copy was already written.
        canUndo = true;
        throw "Failed to write the work journal";
      },
    });

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    expect(screen.getByRole("button", { name: /Undo restore/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Restore failed:");
    await waitFor(() => expect(screen.getByRole("button", { name: /Undo restore/ })).toBeEnabled());
    expect(useWorkJournalStore.getState().replacing).toBe(false);
  });
});

describe("WorkJournalSettingsSection failed restore after a paused restore", () => {
  const askMock = vi.mocked(ask);
  const PAGE_STORE_INITIAL = useWorkJournalStore.getState();

  beforeEach(() => {
    invokeMock.mockReset();
    messageMock.mockReset();
    askMock.mockReset();
    askMock.mockResolvedValue(true);
    useWorkJournalBackupStore.setState(INITIAL_STATE, true);
    useWorkJournalStore.setState(PAGE_STORE_INITIAL, true);
  });

  it("keeps the paused notice when a later restore fails", async () => {
    let fail = false;
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\OneDrive" }),
      restore_work_journal: () => {
        if (fail) throw "There is no backup file at D:\\OneDrive\\work-journal.json.";
        return {
          journal: { ...journal({ backup_folder: "D:\\OneDrive" }), last_auto_created_date: null },
          canUndo: true,
          autoBackup: "paused",
        };
      },
      work_journal_backup_if_due: () => ({
        status: "skipped",
        message: "Automatic backup skipped",
      }),
    });

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\OneDrive");
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(RESTORE_NOTICES.paused);

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Restore failed:");
    expect(screen.getByRole("status")).toHaveTextContent(RESTORE_NOTICES.paused);

    // Still paused and still explained: the skip adds no warning.
    await act(() => useWorkJournalBackupStore.getState().backUpIfDue());
    expect(messageMock).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(RESTORE_NOTICES.paused);
  });
});
