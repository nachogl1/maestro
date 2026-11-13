import { useMemo } from "react";
import {
  groupTriggerHistory,
  type InjectorTrigger,
  type TriggerFiringEntry,
  type TriggerFollowUpEntry,
  type TriggerHistoryEntry,
  triggerLabel,
} from "@/lib/injectorTriggers";
import { useTriggerHistoryStore } from "@/stores/useInjectorTriggerStore";

/** The filter's value for "every trigger". */
const ALL_TRIGGERS = "all";

export interface TriggerHistoryListProps {
  /** The current triggers, offered in the filter (deleted ones come from their lines). */
  triggers: InjectorTrigger[];
  /** The trigger whose lines are shown, or null for all. */
  triggerId: string | null;
  onTriggerIdChange: (triggerId: string | null) => void;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayOf(at: number): string {
  return new Date(at).toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

/** "14:32 Compact reminder: 81%, sent to api, delivered", or which ones failed and why. */
export function firingLine(entry: TriggerFiringEntry): string {
  const { recipients } = entry;
  const failed = recipients.filter((r) => !r.delivered);
  const sentTo = recipients.length === 1 ? recipients[0].name : `${recipients.length} terminals`;
  const reasons = failed.map((r) => `${r.name}: ${r.error ?? "unknown error"}`).join("; ");
  let outcome: string;
  if (failed.length === 0) outcome = recipients.length === 1 ? "delivered" : "all delivered";
  else if (failed.length === recipients.length && recipients.length === 1)
    outcome = `failed (${reasons})`;
  else
    outcome = `${recipients.length - failed.length} delivered, ${failed.length} failed (${reasons})`;
  return `${timeOf(entry.at)} ${entry.triggerName}: ${entry.percent}%, sent to ${sentTo}, ${outcome}`;
}

/** "14:35 context dropped to 22% (worked)", naming the firing when another terminal caused it. */
export function followUpLine(entry: TriggerFollowUpEntry): string {
  const from =
    entry.firedBy === entry.terminal
      ? ""
      : `, from the ${timeOf(entry.firingAt)} firing by ${entry.firedBy}`;
  return `${timeOf(entry.at)} context dropped to ${entry.percent}% (worked${from})`;
}

function HistoryLine({ entry }: { entry: TriggerHistoryEntry }) {
  if (entry.kind === "follow_up") {
    return (
      <li className="ml-4 text-[10.5px] text-maestro-green" title={entry.triggerName}>
        {followUpLine(entry)}
      </li>
    );
  }
  const failed = entry.recipients.some((r) => !r.delivered);
  return (
    <li
      className={`ml-4 text-[10.5px] ${failed ? "text-red-400" : "text-maestro-text"}`}
      title={`“${entry.excerpt}”`}
    >
      {firingLine(entry)}
    </li>
  );
}

/**
 * The History list at the bottom of the Triggers panel: every firing and
 * follow-up line of the last week, grouped by day (newest first) and then
 * by terminal, with a trigger filter and Clear history.
 */
export function TriggerHistoryList({
  triggers,
  triggerId,
  onTriggerIdChange,
}: TriggerHistoryListProps) {
  const entries = useTriggerHistoryStore((s) => s.entries);
  const clearHistory = useTriggerHistoryStore((s) => s.clearHistory);
  const days = groupTriggerHistory(entries, { now: Date.now(), triggerId });

  // Current triggers by their label, then deleted ones by their last saved name.
  const options = useMemo(() => {
    const list = triggers.map((t) => ({ id: t.id, label: triggerLabel(t) }));
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!list.some((o) => o.id === e.triggerId)) {
        list.push({ id: e.triggerId, label: `${e.triggerName} (deleted)` });
      }
    }
    return list;
  }, [triggers, entries]);

  return (
    <section aria-label="Trigger history" className="px-1 text-[11px]">
      <div className="mb-0.5 flex items-baseline gap-1.5 text-[11px] font-bold uppercase tracking-wider text-maestro-text">
        History
        <span className="text-[10px] font-normal normal-case tracking-normal text-maestro-muted">
          · kept 1 week
        </span>
      </div>
      <div className="my-1 flex items-center gap-1.5">
        <select
          aria-label="Show the history of"
          value={triggerId ?? ALL_TRIGGERS}
          onChange={(e) =>
            onTriggerIdChange(e.target.value === ALL_TRIGGERS ? null : e.target.value)
          }
          className="min-w-0 flex-1 rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-xs text-maestro-text focus:border-maestro-accent focus:outline-none"
        >
          <option value={ALL_TRIGGERS}>All triggers</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void clearHistory()}
          disabled={entries.length === 0}
          title="Empty the history now"
          className="rounded border border-maestro-border/60 px-2.5 py-1 text-[11px] text-maestro-text hover:bg-maestro-border/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear history
        </button>
      </div>
      {days.length === 0 ? (
        <div className="mt-1.5 text-[10px] text-maestro-muted">No firings in the last week.</div>
      ) : (
        days.map((day) => {
          const label = dayOf(day.at);
          return (
            <section key={day.key} aria-label={label}>
              <div className="mt-2 font-bold">{label}</div>
              {day.groups.map((group) => (
                <ul
                  key={`${group.terminal}\u0000${group.project}`}
                  aria-label={`${group.terminal} · ${group.project}`}
                >
                  <li className="ml-2 mt-0.5 font-semibold">
                    {group.terminal}{" "}
                    <span className="font-normal text-maestro-muted">· {group.project}</span>
                  </li>
                  {group.entries.map((entry) => (
                    <HistoryLine key={entry.id} entry={entry} />
                  ))}
                </ul>
              ))}
            </section>
          );
        })
      )}
    </section>
  );
}
