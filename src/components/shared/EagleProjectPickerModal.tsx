import { useCallback, useEffect, useRef, useState } from "react";
import { useDismissable } from "@/hooks/useDismissable";
import type { EagleProjectOption } from "./TopBar";

interface EagleProjectPickerModalProps {
  projects: EagleProjectOption[];
  /** Add a terminal to the picked project (stays in eagle view; the pre-launch card tiles into the grid). */
  onPick: (tabId: string) => void;
  onClose: () => void;
}

/**
 * Eagle-view "new terminal" picker, opened by Cmd/Ctrl+T while eagle view is
 * active. ArrowUp/ArrowDown move the selection (skipping projects already at
 * the session cap, stopping at the first/last project) and keep it scrolled
 * into view, Enter confirms, Escape cancels. Clicking a row works too.
 */
export function EagleProjectPickerModal({
  projects,
  onPick,
  onClose,
}: EagleProjectPickerModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [selected, setSelected] = useState(() => projects.findIndex((p) => !p.atMax));

  const move = useCallback(
    (dir: 1 | -1) => {
      setSelected((cur) => {
        // Walk toward the list edge looking for the next selectable project;
        // stay put when there is none (no wrap-around).
        for (let idx = cur + dir; idx >= 0 && idx < projects.length; idx += dir) {
          if (!projects[idx].atMax) return idx;
        }
        return cur;
      });
    },
    [projects],
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
        const project = projects[selected];
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
  }, [move, onPick, onClose, projects, selected]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-md rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        <div className="border-b border-maestro-border px-4 py-3">
          <h2 className="text-sm font-semibold text-maestro-text">New terminal</h2>
          <p className="mt-0.5 text-[11px] text-maestro-muted">Pick the project it belongs to</p>
        </div>

        <ul ref={listRef} className="scrollbar-none relative max-h-[70vh] overflow-y-auto py-1">
          {projects.map((project, index) => (
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
          ↑↓ select · Enter confirm · Esc cancel
        </div>
      </div>
    </div>
  );
}
