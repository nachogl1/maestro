import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";

/** The Work Journal settings keys the backup uses; other keys stay opaque here. */
export interface WorkJournalBackupSettings {
  backup_folder?: string | null;
  last_backup_at?: string | null;
}

/** The part of `work-journal.json` (as the backend returns it) the backup reads. */
export interface WorkJournalBackupFile {
  settings: WorkJournalBackupSettings;
}

/** Title of the native warning shown when an automatic backup fails. */
export const AUTO_BACKUP_WARNING_TITLE = "Work Journal backup failed";

/** Title of the native warning shown when the guard skips an automatic backup. */
export const AUTO_BACKUP_SKIPPED_TITLE = "Work Journal backup skipped";

/** Start of the backend's message when the guard skips an automatic backup. */
const AUTO_BACKUP_SKIPPED_PREFIX = "Automatic backup skipped";

interface WorkJournalBackupState {
  /** Folder the daily backup is written to; null while none is chosen. */
  backupFolder: string | null;
  /** RFC 3339 time of the last successful backup; null when never. */
  lastBackupAt: string | null;
  /** The last failure to read the journal settings; cleared by a successful load. */
  loadError: string | null;
  /** The last backup or folder-save failure (manual or automatic); cleared on success. */
  error: string | null;
  /**
   * True once the native warning was shown for the current run of automatic
   * failures or skips, so hourly retries do not warn again. Reset by a
   * successful backup or a folder change.
   */
  autoFailureWarned: boolean;
  /** True while a manual backup is running. */
  backingUp: boolean;
  /** Reads the backup settings from the journal file. */
  load: () => Promise<void>;
  /**
   * Saves `folder` as the backup folder (clearing the last backup time, so an
   * existing backup there is protected until "Back up now"), then runs the
   * automatic backup right away.
   */
  chooseFolder: (folder: string) => Promise<void>;
  /** "Back up now". */
  backUpNow: () => Promise<void>;
  /** Start-up and timer check: the backend backs up only when a folder is set and it is due. */
  backUpIfDue: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fromJournal(
  journal: WorkJournalBackupFile,
): Pick<WorkJournalBackupState, "backupFolder" | "lastBackupAt"> {
  return {
    backupFolder: journal.settings.backup_folder || null,
    lastBackupAt: journal.settings.last_backup_at || null,
  };
}

/**
 * Backup state for the Work Journal settings section, shared with the app's
 * background timer so an automatic backup's time or failure shows in the
 * section too. The journal file stays the source of truth.
 */
export const useWorkJournalBackupStore = create<WorkJournalBackupState>((set, get) => ({
  backupFolder: null,
  lastBackupAt: null,
  loadError: null,
  error: null,
  autoFailureWarned: false,
  backingUp: false,

  load: async () => {
    try {
      const journal = await invoke<WorkJournalBackupFile>("load_work_journal");
      set({ ...fromJournal(journal), loadError: null });
    } catch (error) {
      console.error("Failed to load the Work Journal settings:", error);
      set({ loadError: errorMessage(error) });
    }
  },

  chooseFolder: async (folder: string) => {
    try {
      const journal = await invoke<WorkJournalBackupFile>("update_work_journal_settings", {
        settings: { backup_folder: folder, last_backup_at: null },
      });
      set({ ...fromJournal(journal), error: null, autoFailureWarned: false });
    } catch (error) {
      console.error("Failed to save the Work Journal backup folder:", error);
      set({ error: `Could not save the backup folder: ${errorMessage(error)}` });
      return;
    }
    await get().backUpIfDue();
  },

  // Always writes (the explicit override of the automatic guard). Failures
  // stay inline only: the user is looking at the section.
  backUpNow: async () => {
    set({ backingUp: true });
    try {
      const journal = await invoke<WorkJournalBackupFile>("work_journal_backup_now");
      set({ ...fromJournal(journal), error: null, autoFailureWarned: false });
    } catch (error) {
      console.error("Work Journal backup failed:", error);
      set({ error: errorMessage(error) });
    } finally {
      set({ backingUp: false });
    }
  },

  // Failures and guard skips also raise one native warning per run, since
  // the user may never open Settings.
  backUpIfDue: async () => {
    try {
      const journal = await invoke<WorkJournalBackupFile | null>("work_journal_backup_if_due");
      if (journal) set({ ...fromJournal(journal), error: null, autoFailureWarned: false });
    } catch (error) {
      console.error("Automatic Work Journal backup failed:", error);
      const text = errorMessage(error);
      const skipped = text.startsWith(AUTO_BACKUP_SKIPPED_PREFIX);
      const warn = !get().autoFailureWarned;
      set({ error: skipped ? text : `Automatic backup: ${text}`, autoFailureWarned: true });
      if (warn) {
        const title = skipped ? AUTO_BACKUP_SKIPPED_TITLE : AUTO_BACKUP_WARNING_TITLE;
        try {
          await message(text, { title, kind: "warning" });
        } catch (dialogError) {
          console.error("Failed to show the Work Journal backup warning:", dialogError);
        }
      }
    }
  },
}));
