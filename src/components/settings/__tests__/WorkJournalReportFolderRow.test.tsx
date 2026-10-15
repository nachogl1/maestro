import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import { useWorkJournalReportStore } from "@/stores/useWorkJournalReportStore";
import { WorkJournalSettingsSection } from "../WorkJournalSettingsSection";

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);

const INITIAL_BACKUP_STATE = useWorkJournalBackupStore.getState();
const INITIAL_REPORT_STATE = useWorkJournalReportStore.getState();

/** Routes the commands the settings section sends on mount and on a folder change. */
function routeInvoke(settings: Record<string, unknown>): void {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "load_work_journal") return { settings };
    if (cmd === "work_journal_restore_state") return { canUndo: false };
    if (cmd === "update_work_journal_settings") {
      return { settings: { ...settings, ...(args as { settings: object }).settings } };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

describe("WorkJournalReportFolderRow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    useWorkJournalBackupStore.setState(INITIAL_BACKUP_STATE, true);
    useWorkJournalReportStore.setState(INITIAL_REPORT_STATE, true);
  });

  it("shows None until a folder is chosen, then saves only the report folder", async () => {
    routeInvoke({ backup_folder: "D:\\Backup" });
    openMock.mockResolvedValue("D:\\Reports");

    render(<WorkJournalSettingsSection />);
    expect(await screen.findByText("D:\\Backup")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose report folder" }));

    expect(await screen.findByText("D:\\Reports")).toBeInTheDocument();
    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(invokeMock).toHaveBeenCalledWith("update_work_journal_settings", {
      settings: { report_folder: "D:\\Reports" },
    });
    // The backup folder is left alone.
    expect(screen.getByText("D:\\Backup")).toBeInTheDocument();
  });

  it("shows the saved folder from the section's settings load", async () => {
    routeInvoke({ report_folder: "E:\\OneDrive\\Reports" });

    render(<WorkJournalSettingsSection />);

    expect(await screen.findByText("E:\\OneDrive\\Reports")).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "load_work_journal")).toHaveLength(1);
  });

  it("shows a failed save in the section's error line", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "load_work_journal") return { settings: {} };
      if (cmd === "work_journal_restore_state") return { canUndo: false };
      throw "disk full";
    });
    openMock.mockResolvedValue("D:\\Reports");

    render(<WorkJournalSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose report folder" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the report folder: disk full",
    );
  });
});
