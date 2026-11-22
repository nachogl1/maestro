import { usePrivacySettingsStore } from "@/stores/usePrivacySettingsStore";
import { SettingsDialog } from "./SettingsDialog";

interface PrivacySettingsHostProps {
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
}

/**
 * Main window only: shows Settings at the Privacy section when a feature that
 * is off asked for it (the Workshop's "Turn it on in Settings → Privacy").
 */
export function PrivacySettingsHost({ theme, onToggleTheme }: PrivacySettingsHostProps) {
  const requested = usePrivacySettingsStore((s) => s.settingsRequested);
  const closeSettings = usePrivacySettingsStore((s) => s.closeSettings);
  if (!requested) return null;
  return (
    <SettingsDialog
      initialSection="privacy"
      theme={theme}
      onToggleTheme={onToggleTheme}
      onClose={closeSettings}
    />
  );
}
