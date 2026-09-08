import { useCallback, useEffect, useRef, useState } from "react";
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
 * the session cap), Enter confirms, Escape cancels. Clicking a row works too.
 */
export function EagleProjectPickerModal({
  projects,
  onPick,
  onClose,
}: EagleProjectPickerModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(() => projects.findIndex((p) => !p.atMax));

  const move = useCallback(
    (dir: 1 | -1) => {
      setSelected((cur) => {
        const n = projects.length;
        if (n === 0) return -1;
        // Walk at most one full loop looking for the next selectable project.
        let idx = cur;
        for (let i = 0; i < n; i++) {
          idx = (idx + dir + n) % n;
          if (!projects[idx].atMax) return idx;
        }
        return cur;
      });
    },
    [projects],
  );

  // Close on click-away (same pattern as ShortcutsModal).
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

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
        className="w-full max-w-xs rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        <div className="border-b border-maestro-border px-4 py-3">
          <h2 className="text-sm font-semibold text-maestro-text">New terminal</h2>
          <p className="mt-0.5 text-[11px] text-maestro-muted">Pick the project it belongs to</p>
        </div>

        <ul className="max-h-72 overflow-y-auto py-1">
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
