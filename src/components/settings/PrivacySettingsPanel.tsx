import { usePrivacySettingsStore, useUsageBarOn } from "@/stores/usePrivacySettingsStore";
import { PrivacyFeatureList } from "./PrivacyFeatureList";
import { PrivacySwitchRow } from "./PrivacySwitchRow";

/** What the usage bar sends, in the words the prototype fixes (issue #709). */
const USAGE_BAR_WHAT =
  "About once a minute, sends only your Claude login to Anthropic's usage endpoint to show " +
  "your usage limits at the bottom of the window. No conversation text.";

interface PrivacySettingsPanelProps {
  /** Shows the Work Journal section, which has its own switch. */
  onOpenWorkJournal: () => void;
}

/**
 * Settings → Privacy: the usage bar's switch first (issue #709), then the
 * switches for the features that send conversation text to Claude, with the
 * same words as the first-run question (issue #684).
 */
export function PrivacySettingsPanel({ onOpenWorkJournal }: PrivacySettingsPanelProps) {
  const workshop = usePrivacySettingsStore((s) => s.workshop === true);
  const historySummaries = usePrivacySettingsStore((s) => s.historySummaries === true);
  const setChoice = usePrivacySettingsStore((s) => s.setChoice);
  const usageBar = useUsageBarOn();
  const setUsageBar = usePrivacySettingsStore((s) => s.setUsageBar);

  return (
    <div className="space-y-2">
      <PrivacySwitchRow
        name="Usage bar"
        what={USAGE_BAR_WHAT}
        checked={usageBar}
        onChange={setUsageBar}
      />
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
