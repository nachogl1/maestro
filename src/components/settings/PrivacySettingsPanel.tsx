import { usePrivacySettingsStore } from "@/stores/usePrivacySettingsStore";
import { PrivacyFeatureList } from "./PrivacyFeatureList";

interface PrivacySettingsPanelProps {
  /** Shows the Work Journal section, which has its own switch. */
  onOpenWorkJournal: () => void;
}

/**
 * Settings → Privacy (issue #684): the switches for the features that send
 * conversation text to Claude, with the same words as the first-run question.
 */
export function PrivacySettingsPanel({ onOpenWorkJournal }: PrivacySettingsPanelProps) {
  const workshop = usePrivacySettingsStore((s) => s.workshop === true);
  const historySummaries = usePrivacySettingsStore((s) => s.historySummaries === true);
  const setChoice = usePrivacySettingsStore((s) => s.setChoice);

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-maestro-muted">
        These features send the text of your Claude conversations to Claude, through your own Claude
        CLI and your Claude allowance. Off means nothing is sent.
      </p>
      <PrivacyFeatureList
        values={{ workshop, historySummaries }}
        onChange={(feature, on) => setChoice({ [feature]: on })}
      />
      <p className="text-[11px] text-maestro-muted">
        The Work Journal has its own switch in{" "}
        <button
          type="button"
          onClick={onOpenWorkJournal}
          className="text-maestro-accent underline hover:opacity-80"
        >
          Settings → Work Journal
        </button>
        .
      </p>
    </div>
  );
}
