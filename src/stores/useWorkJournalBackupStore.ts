import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import { useWorkJournalReportStore } from "@/stores/useWorkJournalReportStore";
import { useWorkJournalStore, type WorkJournalFile } from "@/stores/useWorkJournalStore";

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

/**
 * What the automatic backup does after a restore or undo: `paused` (the folder
 * holds a backup, left alone until "Back up now"), `runs` (the folder holds
 * none, so the next automatic backup writes one) or `no_folder`.
 */
export type AutoBackupAfterRestore = "paused" | "runs" | "no_folder";

const PAUSED_SENTENCE = "Automatic backups stay paused until you press Back up now.";
const NO_FOLDER_SENTENCE = "Choose a backup folder to turn on automatic backups.";
const UNDONE = "Restore undone: your journal from before the restore is back.";

/** Shown after a successful restore, by what the automatic backup does next. */
export const RESTORE_NOTICES: Record<AutoBackupAfterRestore, string> = {
  paused: `Restored. ${PAUSED_SENTENCE}`,
  runs: "Restored.",
  no_folder: `Restored. ${NO_FOLDER_SENTENCE}`,
};

/** Shown after a successful undo, by what the automatic backup does next. */
export const UNDO_RESTORE_NOTICES: Record<AutoBackupAfterRestore, string> = {
  paused: `${UNDONE} ${PAUSED_SENTENCE}`,
  runs: UNDONE,
  no_folder: `${UNDONE} ${NO_FOLDER_SENTENCE}`,
};

/** The reply of `restore_work_journal` and `undo_work_journal_restore`. */
export interface WorkJournalRestoreReply {
  journal: WorkJournalFile & WorkJournalBackupFile;
  /** Whether a readable safety copy is there for "Undo restore". */
  canUndo: boolean;
  autoBackup: AutoBackupAfterRestore;
}

/** What `work_journal_backup_if_due` did, tagged by `status`. */
export type BackupIfDueOutcome =
  | { status: "written"; journal: WorkJournalBackupFile }
  | { status: "idle" }
  | { status: "skipped"; message: string };

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
   * failures, so hourly retries do not warn again. Reset by a successful
   * backup or a folder change.
   */
  autoFailureWarned: boolean;
  /** The same as `autoFailureWarned`, kept apart for guard skips. */
  autoSkipWarned: boolean;
  /** True while a manual backup is running. */
  backingUp: boolean;
  /** True while a safety copy exists, so "Undo restore" can put it back. */
  canUndo: boolean;
  /** True while a restore or undo is running. */
  restoring: boolean;
  /** The success line after a restore or undo; cleared by the next backup or folder change. */
  notice: string | null;
  /**
   * True after a restore or undo left the automatic backup paused: its skip
   * then adds no warning and no red line, since the notice explains it.
   * Cleared by a successful backup or a folder change.
   */
  pausedByRestore: boolean;
  /**
   * True once the user closed the Work Journal's "no backup folder" reminder.
   * In memory only, so the reminder is back on the next launch while no
   * folder is set.
   */
  reminderDismissed: boolean;
  /** Hides the "no backup folder" reminder for the rest of this app session. */
  dismissReminder: () => void;
  /**
   * True while the main window shows Maestro Settings opened from the
   * reminder (scrolled to the Work Journal section).
   */
  settingsRequested: boolean;
  /** Opens Maestro Settings at the Work Journal section (main window only). */
  openSettings: () => void;
  closeSettings: () => void;
  /** Reads the backup settings from the journal file. */
  load: () => Promise<void>;
  /**
   * Saves `folder` as the backup folder (clearing the last backup time, so an
   * existing backup there is protected until "Back up now"), then runs the
   * automatic backup right away. Choosing the current folder again does
   * nothing.
   */
  chooseFolder: (folder: string) => Promise<void>;
  /** "Back up now". */
  backUpNow: () => Promise<void>;
  /** Start-up and timer check: the backend backs up only when a folder is set and it is due. */
  backUpIfDue: () => Promise<void>;
  /** Reads whether a safety copy exists (enables "Undo restore"). */
  loadRestoreState: () => Promise<void>;
  /**
   * "Restore from backup": `file`, or the backup in the configured folder when
   * omitted. Unsaved editor text is saved first; the pane then shows the
   * restored journal.
   */
  restore: (file?: string) => Promise<void>;
  /** "Undo restore": puts the safety copy back. */
  undoRestore: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Clears the "already warned" flags and the post-restore pause (a success or
 * a folder change ends the run).
 */
const WARNINGS_RESET = {
  autoFailureWarned: false,
  autoSkipWarned: false,
  pausedByRestore: false,
} as const;

