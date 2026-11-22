import type { PrivacyChoice, PrivacyFeature } from "@/stores/usePrivacySettingsStore";
import { PrivacySwitchRow } from "./PrivacySwitchRow";

/** What each feature sends to Claude, in the words the prototype fixes. */
const FEATURES: { id: PrivacyFeature; name: string; what: string }[] = [
  {
    id: "workshop",
    name: "Workshop",
    what:
      "Shortly after start and then once a week, Claude reads the past week's conversations " +
      "and writes a report on what to improve.",
  },
  {
    id: "historySummaries",
    name: "History summaries",
    what:
      "For each conversation shown in History, Claude reads it and writes a name and a " +
      "two-sentence summary. Again whenever the conversation changes.",
  },
];

interface PrivacyFeatureListProps {
  values: PrivacyChoice;
  onChange: (feature: PrivacyFeature, on: boolean) => void;
}

/**
 * The two features that send conversation text to Claude, each with its
 * switch: shared by the first-run question and Settings → Privacy.
 */
export function PrivacyFeatureList({ values, onChange }: PrivacyFeatureListProps) {
  return (
    <>
      {FEATURES.map(({ id, name, what }) => (
        <PrivacySwitchRow
          key={id}
          name={name}
          what={what}
          checked={values[id]}
          onChange={(on) => onChange(id, on)}
        />
      ))}
    </>
  );
}
