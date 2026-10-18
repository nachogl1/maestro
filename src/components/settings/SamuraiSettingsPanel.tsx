import { invoke } from "@tauri-apps/api/core";
import { Loader2, Swords } from "lucide-react";
import { useEffect, useState } from "react";
import { DialogRow, DialogSection, dialogInputClass } from "@/components/shared/DialogShell";
import type { SamuraiConfig } from "@/lib/samurai";

/** Hover help for the Samurai section heading: what the supervisor is. */
const SAMURAI_HINT =
  "Samurai is Maestro's automatic supervisor. It watches the Claude agents you launch and " +
  "steps in when one runs low on working memory or when your Claude usage allowance is " +
  "nearly used up, so long tasks keep going without you.";

/** One threshold row: the saved field, its label and a plain-language hover hint. */
const SAMURAI_FIELDS: { key: keyof SamuraiConfig; label: string; hint: string }[] = [
  {
    key: "handoff_context_pct",
    label: "Handoff trigger (context %)",
    hint:
      "Each Claude agent has a limited working memory (its context). When an agent has used " +
      "this much of it, Maestro asks it to write down where it got to and hand the work to a " +
      "fresh agent, so quality does not drop as the memory fills up. Lower means earlier, " +
      "more frequent handoffs.",
  },
  {
    key: "park_soft_5h_pct",
    label: "Park soft, 5h window (%)",
    hint:
      "Your Claude plan allows a certain amount of work every 5 hours. When this much of it is " +
      "used, agents stop starting new helper agents and begin wrapping up, so there is still " +
      "room left to pause cleanly.",
  },
  {
    key: "park_hard_5h_pct",
    label: "Park hard, 5h window (%)",
    hint:
      "When this much of the 5-hour allowance is used, Maestro pauses (parks) the agents one " +
      "by one: each finishes its current step, saves its notes and stops. They resume on " +
      "their own when the allowance resets.",
  },
  {
    key: "park_hard_7d_pct",
    label: "Park hard, 7d window (%)",
    hint:
      "Your plan also has a weekly limit. When this much of the 7-day allowance is used, " +
      "agents are paused the same way and resume when the weekly allowance resets.",
  },
  {
    key: "ack_timeout_secs",
    label: "ACK timeout (seconds)",
    hint:
      "When Maestro sends an agent an instruction (for example to hand off or pause), it " +
      "expects a short confirmation back. If none arrives within this many seconds, Maestro " +
      "sends the instruction once more and then raises an alert.",
  },
  {
    key: "max_turn_wait_secs",
    label: "Max turn wait (seconds)",
    hint:
      "An agent can be busy on one long step for a while. If it has not come back for new " +
      "instructions after this many seconds, Maestro raises an alert that it may be stuck. " +
      "The waiting instruction is kept and delivered when the agent finishes.",
  },
  {
    key: "staleness_window_secs",
    label: "Staleness window (seconds)",
    hint:
      "Maestro treats an agent as possibly dead when it has written nothing for this many " +
      "seconds. If its program has also gone, the agent is reported as dead so a replacement " +
      "can take over.",
  },
  {
    key: "handoff_retention_days",
    label: "Handoff retention (days)",
    hint:
      "Handoff notes (what an agent wrote down for its successor) are kept for this many days " +
      "after the task they belong to is finished, then deleted to save space.",
  },
  {
    key: "breaker_events",
    label: "Circuit breaker events (zero-progress trip)",
    hint:
      "A safety stop. If an agent produces this many actions in a row without committing any " +
      "new code, Maestro assumes it is going in circles, pauses it and raises an alert instead " +
      "of letting it use up your allowance.",
  },
  {
    key: "size_warn_bytes",
    label: "File size warning (bytes)",
    hint:
      "Files that Maestro keeps for you (such as the activity log) grow over time. Any file at " +
      "or above this size, in bytes, gets a warning in the Second Brain panel so you know it is " +
      "time to clear it. 1,000,000 bytes is about 1 MB.",
  },
];

/** Settings section for the Samurai supervisor thresholds (PRD §7). */
export function SamuraiSettingsPanel() {
  const [samuraiConfig, setSamuraiConfig] = useState<SamuraiConfig | null>(null);
  const [samuraiError, setSamuraiError] = useState<string | null>(null);

  useEffect(() => {
    invoke<SamuraiConfig>("samurai_get_config")
      .then(setSamuraiConfig)
      .catch((err) => setSamuraiError(String(err)));
  }, []);

  const handleSamuraiChange = (key: keyof SamuraiConfig, raw: string) => {
    setSamuraiConfig((prev) => (prev ? { ...prev, [key]: Number(raw) } : prev));
  };

  // Persist on blur: the backend validates, saves to the settings store and
  // applies to the running allowance watcher; on rejection the saved config
  // is untouched, so re-fetch to show what is actually in force.
  const handleSamuraiBlur = () => {
    if (!samuraiConfig) return;
    setSamuraiError(null);
    invoke<SamuraiConfig>("samurai_set_config", { config: samuraiConfig })
      .then(setSamuraiConfig)
      .catch((err) => {
        setSamuraiError(String(err));
        invoke<SamuraiConfig>("samurai_get_config")
          .then(setSamuraiConfig)
          .catch(() => {});
      });
  };

  return (
    <DialogSection
      title="Samurai Thresholds"
      icon={<Swords size={13} />}
      hint={SAMURAI_HINT}
      description={
        "Low values are the test mode: set a park threshold below current usage and watch " +
        "the crossing land in the audit log."
      }
    >
      {samuraiError && <div className="text-[11px] text-maestro-red">{samuraiError}</div>}
      {samuraiConfig
        ? SAMURAI_FIELDS.map(({ key, label, hint }) => (
            <DialogRow key={key} label={label} hint={hint}>
              <input
                type="number"
                value={samuraiConfig[key]}
                onChange={(e) => handleSamuraiChange(key, e.target.value)}
                onBlur={handleSamuraiBlur}
                className={`w-24 text-right ${dialogInputClass}`}
              />
            </DialogRow>
          ))
        : !samuraiError && (
            <div className="flex items-center gap-2 text-[11px] text-maestro-muted">
              <Loader2 size={11} className="animate-spin" />
              Loading...
            </div>
          )}
    </DialogSection>
  );
}
