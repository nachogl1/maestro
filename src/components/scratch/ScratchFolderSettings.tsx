import { FlaskConical, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { DialogSection, dialogButtonClass } from "@/components/shared/DialogShell";
import { pickFolder } from "@/lib/dialog";
import { useScratchStore } from "@/stores/useScratchStore";

/** Hover help for the row, in plain language. */
const SCRATCH_FOLDER_HINT =
  "Where Maestro makes scratch projects: throwaway folders for work that belongs to no " +
  "project. Every folder directly inside it counts as a scratch project.";

/**
 * The Settings row that sets the scratch folder: `Maestro Scratch` in the
 * home folder by default (made on first use), changeable with the folder
 * chooser and back to the default with one click.
 */
export function ScratchFolderSettings(): JSX.Element {
  const folder = useScratchStore((s) => s.folder);
  const folderSetting = useScratchStore((s) => s.folderSetting);
  const error = useScratchStore((s) => s.error);
  const setFolderSetting = useScratchStore((s) => s.setFolderSetting);
  const refresh = useScratchStore((s) => s.refresh);
  const [pickError, setPickError] = useState<string | null>(null);

  // Shows the folder in use even before the first scratch project exists.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleChooseFolder = async (): Promise<void> => {
    setPickError(null);
    try {
      const picked = await pickFolder(
        "Choose the folder for scratch projects",
        folder ?? undefined,
      );
      if (picked) await setFolderSetting(picked);
    } catch (err) {
      console.error("Failed to open the folder picker:", err);
      const message = err instanceof Error ? err.message : String(err);
      setPickError(`Could not open the folder picker: ${message}`);
    }
  };

  const shownError = pickError ?? error;

  return (
    <DialogSection
      title="Scratch projects"
      icon={<FlaskConical size={13} />}
      description="New scratch projects from eagle view's new-terminal list are made in this folder."
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 cursor-help text-maestro-text" title={SCRATCH_FOLDER_HINT}>
          Scratch folder
        </span>
        <span
          className="min-w-0 flex-1 truncate text-right text-[11px] text-maestro-muted"
          title={folder ?? undefined}
        >
          {folder ?? "Maestro Scratch in your home folder"}
        </span>
        {folderSetting && (
          <button
            type="button"
            onClick={() => void setFolderSetting(null)}
            className={dialogButtonClass("ghost")}
            title="Go back to Maestro Scratch in your home folder"
          >
            Use default
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleChooseFolder()}
          aria-label="Choose scratch folder"
          title={SCRATCH_FOLDER_HINT}
          className={dialogButtonClass("accent")}
        >
          <FolderOpen size={11} />
          Choose folder
        </button>
      </div>
      {shownError && (
        <p role="alert" className="text-[11px] text-maestro-red">
          {shownError}
        </p>
      )}
    </DialogSection>
  );
}
