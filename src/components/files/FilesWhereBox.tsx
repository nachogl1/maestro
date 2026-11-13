import { Copy } from "lucide-react";
import type { FilesTarget } from "./useFilesTarget";

interface FilesWhereBoxProps {
  /** Null: no terminal is open or focused. */
  target: FilesTarget | null;
  onCopyFolder?: () => void;
}

/** The "Showing files of" box: which terminal's folder the tree shows, and whether it is a worktree. */
export function FilesWhereBox({ target, onCopyFolder }: FilesWhereBoxProps) {
  return (
    <div className="shrink-0 rounded-lg border border-maestro-border/60 bg-maestro-card px-2.5 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-maestro-muted">
        Showing files of
      </div>
      {target ? (
        <>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs font-semibold text-maestro-text">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: target.projectColor }}
            />
            <span className="truncate">{target.terminalName}</span>
            <span className="shrink-0 font-normal text-maestro-muted">· {target.projectName}</span>
            {target.kind === "worktree" ? (
              <span className="shrink-0 rounded-sm bg-maestro-green/15 px-1 text-[9px] font-bold uppercase text-maestro-green">
                Worktree
              </span>
            ) : (
              <span className="shrink-0 rounded-sm bg-maestro-muted/20 px-1 text-[9px] font-bold uppercase text-maestro-muted">
                Project
              </span>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={onCopyFolder}
              className="shrink-0 rounded p-0.5 text-maestro-muted hover:bg-maestro-muted/25 hover:text-maestro-text"
              aria-label="Copy folder path"
              title="Copy folder path"
            >
              <Copy size={12} />
            </button>
          </div>
          {/* Right-to-left so a long path is cut from the left and its end stays visible. */}
          <div
            className="mt-0.5 truncate text-left font-mono text-[10.5px] text-maestro-muted"
            style={{ direction: "rtl" }}
            title={target.folder}
          >
            {`‎${target.folder}`}
          </div>
        </>
      ) : (
        <div className="mt-0.5 text-xs text-maestro-muted">
          No terminal open. Start or click a terminal to see its folder.
        </div>
      )}
    </div>
  );
}
