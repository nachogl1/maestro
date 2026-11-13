import { Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { sessionsForTab } from "@/hooks/useProjectStatus";
import {
  type InjectorTrigger,
  type InjectorTriggerTarget,
  type InjectorTriggerWatch,
  triggerLabel,
  watchedIds,
} from "@/lib/injectorTriggers";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { parseContextAlertThreshold } from "@/stores/useContextAlertStore";
import { useInjectorStore } from "@/stores/useInjectorStore";
import {
  type InjectorTriggerInput,
  useInjectorTriggerStore,
} from "@/stores/useInjectorTriggerStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** Percent a new trigger starts with. */
const DEFAULT_TRIGGER_THRESHOLD = "80";

/** Wording of each "send the message to" choice, shared by the form and the rows. */
const TARGET_LABELS: Record<InjectorTriggerTarget, string> = {
  reached: "only that terminal",
  all: "every terminal it watches",
};

/** Shown on a ticked trigger none of whose terminals is open (always so after a restart). */
const WATCHES_NOTHING = "watches nothing, edit to pick terminals";

const inputClass =
  "rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-xs text-maestro-text placeholder:text-maestro-muted/70 focus:border-maestro-accent focus:outline-none";

const smallButtonClass =
  "rounded border border-maestro-border/60 px-2.5 py-1 text-[11px] text-maestro-text hover:bg-maestro-border/30 disabled:cursor-not-allowed disabled:opacity-40";

/** An open terminal as the watched-terminals list names it, e.g. "api · shop". */
interface LiveTerminal {
  id: number;
  label: string;
}

/** What the add and edit forms hold while the person types. */
interface TriggerFormValues {
  name: string;
  watch: InjectorTriggerWatch;
  threshold: string;
  target: InjectorTriggerTarget;
  message: string;
}

const EMPTY_FORM: TriggerFormValues = {
  name: "",
  watch: "ticked",
  threshold: DEFAULT_TRIGGER_THRESHOLD,
  target: "reached",
  message: "",
};

function formValuesOf(trigger: InjectorTrigger): TriggerFormValues {
  return {
    name: trigger.name,
    watch: trigger.watch,
    threshold: String(trigger.threshold),
    target: trigger.target,
    message: trigger.message,
  };
}

/**
 * Triggers, under the Injector: watch every terminal or the ones ticked in the
 * Injector above and, when one of them reaches a chosen context percent, send
 * a message automatically (see `useInjectorTriggers`). Triggers are saved
 * across restarts (`useInjectorTriggerStore`).
 */
export function InjectorTriggersSection() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const selectedIds = useInjectorStore((s) => s.selectedIds);
  const triggers = useInjectorTriggerStore((s) => s.triggers);
  const addTrigger = useInjectorTriggerStore((s) => s.addTrigger);
  const updateTrigger = useInjectorTriggerStore((s) => s.updateTrigger);
  const removeTrigger = useInjectorTriggerStore((s) => s.removeTrigger);
  const [editingId, setEditingId] = useState<string | null>(null);

  const liveTerminals = useMemo<LiveTerminal[]>(
    () =>
      tabs.flatMap((tab) =>
        sessionsForTab(tab, sessions).map((s) => ({
          id: s.id,
          label: `${sessionDisplayName(s)} · ${tab.name}`,
        })),
      ),
    [tabs, sessions],
  );
  const tickedIds = useMemo(
    () => liveTerminals.filter((t) => selectedIds.includes(t.id)).map((t) => t.id),
    [liveTerminals, selectedIds],
  );

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
          {triggers.map((trigger) =>
            editingId === trigger.id ? (
              <li
                key={trigger.id}
                aria-label={`Edit ${triggerLabel(trigger)}`}
                className="rounded border border-maestro-accent/50 px-1.5 py-1"
              >
                <TriggerForm
                  mode="edit"
                  initial={formValuesOf(trigger)}
                  tickedIds={tickedIds}
                  onSubmit={(input) => {
                    updateTrigger(trigger.id, input);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <TriggerRow
                key={trigger.id}
                trigger={trigger}
                liveTerminals={liveTerminals}
                onEdit={() => setEditingId(trigger.id)}
                onRemove={() => removeTrigger(trigger.id)}
              />
            ),
          )}
        </ul>
      )}

      <div className="my-2 h-px bg-maestro-border/30" />
      <TriggerForm mode="add" initial={EMPTY_FORM} tickedIds={tickedIds} onSubmit={addTrigger} />
    </div>
  );
}

