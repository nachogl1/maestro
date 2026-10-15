import { open } from "@tauri-apps/plugin-dialog";
import { BookOpen, FolderOpen, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import { WorkJournalCandidateRunRows } from "./WorkJournalCandidateRunRows";

/** "15 Oct 2026, 12:34" in the user's locale; the raw text if unparsable. */
function formatBackupTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Work Journal section of Maestro Settings: the backup folder, "Back up now"
 * and the last backup time. Restore rows join this section later.
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

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
        <BookOpen size={13} className="text-maestro-accent" />
        Work Journal
      </div>
      <div className="space-y-1.5 px-1">
        <WorkJournalCandidateRunRows />
        <div className="flex items-center gap-2 text-xs">
          <span className="shrink-0 text-maestro-muted">Backup folder</span>
          <span
            className="min-w-0 flex-1 truncate text-right text-[11px] text-maestro-text"
            title={backupFolder ?? undefined}
          >
            {backupFolder ?? "None"}
          </span>
          <button
            type="button"
            onClick={() => void handleChooseFolder()}
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
            className="flex items-center gap-1 rounded border border-maestro-accent/50 bg-maestro-accent/10 px-3 py-1 text-[11px] font-medium text-maestro-accent hover:bg-maestro-accent/20 disabled:opacity-50"
          >
            {backingUp && <Loader2 size={11} className="animate-spin" />}
            Back up now
          </button>
        </div>
        {[runSettingsError, runError, loadError, error].filter(Boolean).map((text) => (
          <div key={text} role="alert" className="text-[11px] text-maestro-red">
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}
