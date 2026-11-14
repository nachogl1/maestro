import { BookOpenCheck, BrainCircuit, LayoutGrid } from "lucide-react";
import type { ElementType, ReactNode } from "react";
import { DialogSection, DialogToggle } from "@/components/shared/DialogShell";
import { useFeatureSettingsStore } from "@/stores/useFeatureSettingsStore";
import { WorkJournalEnabledToggle } from "./WorkJournalEnabledToggle";

/** Hover help for each feature row, in plain language. */
const HINTS = {
  secondBrain:
    "The brain icon in the strip on the left opens the Second Brain: the Samurai audit stream " +
    "and the files Maestro keeps for you. Turning it off hides the icon.",
  workJournal:
    "The book icon in the strip on the left opens your day-by-day Work Journal. Turning it off " +
    "hides the icon and stops the journal's background work.",
};

interface FeatureRowProps {
  icon: ElementType;
  label: string;
  hint: string;
  children: ReactNode;
}

/** One feature: its strip icon, name, a short hint and its switch. */
function FeatureRow({ icon: Icon, label, hint, children }: FeatureRowProps) {
  return (
    <div className="flex items-center gap-3 rounded-md px-1 py-1.5 text-xs" title={hint}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-maestro-bg text-maestro-accent">
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex-1 cursor-help font-medium text-maestro-text">{label}</span>
      {children}
    </div>
  );
}

/** Settings section that chooses which optional icons the left strip shows. */
export function FeaturesSettingsPanel() {
  const secondBrainEnabled = useFeatureSettingsStore((s) => s.secondBrainEnabled);
  const setSecondBrainEnabled = useFeatureSettingsStore((s) => s.setSecondBrainEnabled);

  return (
    <DialogSection
      title="Panel icons"
      icon={<LayoutGrid size={13} />}
      description="Switch a tool off to hide its icon from the strip on the left."
    >
      <FeatureRow icon={BrainCircuit} label="Second Brain" hint={HINTS.secondBrain}>
        <DialogToggle
          checked={secondBrainEnabled}
          onChange={setSecondBrainEnabled}
          aria-label="Show Second Brain"
        />
      </FeatureRow>
      <FeatureRow icon={BookOpenCheck} label="Work Journal" hint={HINTS.workJournal}>
        <WorkJournalEnabledToggle />
      </FeatureRow>
    </DialogSection>
  );
}
