import { invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_BACKUP_SKIPPED_TITLE,
  AUTO_BACKUP_WARNING_TITLE,
  useWorkJournalBackupStore,
  type WorkJournalBackupFile,
  type WorkJournalBackupSettings,
} from "@/stores/useWorkJournalBackupStore";
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
    const handler = handlers[cmd];
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
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(`Last backup: ${shownTime(at)}`)).toBeInTheDocument();
  });

  it("changes nothing when the folder picker is cancelled", async () => {
    routeInvoke({ load_work_journal: () => journal({}) });
    openMock.mockResolvedValue(null);

    render(<WorkJournalSettingsSection />);
    await screen.findByText(/No backup folder chosen/);
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));

    await waitFor(() => expect(openMock).toHaveBeenCalled());
    expect(invokeMock).toHaveBeenCalledTimes(1);
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
