import { BookOpenCheck, BrainCircuit, LayoutGrid, Rocket } from "lucide-react";
import type { ElementType, ReactNode } from "react";
import { DialogSection, DialogToggle } from "@/components/shared/DialogShell";
import { useFeatureSettingsStore } from "@/stores/useFeatureSettingsStore";
import { WorkJournalEnabledToggle } from "./WorkJournalEnabledToggle";

/** Hover help for each feature row, in plain language. */
const HINTS = {
  samuraiLaunch:
    "The rocket button in the top bar opens the Samurai launcher, where you start and clean " +
    "up autonomous runs. Turning it off hides the button; the Samurai supervisor keeps working.",
  secondBrain:
    "The brain button in the top bar opens the Second Brain: the Samurai audit stream and the " +
    "files Maestro keeps for you. Turning it off hides the button.",
  workJournal:
    "The book button in the top bar opens your day-by-day Work Journal. Turning it off hides " +
    "the button and stops the journal's background work.",
};

interface FeatureRowProps {
  icon: ElementType;
  label: string;
  hint: string;
  children: ReactNode;
}

/** One feature: its top-bar icon, name, a short hint and its switch. */
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

/** Settings section that switches the optional top-bar tools on and off. */
export function FeaturesSettingsPanel() {
  const samuraiLaunchEnabled = useFeatureSettingsStore((s) => s.samuraiLaunchEnabled);
  const secondBrainEnabled = useFeatureSettingsStore((s) => s.secondBrainEnabled);
  const setSamuraiLaunchEnabled = useFeatureSettingsStore((s) => s.setSamuraiLaunchEnabled);
  const setSecondBrainEnabled = useFeatureSettingsStore((s) => s.setSecondBrainEnabled);

  return (
    <DialogSection
      title="Top bar tools"
      icon={<LayoutGrid size={13} />}
      description="Switch a tool off to hide its button from the top bar."
    >
      <FeatureRow icon={Rocket} label="Samurai launch" hint={HINTS.samuraiLaunch}>
        <DialogToggle
          checked={samuraiLaunchEnabled}
          onChange={setSamuraiLaunchEnabled}
          aria-label="Show Samurai launch"
        />
      </FeatureRow>
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