/** The add form, and the same form filled in when a row is edited. */
function TriggerForm({
  mode,
  initial,
  tickedIds,
  onSubmit,
  onCancel,
}: {
  mode: "add" | "edit";
  initial: TriggerFormValues;
  tickedIds: number[];
  onSubmit: (input: InjectorTriggerInput) => void;
  onCancel?: () => void;
}) {
  const formId = useId();
  const [values, setValues] = useState<TriggerFormValues>(initial);
  const update = (change: Partial<TriggerFormValues>) => setValues((v) => ({ ...v, ...change }));

  const threshold = parseContextAlertThreshold(values.threshold);
  const needsTicks = values.watch === "ticked" && tickedIds.length === 0;
  const canSubmit = values.message.trim().length > 0 && threshold !== null && !needsTicks;

  const handleSubmit = () => {
    if (!canSubmit || threshold === null) return;
    onSubmit({
      name: values.name,
      watch: values.watch,
      watchIds: tickedIds,
      threshold,
      message: values.message,
      target: values.target,
    });
    if (mode === "add") update({ name: "", message: "" });
  };

  return (
    <div className="space-y-1.5 px-1 text-[11px] text-maestro-text">
      <div className="flex items-center gap-1.5">
        <label htmlFor={`${formId}-name`} className="w-14 shrink-0 text-maestro-muted">
          Name
        </label>
        <input
          id={`${formId}-name`}
          type="text"
          value={values.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="optional"
          className={`${inputClass} min-w-0 flex-1`}
        />
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${formId}-watch-label`}
        className="flex items-start gap-1.5"
      >
        <span id={`${formId}-watch-label`} className="w-14 shrink-0 text-maestro-muted">
          Watch
        </span>
        <div className="flex flex-col gap-0.5">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${formId}-watch`}
              checked={values.watch === "all"}
              onChange={() => update({ watch: "all" })}
            />
            All terminals, also new ones
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${formId}-watch`}
              checked={values.watch === "ticked"}
              onChange={() => update({ watch: "ticked" })}
            />
            Only the ones ticked above ({tickedIds.length})
          </label>
        </div>
      </div>
      {needsTicks && (
        <p className="text-maestro-muted">Tick terminals in the Injector above to watch them.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={`${formId}-threshold`}>When a terminal reaches</label>
        <input
          id={`${formId}-threshold`}
          type="number"
          min={1}
          max={100}
          value={values.threshold}
          onChange={(e) => update({ threshold: e.target.value })}
          className={`${inputClass} w-14`}
        />
        <span>% context,</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={`${formId}-target`}>send the message to</label>
        <select
          id={`${formId}-target`}
          value={values.target}
          onChange={(e) => update({ target: e.target.value as InjectorTriggerTarget })}
          className={`${inputClass} min-w-0 flex-1`}
        >
          <option value="reached">{TARGET_LABELS.reached}</option>
          <option value="all">{TARGET_LABELS.all}</option>
        </select>
      </div>
      <label htmlFor={`${formId}-message`} className="block text-maestro-muted">
        Message
      </label>
      <textarea
        id={`${formId}-message`}
        value={values.message}
        onChange={(e) => update({ message: e.target.value })}
        rows={2}
        placeholder="Message to send when the trigger fires…"
        className={`${inputClass} w-full resize-y`}
      />
      {mode === "add" ? (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-maestro-accent/60 px-2 py-1.5 text-xs font-semibold text-maestro-accent transition-colors hover:bg-maestro-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={12} />
          Add trigger
        </button>
      ) : (
        <div className="flex justify-end gap-1.5">
          <button type="button" onClick={onCancel} className={smallButtonClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`${smallButtonClass} border-maestro-accent/60 text-maestro-accent`}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function TriggerRow({
  trigger,
  liveTerminals,
  onEdit,
  onRemove,
}: {
  trigger: InjectorTrigger;
  liveTerminals: LiveTerminal[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const label = triggerLabel(trigger);
  const watched = watchedIds(
    trigger,
    liveTerminals.map((t) => t.id),
  );
  const fire = trigger.lastFire;
  return (
    <li
      aria-label={label}
      className="relative rounded border border-maestro-border/50 px-1.5 py-1 text-[11px]"
    >
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 truncate font-semibold text-maestro-text" title={label}>
          {label}
        </div>
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit trigger"
          title="Edit trigger"
          className="rounded p-0.5 text-maestro-muted hover:bg-maestro-border/30 hover:text-maestro-text"
        >
          <Pencil size={12} />
        </button>
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
      <div className="text-maestro-muted">
        At {trigger.threshold}% → {TARGET_LABELS[trigger.target]}
      </div>
      <div className="my-0.5 flex items-center gap-1">
        <span>Watches</span>
        {trigger.watch === "ticked" && watched.length === 0 ? (
          <span className="rounded-full border border-amber-500/60 px-1.5 text-[10px] text-amber-400">
            {WATCHES_NOTHING}
          </span>
        ) : (
          <WatchedPill
            watch={trigger.watch}
            terminals={liveTerminals.filter((t) => watched.includes(t.id))}
          />
        )}
      </div>
      <div className="truncate text-maestro-text/80" title={trigger.message}>
        “{trigger.message}”
      </div>
      {fire ? (
        <div
          className={`text-[10px] ${fire.result.failures.length === 0 ? "text-maestro-green" : "text-red-400"}`}
          title={fire.result.failures.map((f) => `${f.name}: ${f.error}`).join("\n") || undefined}
        >
          Last fired{" "}
          {new Date(fire.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} by{" "}
          {fire.reachedNames.join(", ")}: sent to {fire.result.sent}
          {fire.result.failures.length > 0 ? `, ${fire.result.failures.length} failed` : ""}
        </div>
      ) : (
        <div className="text-[10px] text-maestro-muted">Not fired yet</div>
      )}
    </li>
  );
}

/** "all terminals" or "3 terminals"; a click lists the terminals it watches now. */
function WatchedPill({
  watch,
  terminals,
}: {
  watch: InjectorTriggerWatch;
  terminals: LiveTerminal[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  const pillText =
    watch === "all"
      ? "all terminals"
      : `${terminals.length} terminal${terminals.length === 1 ? "" : "s"}`;
  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="rounded-full border border-maestro-accent/50 px-1.5 text-[10px] text-maestro-accent hover:bg-maestro-accent/10"
      >
        {pillText}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 min-w-[150px] rounded border border-maestro-border bg-maestro-surface px-2 py-1 shadow-lg">
          <div className="text-[10px] text-maestro-muted">
            {watch === "all" ? "All terminals open now:" : "Watches:"}
          </div>
          {terminals.length === 0 ? (
            <div className="text-maestro-muted">No terminal is open</div>
          ) : (
            <ul aria-label="Watched terminals">
              {terminals.map((t) => (
                <li key={t.id}>{t.label}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </span>
  );
}
