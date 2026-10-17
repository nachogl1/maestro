import { Keyboard } from "lucide-react";
import { DialogSection, DialogShell } from "@/components/shared/DialogShell";
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
        { keys: [alt, "4"], description: "Toggle the Injector panel" },
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
        {
          keys: [alt, "Shift", "← ↑ ↓ →"],
          description: "Move the focused terminal in that direction",
        },
      ],
    },
    {
      title: "Projects",
      shortcuts: [
        // Ctrl on every platform: macOS reserves Cmd+Tab for the app switcher.
        { keys: ["Ctrl", "Tab"], description: "Next project" },
        { keys: ["Ctrl", "Shift", "Tab"], description: "Previous project" },
        {
          keys: [mod, "Shift", "← →"],
          description: "Move the focused project tab left / right (tab must have focus)",
        },
      ],
    },
  ];
}

function Key({ label }: { label: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-maestro-border bg-maestro-bg px-1.5 font-mono text-[11px] font-medium text-maestro-text shadow-sm">
      {label}
    </kbd>
  );
}

export function ShortcutsModal({ onClose }: ShortcutsModalProps) {
  const groups = buildGroups(modLabel(), altLabel());

  return (
    <DialogShell
      title="Keyboard Shortcuts"
      icon={<Keyboard size={16} />}
      size="lg"
      onClose={onClose}
    >
      {groups.map((group) => (
        <DialogSection key={group.title} title={group.title}>
          <ul className="space-y-0.5">
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
        </DialogSection>
      ))}
    </DialogShell>
  );
}
