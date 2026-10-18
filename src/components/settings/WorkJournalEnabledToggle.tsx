import { DialogToggle } from "@/components/shared/DialogShell";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";

/** The on/off switch in the Work Journal section heading of Settings. */
export function WorkJournalEnabledToggle() {
  const enabled = useWorkJournalSettingsStore((s) => s.enabled === true);
  const setEnabled = useWorkJournalSettingsStore((s) => s.setEnabled);
  return (
    <DialogToggle checked={enabled} onChange={setEnabled} aria-label="Enable the Work Journal" />
  );
}
