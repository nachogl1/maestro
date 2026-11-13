import { ChevronDown, FlaskConical, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { formatScratchAge } from "@/lib/scratch";
import { useScratchStore } from "@/stores/useScratchStore";

interface ScratchProjectsPillProps {
  /** A row was clicked: add a terminal to that scratch project (opening its tab first). */
  onOpen: (path: string) => void;
}

/**
 * The "Scratch projects" pill of eagle view's new-terminal list: how many
 * there are, and a drop-down of every scratch folder, open or kept, with its
 * name and age. A row adds a terminal to it; the bin deletes it after an
 * in-place Yes / No.
 */
export function ScratchProjectsPill({ onOpen }: ScratchProjectsPillProps): JSX.Element {
  const projects = useScratchStore((s) => s.projects);
  const error = useScratchStore((s) => s.error);
  const refresh = useScratchStore((s) => s.refresh);
  const remove = useScratchStore((s) => s.remove);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  // The list is read fresh each time the new-terminal list opens.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const now = Date.now();

  return (
    <div className="px-2 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Scratch projects (${projects.length})`}
        className="inline-flex items-center gap-1.5 rounded-full border border-maestro-border px-2 py-0.5 text-[11px] text-maestro-text transition-colors hover:bg-maestro-card"
        title="Every scratch project, open or kept"
      >
        <FlaskConical size={11} className="text-maestro-accent" />
        Scratch projects
        <span className="rounded-full bg-maestro-muted/20 px-1.5 text-[10px] text-maestro-muted">
          {projects.length}
        </span>
        <ChevronDown size={11} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <ul aria-label="Scratch projects list" className="mt-1 max-h-48 overflow-y-auto">
          {projects.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-maestro-muted">No scratch projects yet</li>
          )}
          {projects.map((project) => (
            <li key={project.path} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onOpen(project.path)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-card"
                title={`Open a terminal in ${project.name}`}
              >
                <span className="truncate">{project.name}</span>
                <span className="ml-auto shrink-0 text-[10px] text-maestro-muted">
                  {formatScratchAge(project.createdAtMs, now)}
                </span>
              </button>
              {confirming === project.path ? (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-maestro-muted">
                  Delete?
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null);
                      void remove(project.path);
                    }}
                    className="rounded px-1.5 py-0.5 text-maestro-red hover:bg-maestro-card"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded px-1.5 py-0.5 text-maestro-text hover:bg-maestro-card"
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(project.path)}
                  aria-label={`Delete scratch project ${project.name}`}
                  title={`Delete ${project.name} and its files`}
                  className="shrink-0 rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-red"
                >
                  <Trash2 size={11} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-1 px-2 text-[11px] text-maestro-red">
          {error}
        </p>
      )}
    </div>
  );
}