/** The native warning for an automatic backup; a dialog failure is only logged. */
async function showWarning(text: string, title: string): Promise<void> {
  try {
    await message(text, { title, kind: "warning" });
  } catch (dialogError) {
    console.error("Failed to show the Work Journal backup warning:", dialogError);
  }
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
  autoSkipWarned: false,
  backingUp: false,
  canUndo: false,
  restoring: false,
  notice: null,
  pausedByRestore: false,
  reminderDismissed: false,

  dismissReminder: () => set({ reminderDismissed: true }),

  settingsRequested: false,
  openSettings: () => set({ settingsRequested: true }),
  closeSettings: () => set({ settingsRequested: false }),

  load: async () => {
    try {
      const journal = await invoke<WorkJournalBackupFile>("load_work_journal");
      set({ ...fromJournal(journal), loadError: null });
      // The report folder row in the same section reads this load too.
      useWorkJournalReportStore.getState().applySettings(journal);
    } catch (error) {
      console.error("Failed to load the Work Journal settings:", error);
      set({ loadError: errorMessage(error) });
    }
  },

  chooseFolder: async (folder: string) => {
    if (folder === get().backupFolder) return;
    try {
      const journal = await invoke<WorkJournalBackupFile>("update_work_journal_settings", {
        settings: { backup_folder: folder, last_backup_at: null },
      });
      set({ ...fromJournal(journal), ...WARNINGS_RESET, error: null, notice: null });
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
      set({ ...fromJournal(journal), ...WARNINGS_RESET, error: null, notice: null });
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
    let outcome: BackupIfDueOutcome;
    try {
      outcome = await invoke<BackupIfDueOutcome>("work_journal_backup_if_due");
    } catch (error) {
      console.error("Automatic Work Journal backup failed:", error);
      const text = errorMessage(error);
      const warn = !get().autoFailureWarned;
      set({ error: `Automatic backup: ${text}`, autoFailureWarned: true });
      if (warn) await showWarning(text, AUTO_BACKUP_WARNING_TITLE);
      return;
    }
    if (outcome?.status === "written") {
      set({ ...fromJournal(outcome.journal), ...WARNINGS_RESET, error: null });
    } else if (outcome?.status === "skipped") {
      if (get().pausedByRestore) return;
      const warn = !get().autoSkipWarned;
      set({ error: outcome.message, autoSkipWarned: true });
      if (warn) await showWarning(outcome.message, AUTO_BACKUP_SKIPPED_TITLE);
    }
  },

  loadRestoreState: async () => {
    try {
      const state = await invoke<{ canUndo: boolean }>("work_journal_restore_state");
      set({ canUndo: state.canUndo });
    } catch (error) {
      console.error("Failed to read the Work Journal restore state:", error);
    }
  },

  restore: (file?: string) =>
    replaceWholeJournal(set, get, "Restore failed", RESTORE_NOTICES, () =>
      invoke<WorkJournalRestoreReply>("restore_work_journal", { file: file ?? null }),
    ),

  undoRestore: () =>
    replaceWholeJournal(set, get, "Undo restore failed", UNDO_RESTORE_NOTICES, () =>
      invoke<WorkJournalRestoreReply>("undo_work_journal_restore"),
    ),
}));

/**
 * Runs a restore or undo: saves unsaved editor text first (so it is in the
 * safety copy), then drops every page save until the backend answers (so
 * nothing typed meanwhile lands over the new journal), then shows the new
 * journal in the pane and the settings. On failure `canUndo` is read again:
 * a restore that failed at its last step has already written a safety copy.
 */
async function replaceWholeJournal(
  set: (partial: Partial<WorkJournalBackupState>) => void,
  get: () => WorkJournalBackupState,
  failure: string,
  notices: Record<AutoBackupAfterRestore, string>,
  run: () => Promise<WorkJournalRestoreReply>,
): Promise<void> {
  // Kept for a failure: an earlier "paused" notice still explains why
  // automatic backups are paused.
  const previousNotice = get().notice;
  set({ restoring: true, error: null, notice: null });
  try {
    await useWorkJournalStore.getState().beginReplace();
    const reply = await run();
    useWorkJournalStore.getState().replaceJournal(reply.journal);
    // The candidate run's interval, model and (kept) last run time come
    // from the restored settings too.
    useWorkJournalCandidateRunStore.getState().applySettings(reply.journal);
    useWorkJournalReportStore.getState().applySettings(reply.journal);
    set({
      ...fromJournal(reply.journal),
      ...WARNINGS_RESET,
      canUndo: reply.canUndo,
      pausedByRestore: reply.autoBackup === "paused",
      notice: notices[reply.autoBackup] ?? notices.paused,
    });
  } catch (error) {
    useWorkJournalStore.getState().endReplace();
    console.error(`${failure}:`, error);
    set({ error: `${failure}: ${errorMessage(error)}`, notice: previousNotice });
    await get().loadRestoreState();
  } finally {
    set({ restoring: false });
  }
}
