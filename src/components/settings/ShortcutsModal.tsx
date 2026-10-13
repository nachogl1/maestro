import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { altLabel, modLabel } from "@/lib/shortcuts";

interface ShortcutsModalProps {
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

function buildGroups(mod: string, alt: string): ShortcutGroup[] {
  return [
    {
      title: "Left Sidebar",
      shortcuts: [
        { keys: [alt, "1"], description: "History tab (press again to close)" },
        { keys: [alt, "2"], description: "Infra tab (press again to close)" },
        { keys: [alt, "3"], description: "Settings tab (press again to close)" },
      ],
    },
    {
      title: "Right Panels",
      shortcuts: [
        { keys: [mod, "2"], description: "Toggle the Git panel" },
        { keys: [mod, "5"], description: "Toggle the Notes panel" },
      ],
    },
    {
      title: "Terminals & Views",
      shortcuts: [
        { keys: [mod, "T"], description: "New terminal (project picker in eagle view)" },
        { keys: [mod, "1"], description: "Zoom the focused terminal (toggle)" },
        { keys: [alt, "← →"], description: "Previous / next tab while zoomed" },
        { keys: [mod, alt, "← →"], description: "Focus the previous / next terminal" },
        { keys: [mod, "G"], description: "Toggle eagle view (all projects)" },

        { keys: [alt, "P"], description: "Park the focused terminal" },
      ],
    },
    {
      title: "Projects",
      shortcuts: [
        // Ctrl on every platform: macOS reserves Cmd+Tab for the app switcher.
        { keys: ["Ctrl", "Tab"], description: "Next project" },
        { keys: ["Ctrl", "Shift", "Tab"], description: "Previous project" },
      ],
    },
  ];
}

function Key({ label }: { label: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-maestro-border bg-maestro-card px-1.5 font-mono text-[11px] font-medium text-maestro-text shadow-sm">
      {label}
    </kbd>
  );
}

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const groups = buildGroups(modLabel(), altLabel());

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-lg max-h-[80vh] overflow-hidden rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl flex flex-col"
      >
        <div className="flex items-center justify-between border-b border-maestro-border px-4 py-3">
          <h2 className="text-sm font-semibold text-maestro-text">Keyboard Shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-maestro-border/40"
          >
            <X size={16} className="text-maestro-muted" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {groups.map((group) => (
            <section key={group.title}>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
                {group.title}
              </div>
              <ul className="space-y-1.5">
                {group.shortcuts.map((s) => (
                  <li
                    key={s.description}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-maestro-border/20"
                  >
                    <span className="text-xs text-maestro-text">{s.description}</span>
                    <div className="flex shrink-0 items-center gap-1">
                      {s.keys.map((k, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: keys are stable per row
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span className="text-[10px] text-maestro-muted">+</span>}
                          <Key label={k} />
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
