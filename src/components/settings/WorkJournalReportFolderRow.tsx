import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { useWorkJournalReportStore } from "@/stores/useWorkJournalReportStore";

/**
 * The "Report folder" row of the Work Journal settings section: where the
 * supervisor report is saved, and "Choose folder". The folder comes from
 * the section's settings load; errors show in the section's error line.
 */
export function WorkJournalReportFolderRow(): JSX.Element {
  const reportFolder = useWorkJournalReportStore((s) => s.reportFolder);
  const chooseFolder = useWorkJournalReportStore((s) => s.chooseFolder);

  const handleChooseFolder = async (): Promise<void> => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: reportFolder ?? undefined,
        title: "Choose the folder for Work Journal reports",
      });
      if (typeof picked === "string") await chooseFolder(picked);
    } catch (err) {
      console.error("Failed to open the folder picker:", err);
    }
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="shrink-0 text-maestro-muted">Report folder</span>
      <span
        className="min-w-0 flex-1 truncate text-right text-[11px] text-maestro-text"
        title={reportFolder ?? undefined}
      >
        {reportFolder ?? "None"}
      </span>
      <button
        type="button"
        onClick={() => void handleChooseFolder()}
        aria-label="Choose report folder"
        className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] text-maestro-accent hover:bg-maestro-border/40"
      >
        <FolderOpen size={11} />
        Choose folder
      </button>
    </div>
  );
}
