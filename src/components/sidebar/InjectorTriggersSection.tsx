import { Plus, Trash2, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { sessionsForTab } from "@/hooks/useProjectStatus";
import type { InjectorTrigger, InjectorTriggerTarget } from "@/lib/injectorTriggers";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { parseContextAlertThreshold } from "@/stores/useContextAlertStore";
import { useInjectorStore } from "@/stores/useInjectorStore";
import { useInjectorTriggerStore } from "@/stores/useInjectorTriggerStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** Percent a new trigger starts with. */
const DEFAULT_TRIGGER_THRESHOLD = "80";

const inputClass =
  "rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-xs text-maestro-text placeholder:text-maestro-muted/70 focus:border-maestro-accent focus:outline-none";

/**
 * Triggers, under the Injector: watch the terminals ticked in the Injector
 * above and, when one of them reaches a chosen context percent, send a
 * message automatically (see `useInjectorTriggers`).
 */
export function InjectorTriggersSection() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const selectedIds = useInjectorStore((s) => s.selectedIds);
  const triggers = useInjectorTriggerStore((s) => s.triggers);
  const addTrigger = useInjectorTriggerStore((s) => s.addTrigger);
  const removeTrigger = useInjectorTriggerStore((s) => s.removeTrigger);

  const [threshold, setThreshold] = useState(DEFAULT_TRIGGER_THRESHOLD);
  const [target, setTarget] = useState<InjectorTriggerTarget>("all");
  const [message, setMessage] = useState("");

  const liveSessions = useMemo(
    () => tabs.flatMap((tab) => sessionsForTab(tab, sessions)),
    [tabs, sessions],
  );
  const watchIds = useMemo(
    () => liveSessions.filter((s) => selectedIds.includes(s.id)).map((s) => s.id),
    [liveSessions, selectedIds],
  );

  const parsedThreshold = parseContextAlertThreshold(threshold);
  const canAdd = watchIds.length > 0 && message.trim().length > 0 && parsedThreshold !== null;

  const handleAdd = () => {
    if (!canAdd || parsedThreshold === null) return;
    addTrigger({ watchIds, threshold: parsedThreshold, message, target });
    setMessage("");
  };

  return (
    <div className={`${cardClass} mt-3`}>
      <SectionHeader
        icon={Zap}
        label="Triggers"
        iconColor="text-maestro-accent"
        badge={
          triggers.length > 0 ? (
            <span className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent">
              {triggers.length}
            </span>
          ) : undefined
        }
      />
      <p className="mb-1.5 px-1 text-[10px] text-maestro-muted">
        When a watched terminal's context reaches the level, the message is sent once. It is sent
        again only after that terminal's context drops below the level (for example after /clear).
      </p>

      {triggers.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {triggers.map((trigger) => (
            <TriggerRow
              key={trigger.id}
              trigger={trigger}
              sessions={sessions}
              onRemove={() => removeTrigger(trigger.id)}
            />
          ))}
        </ul>
      )}

      <p className="px-1 text-[11px] text-maestro-text">
        {watchIds.length === 0
          ? "Tick terminals in the Injector above to watch them."
          : `Watch the ${watchIds.length} terminal${watchIds.length === 1 ? "" : "s"} ticked above.`}
      </p>
      <div className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-maestro-muted">
        <label htmlFor="injector-trigger-threshold">At context</label>
        <input
          id="injector-trigger-threshold"
          type="number"
          min={1}
          max={100}
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          className={`${inputClass} w-14`}
        />
        <span>%, send to</span>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as InjectorTriggerTarget)}
          aria-label="Send the message to"
          className={`${inputClass} min-w-0 flex-1`}
        >
          <option value="all">all watched terminals</option>
          <option value="reached">only the one that reached it</option>
        </select>
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
        placeholder="Message to send when the trigger fires…"
        aria-label="Trigger message"
        className={`${inputClass} mt-1.5 w-full resize-y`}
      />
      <button
        type="button"
        onClick={handleAdd}
        disabled={!canAdd}
        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded border border-maestro-accent/60 px-2 py-1.5 text-xs font-semibold text-maestro-accent transition-colors hover:bg-maestro-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus size={12} />
        Add trigger
      </button>
    </div>
  );
}

function TriggerRow({
  trigger,
  sessions,
  onRemove,
}: {
  trigger: InjectorTrigger;
  sessions: SessionConfig[];
  onRemove: () => void;
}) {
  const watched = sessions.filter((s) => trigger.watchIds.includes(s.id));
  const names = watched.map(sessionDisplayName);
  const fire = trigger.lastFire;
  return (
    <li className="rounded border border-maestro-border/50 px-1.5 py-1 text-[11px]">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-maestro-text">
            At {trigger.threshold}% →{" "}
            {trigger.target === "all" ? "all watched" : "the one that reached it"}
          </div>
          <div className="truncate text-maestro-muted" title={names.join(", ")}>
            {names.length === 0 ? "No watched terminal is open" : `Watches ${names.join(", ")}`}
          </div>
          <div className="truncate text-maestro-text/80" title={trigger.message}>
            “{trigger.message}”
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Delete trigger"
          title="Delete trigger"
          className="rounded p-0.5 text-maestro-muted hover:bg-maestro-border/30 hover:text-red-400"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {fire && (
        <div
          className={`mt-0.5 text-[10px] ${fire.result.failures.length === 0 ? "text-maestro-green" : "text-red-400"}`}
          title={fire.result.failures.map((f) => `${f.name}: ${f.error}`).join("\n") || undefined}
        >
          Fired {new Date(fire.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
          by {fire.reachedNames.join(", ")}: sent to {fire.result.sent}
          {fire.result.failures.length > 0 ? `, ${fire.result.failures.length} failed` : ""}.
        </div>
      )}
    </li>
  );
}
