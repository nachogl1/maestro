import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useWorkJournalBackupStore,
  type WorkJournalBackupSettings,
} from "@/stores/useWorkJournalBackupStore";
import { WorkJournalSettingsSection } from "../WorkJournalSettingsSection";

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);

const INITIAL_STATE = useWorkJournalBackupStore.getState();

function journal(settings: WorkJournalBackupSettings) {
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
        throw "The backup folder D:\\Gone does not exist.";
      },
    });

    render(<WorkJournalSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Backup failed: The backup folder D:\\Gone does not exist.",
    );
    expect(screen.getByText(`Last backup: ${shownTime(lastBackupAt)}`)).toBeInTheDocument();
  });

  it("saves a chosen folder through the settings patch and backs up to it", async () => {
    const at = "2026-10-15T09:00:00Z";
    routeInvoke({
      load_work_journal: () => journal({}),
      update_work_journal_settings: () => journal({ backup_folder: "E:\\Backups" }),
      work_journal_backup_now: () => journal({ backup_folder: "E:\\Backups", last_backup_at: at }),
    });
    openMock.mockResolvedValue("E:\\Backups");

    render(<WorkJournalSettingsSection />);
    await screen.findByText(/No backup folder chosen/);
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/ }));

    expect(await screen.findByText(`Last backup: ${shownTime(at)}`)).toBeInTheDocument();
    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(invokeMock).toHaveBeenCalledWith("update_work_journal_settings", {
      settings: { backup_folder: "E:\\Backups" },
    });
    expect(screen.getByText("E:\\Backups")).toBeInTheDocument();
    expect(screen.queryByText(/No backup folder chosen/)).toBeNull();
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

  it("shows an automatic backup failure in the section", async () => {
    routeInvoke({
      load_work_journal: () => journal({ backup_folder: "D:\\Gone" }),
      work_journal_backup_if_due: () => {
        throw "The backup folder D:\\Gone does not exist.";
      },
    });

    render(<WorkJournalSettingsSection />);
    await screen.findByText("D:\\Gone");
    await act(() => useWorkJournalBackupStore.getState().backUpIfDue());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Automatic backup failed: The backup folder D:\\Gone does not exist.",
    );
  });
});
