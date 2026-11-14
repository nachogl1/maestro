import { AlertTriangle, Loader2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { DialogShell, dialogButtonClass } from "@/components/shared/DialogShell";
import { type InjectorRunResult, injectIntoAll } from "@/lib/injector";
import { projectColorFor } from "@/lib/projectColor";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { useProjectColors } from "@/lib/useProjectColors";
import { useCliSettingsStore } from "@/stores/useCliSettingsStore";
import { CONCLAVE_SENDER, recordInjectorRun } from "@/stores/useInjectedMessageStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { ConclaveInfoHover } from "./ConclaveInfoHover";
import {
  buildConclaveText,
  CONCLAVE_DEFAULT_MESSAGE,
  conclaveProjects,
  MIN_CONCLAVE_MEMBERS,
} from "./conclave";

/** Shown when a ticked agent runs with skip permissions (judged from the launch setting). */
const APPROVAL_WARNING =
  "These agents will ask you to approve each message. Set crossSessionInbound to accept in " +
  "Claude Code settings to stop that.";

export interface ConclaveDialogProps {
  onClose: () => void;
}

/**
 * The Conclave dialog (Alt+C): tick the Claude Code terminals that should
 * coordinate, adjust the message, and send it to all of them through the
 * Injector's two-frame submit. Opens with nothing ticked and the default
 * message every time; nothing is kept between openings.
 */
export function ConclaveDialog({ onClose }: ConclaveDialogProps): JSX.Element {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const parkedIds = useSessionStore((s) => s.parkedSessionIds);
  const skipsPermissions = useCliSettingsStore((s) => s.flags.Claude.skipPermissions);
  const projectColors = useProjectColors();
  const [message, setMessage] = useState(CONCLAVE_DEFAULT_MESSAGE);
  const [tickedIds, setTickedIds] = useState<number[]>([]);
  const [sending, setSending] = useState(false);
  const [lastRun, setLastRun] = useState<InjectorRunResult | null>(null);

  const projects = useMemo(() => conclaveProjects(tabs, sessions), [tabs, sessions]);

  // Ticks for terminals that have since closed are ignored, never counted.
  const ticked = useMemo(
    () =>
      projects.flatMap(({ tab, sessions: projectSessions }) =>
        projectSessions
          .filter((s) => tickedIds.includes(s.id))
          .map((s) => ({ sessionId: s.id, name: sessionDisplayName(s), project: tab.name })),
      ),
    [projects, tickedIds],
  );

  const canInvoke = ticked.length >= MIN_CONCLAVE_MEMBERS && message.trim().length > 0 && !sending;

  const toggle = (id: number): void =>
    setTickedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const tickAll = (): void => setTickedIds(projects.flatMap((p) => p.sessions.map((s) => s.id)));

  const invokeConclave = async (): Promise<void> => {
    if (!canInvoke) return;
    const targets = ticked.map(({ sessionId, name }) => ({ sessionId, name }));
    const text = buildConclaveText(message, ticked);
    setSending(true);
    try {
      const result = await injectIntoAll(targets, text);
      recordInjectorRun(targets, result, CONCLAVE_SENDER, text);
      if (result.failures.length === 0) {
        onClose();
        return;
      }
      setLastRun(result);
    } finally {
      setSending(false);
    }
  };

  return (
    <DialogShell
      title="Do you want to invoke Conclave?"
      icon={<Users size={14} />}
      titleAdornment={<ConclaveInfoHover />}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className={dialogButtonClass("ghost")}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void invokeConclave()}
            disabled={!canInvoke}
            className={dialogButtonClass("primary")}
          >
            {sending && <Loader2 size={12} className="animate-spin" />}
            Invoke Conclave
          </button>
        </>
      }
    >
      <div className="flex items-center justify-between text-[11px] text-maestro-muted">
        <span>Tick the agents that should coordinate (at least two).</span>
        {projects.length > 0 && (
          <button type="button" onClick={tickAll} className={dialogButtonClass("accent")}>
            All
          </button>
        )}
      </div>

      {projects.length === 0 ? (
        <p className="text-xs text-maestro-muted">No running Claude Code terminals</p>
      ) : (
        <div className="space-y-1.5">
          {projects.map(({ tab, sessions: projectSessions }) => {
            const color = projectColors.get(tab.name) ?? projectColorFor(tab.name);
            return (
              <div key={tab.id}>
                <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="truncate" style={{ color }}>
                    {tab.name}
                  </span>
                </div>
                {projectSessions.map((session) => {
                  const name = sessionDisplayName(session);
                  return (
                    <label
                      key={session.id}
                      className="ml-2 flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-maestro-border/30"
                    >
                      <input
                        type="checkbox"
                        className="h-3 w-3 accent-maestro-accent"
                        checked={tickedIds.includes(session.id)}
                        aria-label={name}
                        onChange={() => toggle(session.id)}
                      />
                      <span className="flex-1 truncate text-xs text-maestro-text">{name}</span>
                      {parkedIds.includes(session.id) && (
                        <span className="rounded bg-maestro-border/50 px-1 text-[9px] text-maestro-muted">
                          parked
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={7}
        aria-label="Conclave message"
        className="w-full resize-y rounded border border-maestro-border/60 bg-maestro-bg px-2 py-1.5 text-xs text-maestro-text focus:border-maestro-accent focus:outline-none"
      />
      <p className="text-[10px] text-maestro-muted">
        A line naming every ticked agent and its project is added when it is sent.
      </p>

      {skipsPermissions && ticked.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] text-maestro-yellow">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{APPROVAL_WARNING}</span>
        </p>
      )}

      {lastRun && lastRun.failures.length > 0 && (
        <output className="block text-[11px]">
          <span className="text-red-400">
            {lastRun.sent} sent, {lastRun.failures.length} failed:
          </span>
          <ul className="mt-0.5 space-y-0.5 text-maestro-muted">
            {lastRun.failures.map((f) => (
              <li key={f.sessionId} className="truncate" title={f.error}>
                {f.name} — {f.error}
              </li>
            ))}
          </ul>
        </output>
      )}
    </DialogShell>
  );
}
