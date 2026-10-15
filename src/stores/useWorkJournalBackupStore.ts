import { invoke } from "@tauri-apps/api/core";
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

interface WorkJournalBackupState {
  /** Folder the daily backup is written to; null while none is chosen. */
  backupFolder: string | null;
  /** RFC 3339 time of the last successful backup; null when never. */
  lastBackupAt: string | null;
  /** The last load or backup failure (manual or automatic); cleared on success. */
  error: string | null;
  /** True while a manual backup is running. */
  backingUp: boolean;
  /** Reads the backup settings from the journal file. */
  load: () => Promise<void>;
  /** Saves `folder` as the backup folder, then backs up to it right away. */
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
  error: null,
  backingUp: false,

  load: async () => {
    try {
      const journal = await invoke<WorkJournalBackupFile>("load_work_journal");
      set(fromJournal(journal));
    } catch (error) {
      console.error("Failed to load the Work Journal settings:", error);
      set({ error: errorMessage(error) });
    }
  },

  chooseFolder: async (folder: string) => {
    try {
      const journal = await invoke<WorkJournalBackupFile>("update_work_journal_settings", {
        settings: { backup_folder: folder },
      });
      set({ ...fromJournal(journal), error: null });
    } catch (error) {
      console.error("Failed to save the Work Journal backup folder:", error);
      set({ error: `Could not save the backup folder: ${errorMessage(error)}` });
      return;
    }
    await get().backUpNow();
  },

  backUpNow: async () => {
    set({ backingUp: true });
    try {
      const journal = await invoke<WorkJournalBackupFile>("work_journal_backup_now");
      set({ ...fromJournal(journal), error: null });
    } catch (error) {
      console.error("Work Journal backup failed:", error);
      set({ error: `Backup failed: ${errorMessage(error)}` });
    } finally {
      set({ backingUp: false });
    }
  },

  backUpIfDue: async () => {
    try {
      const journal = await invoke<WorkJournalBackupFile | null>("work_journal_backup_if_due");
      if (journal) set({ ...fromJournal(journal), error: null });
    } catch (error) {
      console.error("Automatic Work Journal backup failed:", error);
      set({ error: `Automatic backup failed: ${errorMessage(error)}` });
    }
  },
}));
