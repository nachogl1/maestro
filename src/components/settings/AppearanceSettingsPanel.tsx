import { Moon, Palette, Sun } from "lucide-react";
import type { ElementType } from "react";
import { DialogSection } from "@/components/shared/DialogShell";

export type Theme = "dark" | "light";

const THEME_OPTIONS: { value: Theme; label: string; icon: ElementType }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
];

interface AppearanceSettingsPanelProps {
  theme?: Theme;
  /** Flips between the dark and light theme. */
  onToggleTheme?: () => void;
}

/** Settings section for the app theme: pick dark or light. */
export function AppearanceSettingsPanel({
  theme = "dark",
  onToggleTheme,
}: AppearanceSettingsPanelProps) {
  return (
    <DialogSection title="Theme" icon={<Palette size={13} />}>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
          const selected = theme === value;
          return (
            <label
              key={value}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors focus-within:ring-2 focus-within:ring-maestro-accent ${
                selected
                  ? "border-maestro-accent bg-maestro-accent/10 text-maestro-text"
                  : "border-maestro-border text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
              }`}
            >
              <input
                type="radio"
                name="maestro-theme"
                value={value}
                checked={selected}
                onChange={() => {
                  if (!selected) onToggleTheme?.();
                }}
                className="sr-only"
              />
              <Icon size={14} className={selected ? "text-maestro-accent" : undefined} />
              {label}
            </label>
          );
        })}
      </div>
    </DialogSection>
  );
}
