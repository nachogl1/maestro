import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";

interface WorkJournalSettingsHostProps {
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
}

/**
 * Main window only: shows Settings at the Work Journal section when the
 * backup reminder asked for it, from the pane or from the pop-out window.
 */
export function WorkJournalSettingsHost({ theme, onToggleTheme }: WorkJournalSettingsHostProps) {
  const requested = useWorkJournalBackupStore((s) => s.settingsRequested);
  const closeSettings = useWorkJournalBackupStore((s) => s.closeSettings);
  if (!requested) return null;
  return (
    <SettingsDialog
      initialSection="work-journal"
      theme={theme}
      onToggleTheme={onToggleTheme}
      onClose={closeSettings}
    />
  );
}
