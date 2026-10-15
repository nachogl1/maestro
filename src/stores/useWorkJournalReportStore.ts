import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/** The Work Journal settings key the report uses; other keys stay opaque here. */
export interface WorkJournalReportSettings {
  report_folder?: string | null;
}

/** The part of `work-journal.json` (as the backend returns it) the report reads. */
export interface WorkJournalReportFile {
  settings: WorkJournalReportSettings;
}

/** What `work_journal_generate_report` did, tagged by `status`. */
export type ReportOutcome =
  | { status: "saved"; path: string }
  | { status: "nothing_to_report" }
  | { status: "no_folder" }
  | { status: "busy" };

interface WorkJournalReportState {
  /** Folder the report is written to; null while none is chosen. */
  reportFolder: string | null;
  /** The last failure to read or save the report folder; cleared on success. */
  error: string | null;
  /** Reads the report folder from the journal file; false when the read failed. */
  load: () => Promise<boolean>;
  /** Takes the report folder from a journal the backend just returned (settings load, restore). */
  applySettings: (journal: { settings: object }) => void;
  /** Saves `folder` as the report folder (only that key); false when the save failed. */
  chooseFolder: (folder: string) => Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function folderOf(journal: { settings: object }): string | null {
  const folder = (journal.settings as WorkJournalReportSettings).report_folder;
  return typeof folder === "string" && folder !== "" ? folder : null;
}

/**
 * Report-folder state shared by the report dialog and the Work Journal
 * settings section. The journal file stays the source of truth.
 */
export const useWorkJournalReportStore = create<WorkJournalReportState>((set) => ({
  reportFolder: null,
  error: null,

  load: async () => {
    try {
      const journal = await invoke<WorkJournalReportFile>("load_work_journal");
      set({ reportFolder: folderOf(journal), error: null });
      return true;
    } catch (error) {
      console.error("Failed to load the Work Journal report folder:", error);
      set({ error: `Could not read the report folder: ${errorMessage(error)}` });
      return false;
    }
  },

  applySettings: (journal: { settings: object }) =>
    set({ reportFolder: folderOf(journal), error: null }),

  chooseFolder: async (folder: string) => {
    try {
      const settings: WorkJournalReportSettings = { report_folder: folder };
      const journal = await invoke<WorkJournalReportFile>("update_work_journal_settings", {
        settings,
      });
      set({ reportFolder: folderOf(journal), error: null });
      return true;
    } catch (error) {
      console.error("Failed to save the Work Journal report folder:", error);
      set({ error: `Could not save the report folder: ${errorMessage(error)}` });
      return false;
    }
  },
}));
