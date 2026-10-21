import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDismissable } from "@/hooks/useDismissable";
import type { EagleProjectOption } from "./TopBar";

/** Projects whose name contains the search text (case-insensitive). */
function matchProjects(projects: EagleProjectOption[], query: string): EagleProjectOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((p) => p.name.toLowerCase().includes(needle));
}

interface EagleProjectPickerModalProps {
  projects: EagleProjectOption[];
  /** Add a terminal to the picked project (stays in eagle view; the pre-launch card tiles into the grid). */
  onPick: (tabId: string) => void;
  onClose: () => void;
}

/**
 * Eagle-view "new terminal" picker, opened by Cmd/Ctrl+T while eagle view is
 * active. The search box has focus on open, so typing narrows the list by
 * project name. ArrowUp/ArrowDown move the selection (skipping projects
 * already at the session cap, stopping at the first/last project) and keep it
 * scrolled into view, Enter confirms, Escape cancels. Clicking a row works too.
 */
export function EagleProjectPickerModal({
  projects,
  onPick,
  onClose,
}: EagleProjectPickerModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  // The selection indexes into the filtered list, not `projects`.
  const matches = useMemo(() => matchProjects(projects, query), [projects, query]);
  const [selected, setSelected] = useState(() => projects.findIndex((p) => !p.atMax));

  // A new search starts the selection on the first selectable match.
  const handleQueryChange = (value: string) => {
    setQuery(value);
    setSelected(matchProjects(projects, value).findIndex((p) => !p.atMax));
  };

  const move = useCallback(
    (dir: 1 | -1) => {
      setSelected((cur) => {
        // Walk toward the list edge looking for the next selectable project;
        // stay put when there is none (no wrap-around).
        for (let idx = cur + dir; idx >= 0 && idx < matches.length; idx += dir) {
          if (!matches[idx].atMax) return idx;
        }
        return cur;
      });
    },
    [matches],
  );

  // Keep the selected row visible inside the list. Adjusts the list's own
  // scrollTop rather than scrollIntoView, which would also scroll ancestors.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[selected] as HTMLElement | undefined;
    if (!list || !row) return;
    const rowBottom = row.offsetTop + row.offsetHeight;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight;
    }
  }, [selected]);

  // Close on click-away. Escape is handled below in the capture-phase listener.
  useDismissable(onClose, { ref: modalRef, escape: false });

  // Capture phase: eagle view keeps live terminals mounted, so without it
  // xterm's textarea would swallow the arrow keys before the modal sees them.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const project = matches[selected];
        if (project && !project.atMax) onPick(project.tabId);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [move, onPick, onClose, matches, selected]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-md rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        <div className="border-b border-maestro-border px-4 py-3">
          <h2 className="text-sm font-semibold text-maestro-text">New terminal</h2>
          <p className="mt-0.5 text-[11px] text-maestro-muted">Pick the project it belongs to</p>
          <div className="relative mt-2">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-maestro-muted"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="Search projects..."
              aria-label="Search projects"
              spellCheck={false}
              // biome-ignore lint/a11y/noAutofocus: the picker opens from a keyboard shortcut — the search box takes the typing so the whole flow stays mouse-free.
              autoFocus
              className="w-full rounded border border-maestro-border bg-maestro-surface py-1.5 pl-7 pr-2 text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
            />
          </div>
        </div>

        <ul ref={listRef} className="scrollbar-none relative max-h-[70vh] overflow-y-auto py-1">
          {matches.length === 0 && (
            <li className="px-4 py-2 text-xs text-maestro-muted">No projects match</li>
          )}
          {matches.map((project, index) => (
            <li key={project.tabId}>
              <button
                type="button"
                disabled={project.atMax}
                onClick={() => onPick(project.tabId)}
                onMouseEnter={() => !project.atMax && setSelected(index)}
                className={`flex w-full items-center gap-2 px-4 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  index === selected
                    ? "bg-maestro-accent/15 text-maestro-text"
                    : "text-maestro-text hover:bg-maestro-card"
                }`}
                title={
                  project.atMax
                    ? `${project.name} already has the maximum number of terminals`
                    : undefined
                }
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: project.color }}
                />
                <span className="truncate">{project.name}</span>
                {project.atMax && (
                  <span className="ml-auto shrink-0 text-[10px] text-maestro-muted">full</span>
                )}
              </button>
            </li>
          ))}
        </ul>

        <div className="border-t border-maestro-border px-4 py-2 text-[10px] text-maestro-muted">
          Type to search · ↑↓ select · Enter confirm · Esc cancel
        </div>
      </div>
    </div>
  );
}
