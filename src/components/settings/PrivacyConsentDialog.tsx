import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { DialogShell, dialogButtonClass } from "@/components/shared/DialogShell";
import {
  type PrivacyChoice,
  usePrivacySettingsLoaded,
  usePrivacySettingsStore,
} from "@/stores/usePrivacySettingsStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import {
  useWorkJournalSettingsLoaded,
  useWorkJournalSettingsStore,
} from "@/stores/useWorkJournalSettingsStore";
import { PrivacyFeatureList } from "./PrivacyFeatureList";

const BOTH_OFF: PrivacyChoice = { workshop: false, historySummaries: false };

/**
 * First-run question (issue #684): may the Workshop and History summaries
 * send conversation text to Claude? Both switches start off; Save keeps what
 * they say, and "Keep both off", × and Escape save both as off. Shown once,
 * also to people updating from a version without it, and only after the
 * automatic-updates and Work Journal questions, so first-run dialogs never
 * stack.
 */
export function PrivacyConsentDialog() {
  const privacyLoaded = usePrivacySettingsLoaded();
  const answered = usePrivacySettingsStore(
    (s) => s.workshop !== null && s.historySummaries !== null,
  );
  const setChoice = usePrivacySettingsStore((s) => s.setChoice);
  const journalLoaded = useWorkJournalSettingsLoaded();
  const journalAnswered = useWorkJournalSettingsStore((s) => s.enabled !== null);
  const updateAnswered = useUpdateStore((s) => s.autoInstallOnLaunch !== null);
  const [draft, setDraft] = useState<PrivacyChoice>(BOTH_OFF);

  const waiting = !privacyLoaded || !journalLoaded || !updateAnswered || !journalAnswered;
  if (waiting || answered) return null;

  const keepBothOff = () => setChoice(BOTH_OFF);

  return (
    <DialogShell
      title="Let Claude read your conversations?"
      icon={<ShieldCheck size={14} />}
      onClose={keepBothOff}
      size="sm"
      closeOnOutsideClick={false}
      footer={
        <>
          <button type="button" onClick={keepBothOff} className={dialogButtonClass("ghost")}>
            Keep both off
          </button>
          <button
            type="button"
            onClick={() => setChoice(draft)}
            className={dialogButtonClass("primary")}
          >
            Save
          </button>
        </>
      }
    >
      <p className="text-xs text-maestro-text">
        Two features send the text of your Claude conversations to Claude, through your own Claude
        CLI and your Claude allowance. Both stay off unless you switch them on.
      </p>
      <PrivacyFeatureList
        values={draft}
        onChange={(feature, on) => setDraft((d) => ({ ...d, [feature]: on }))}
      />
      <p className="text-[11px] text-maestro-muted">
        You can change both at any time in Settings → Privacy.
      </p>
    </DialogShell>
  );
}
