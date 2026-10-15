import { ask, open } from "@tauri-apps/plugin-dialog";
import { BookOpen, FolderOpen, Loader2, Undo2 } from "lucide-react";
import { useEffect } from "react";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import { useWorkJournalReportStore } from "@/stores/useWorkJournalReportStore";
import { WorkJournalCandidateRunRows } from "./WorkJournalCandidateRunRows";
import { WorkJournalGranolaRow } from "./WorkJournalGranolaRow";
import { WorkJournalReportFolderRow } from "./WorkJournalReportFolderRow";

/** "15 Oct 2026, 12:34" in the user's locale; the raw text if unparsable. */
function formatBackupTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The backup file inside `folder` (the backend's `backup_path`), for the confirm text. */
function backupFileIn(folder: string): string {
  const separator = folder.includes("\\") ? "\\" : "/";
  const base = folder.endsWith(separator) ? folder : `${folder}${separator}`;
  return `${base}work-journal.json`;
}

/** Hover help for the section's rows and buttons, in plain language. */
const HINTS = {
  section:
    "The Work Journal is your day-by-day diary of work in Maestro, with suggested lines " +
    "written by Claude from your activity.",
  backupFolder:
    "The folder where a copy of your whole journal is saved once a day, as a safety net. " +
    "Pick one to turn the daily backup on.",
  backUpNow: "Save a copy of your journal to the backup folder right away.",
  restore:
    "Replace your current journal with the copy saved in the backup folder. A safety copy " +
    "is kept so you can undo.",
  browse:
    "Pick any Work Journal backup file on your computer and replace your current journal " +
    "with it. A safety copy is kept so you can undo.",
  undo: "Put your journal back to how it was just before the last restore.",
};

/** Asks before a restore replaces the whole journal; a dialog failure counts as "no". */
function confirmRestore(file: string): Promise<boolean> {
  return ask(
    `Replace your whole Work Journal with the backup ${file}? Your current journal is saved as ` +
      "one safety copy, and Undo restore puts it back.",
    { title: "Restore Work Journal", kind: "warning" },
  ).catch(() => false);
}

/**
 * Work Journal section of Maestro Settings: the backup folder, "Back up now",
 * the last backup time, "Restore from backup" (the folder's backup or a
 * browsed file), "Undo restore" and the report folder.
 */
export function WorkJournalSettingsSection(): JSX.Element {
  const backupFolder = useWorkJournalBackupStore((s) => s.backupFolder);
  const lastBackupAt = useWorkJournalBackupStore((s) => s.lastBackupAt);
  const loadError = useWorkJournalBackupStore((s) => s.loadError);
  const error = useWorkJournalBackupStore((s) => s.error);
  const backingUp = useWorkJournalBackupStore((s) => s.backingUp);
  const load = useWorkJournalBackupStore((s) => s.load);
  const chooseFolder = useWorkJournalBackupStore((s) => s.chooseFolder);
  const backUpNow = useWorkJournalBackupStore((s) => s.backUpNow);
  const runError = useWorkJournalCandidateRunStore((s) => s.runError);
  const runSettingsError = useWorkJournalCandidateRunStore((s) => s.settingsError);
  const reportError = useWorkJournalReportStore((s) => s.error);
  const canUndo = useWorkJournalBackupStore((s) => s.canUndo);
  const restoring = useWorkJournalBackupStore((s) => s.restoring);
  const notice = useWorkJournalBackupStore((s) => s.notice);
  const loadRestoreState = useWorkJournalBackupStore((s) => s.loadRestoreState);
  const restore = useWorkJournalBackupStore((s) => s.restore);
  const undoRestore = useWorkJournalBackupStore((s) => s.undoRestore);
  const busy = backingUp || restoring;

  useEffect(() => {
    void load();
    void loadRestoreState();
  }, [load, loadRestoreState]);

  const handleChooseFolder = async (): Promise<void> => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: backupFolder ?? undefined,
        title: "Choose the Work Journal backup folder",
      });
      if (typeof picked === "string") await chooseFolder(picked);
    } catch (err) {
      console.error("Failed to open the folder picker:", err);
    }
  };

  const handleRestoreDefault = async (): Promise<void> => {
    if (!backupFolder || !(await confirmRestore(backupFileIn(backupFolder)))) return;
    await restore();
  };

  const handleBrowseRestore = async (): Promise<void> => {
    let picked: string | string[] | null;
    try {
      picked = await open({
        multiple: false,
        filters: [{ name: "Work Journal backup", extensions: ["json"] }],
        defaultPath: backupFolder ?? undefined,
        title: "Choose a Work Journal backup file",
      });
    } catch (err) {
      console.error("Failed to open the file picker:", err);
      return;
    }
    if (typeof picked !== "string" || !(await confirmRestore(picked))) return;
    await restore(picked);
  };

  const handleUndoRestore = async (): Promise<void> => {
    const confirmed = await ask(
      "Put back your Work Journal from before the restore? Changes made since the restore are lost.",
      { title: "Undo Restore", kind: "warning" },
    ).catch(() => false);
    if (confirmed) await undoRestore();
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
        <BookOpen size={13} className="text-maestro-accent" />
        <span className="cursor-help" title={HINTS.section}>
          Work Journal
        </span>
      </div>
      <div className="space-y-1.5 px-1">
        <WorkJournalCandidateRunRows />
        <WorkJournalGranolaRow />
        <div className="flex items-center gap-2 text-xs">
          <span className="shrink-0 cursor-help text-maestro-muted" title={HINTS.backupFolder}>
            Backup folder
          </span>
          <span
            className="min-w-0 flex-1 truncate text-right text-[11px] text-maestro-text"
            title={backupFolder ?? undefined}
          >
            {backupFolder ?? "None"}
          </span>
          <button
            type="button"
            onClick={() => void handleChooseFolder()}
            title={HINTS.backupFolder}
            className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] text-maestro-accent hover:bg-maestro-border/40"
          >
            <FolderOpen size={11} />
            Choose folder
          </button>
        </div>
        {!backupFolder && (
          <p className="text-[11px] text-maestro-orange">
            No backup folder chosen. Pick one to turn on the daily backup.
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[10px] text-maestro-muted">
            {lastBackupAt ? `Last backup: ${formatBackupTime(lastBackupAt)}` : "Never backed up"}
          </span>
          <button
            type="button"
            onClick={() => void backUpNow()}
            disabled={!backupFolder || backingUp}
            title={HINTS.backUpNow}
            className="flex items-center gap-1 rounded border border-maestro-accent/50 bg-maestro-accent/10 px-3 py-1 text-[11px] font-medium text-maestro-accent hover:bg-maestro-accent/20 disabled:opacity-50"
          >
            {backingUp && <Loader2 size={11} className="animate-spin" />}
            Back up now
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[10px] text-maestro-muted">
            Restore replaces the whole journal
          </span>
          <button
            type="button"
            onClick={() => void handleRestoreDefault()}
            disabled={!backupFolder || busy}
            title={
              backupFolder
                ? `${HINTS.restore}\nBackup file: ${backupFileIn(backupFolder)}`
                : `${HINTS.restore}\nChoose a backup folder first.`
            }
            className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] text-maestro-accent hover:bg-maestro-border/40 disabled:opacity-50"
          >
            {restoring && <Loader2 size={11} className="animate-spin" />}
            Restore from backup
          </button>
          <button
            type="button"
            onClick={() => void handleBrowseRestore()}
            disabled={busy}
            title={HINTS.browse}
            className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] text-maestro-accent hover:bg-maestro-border/40 disabled:opacity-50"
          >
            <FolderOpen size={11} />
            Browse…
          </button>
          <button
            type="button"
            onClick={() => void handleUndoRestore()}
            disabled={!canUndo || busy}
            title={HINTS.undo}
            className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] text-maestro-accent hover:bg-maestro-border/40 disabled:opacity-50"
          >
            <Undo2 size={11} />
            Undo restore
          </button>
        </div>
        <WorkJournalReportFolderRow />
        {notice && <output className="block text-[11px] text-maestro-green">{notice}</output>}
        {[runSettingsError, runError, loadError, error, reportError].filter(Boolean).map((text) => (
          <div key={text} role="alert" className="text-[11px] text-maestro-red">
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}
