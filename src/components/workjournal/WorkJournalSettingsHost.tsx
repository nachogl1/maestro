import { MaestroSettingsModal } from "@/components/settings/MaestroSettingsModal";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";

/**
 * Main window only: shows Maestro Settings at the Work Journal section when
 * the backup reminder asked for it, from the pane or from the pop-out window.
 */
export function WorkJournalSettingsHost() {
  const requested = useWorkJournalBackupStore((s) => s.settingsRequested);
  const closeSettings = useWorkJournalBackupStore((s) => s.closeSettings);
  if (!requested) return null;
  return <MaestroSettingsModal focusSection="work-journal" onClose={closeSettings} />;
}
