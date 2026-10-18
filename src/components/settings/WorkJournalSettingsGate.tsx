import { BookOpen } from "lucide-react";
import { DialogSection } from "@/components/shared/DialogShell";
import { useWorkJournalEnabled } from "@/stores/useWorkJournalSettingsStore";
import { WorkJournalEnabledToggle } from "./WorkJournalEnabledToggle";
import { WorkJournalSettingsSection } from "./WorkJournalSettingsSection";

/**
 * Work Journal section of Settings: the full section while the journal
 * is on, otherwise just its on/off switch.
 */
export function WorkJournalSettingsGate() {
  const enabled = useWorkJournalEnabled();
  if (enabled) return <WorkJournalSettingsSection />;
  return (
    <DialogSection
      title="Work Journal"
      icon={<BookOpen size={13} />}
      right={<WorkJournalEnabledToggle />}
    >
      <p className="text-[11px] text-maestro-muted">
        Off. Turn it on for a day-by-day diary of your work, with suggested lines written by Claude
        from your activity.
      </p>
    </DialogSection>
  );
}
