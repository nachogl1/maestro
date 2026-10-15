import { Loader2, Send, Syringe } from "lucide-react";
import { useCallback, useMemo } from "react";
import { sessionsForTab } from "@/hooks/useProjectStatus";
import { injectIntoAll } from "@/lib/injector";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { useInjectorStore } from "@/stores/useInjectorStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { badgeBaseClass, cardClass, SESSION_STATUS_BADGES, SectionHeader } from "./sectionChrome";

/** Display name of a terminal row: its agent/session name, else "Terminal N". */
export function sessionDisplayName(session: SessionConfig): string {
  return session.name?.trim() || `Terminal ${session.id}`;
}

/**
 * Injector tab: tick any of the terminals Maestro is running (across every
 * project), type one message, and it is typed and submitted into all of them
 * at the same time. Delivery is the backend's two-frame submit (body, then a
 * lone Enter after a settle gap), the same path `/rename` takes.
 */
export function InjectorSection() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const sessions = useSessionStore((s) => s.sessions);
  const projectColors = useProjectColors();
  const message = useInjectorStore((s) => s.message);
  const selectedIds = useInjectorStore((s) => s.selectedIds);
  const lastRun = useInjectorStore((s) => s.lastRun);
  const injecting = useInjectorStore((s) => s.injecting);
  const setMessage = useInjectorStore((s) => s.setMessage);
  const toggleSession = useInjectorStore((s) => s.toggleSession);
  const setSelected = useInjectorStore((s) => s.setSelected);

  const projects = useMemo(
    () =>
      tabs
        .map((tab) => ({ tab, sessions: sessionsForTab(tab, sessions) }))
        .filter((p) => p.sessions.length > 0),
    [tabs, sessions],
  );

  // Ticks for terminals that have since closed are ignored, never counted.
  const liveSessions = useMemo(() => projects.flatMap((p) => p.sessions), [projects]);
  const liveSelected = useMemo(
    () => liveSessions.filter((s) => selectedIds.includes(s.id)),
    [liveSessions, selectedIds],
  );

  const canInject = liveSelected.length > 0 && message.trim().length > 0 && !injecting;

  const handleInject = useCallback(async () => {
    const store = useInjectorStore.getState();
    const text = store.message;
    const targets = liveSessions
      .filter((s) => store.selectedIds.includes(s.id))
      .map((s) => ({ sessionId: s.id, name: sessionDisplayName(s) }));
    if (targets.length === 0 || text.trim().length === 0 || store.injecting) return;
    store.setInjecting(true);
    try {
      const result = await injectIntoAll(targets, text);
      useInjectorStore.getState().setLastRun(result);
      // A clean run clears the box like a sent chat message; any failure
      // keeps the text so it can be re-sent to the terminals that missed it.
      if (result.failures.length === 0) useInjectorStore.getState().setMessage("");
    } finally {
      useInjectorStore.getState().setInjecting(false);
    }
  }, [liveSessions]);

  const selectProject = useCallback(
    (projectSessions: SessionConfig[], select: boolean) => {
      const ids = projectSessions.map((s) => s.id);
      setSelected(
        select ? [...selectedIds, ...ids] : selectedIds.filter((id) => !ids.includes(id)),
      );
    },
    [selectedIds, setSelected],
  );

  return (
    <div className={cardClass}>
      <SectionHeader
        icon={Syringe}
        label="Injector"
        iconColor="text-maestro-accent"
        badge={
          liveSelected.length > 0 ? (
            <span
              className="rounded-full bg-maestro-accent/20 px-1.5 text-[10px] font-bold text-maestro-accent"
              title={`${liveSelected.length} terminal${liveSelected.length === 1 ? "" : "s"} selected`}
            >
              {liveSelected.length}
            </span>
          ) : undefined
        }
        right={
          liveSessions.length > 0 ? (
            <span className="flex gap-1 text-[10px] font-normal normal-case tracking-normal">
              <button
                type="button"
                className="text-maestro-muted hover:text-maestro-text"
                onClick={() => setSelected(liveSessions.map((s) => s.id))}
              >
                All
              </button>
              <span className="text-maestro-muted/50">·</span>
              <button
                type="button"
                className="text-maestro-muted hover:text-maestro-text"
                onClick={() => setSelected([])}
              >
                None
              </button>
            </span>
          ) : undefined
        }
      />
      <p className="mb-1.5 px-1 text-[10px] text-maestro-muted">
        Tick terminals, type once, and the message is sent to all of them with Enter.
      </p>

      {projects.length === 0 ? (
        <p className="px-1 py-0.5 text-[11px] text-maestro-muted">No running terminals</p>
      ) : (
        projects.map(({ tab, sessions: projectSessions }) => {
          const color = projectColors.get(tab.name) ?? projectColorFor(tab.name);
          const allTicked = projectSessions.every((s) => selectedIds.includes(s.id));
          return (
            <div key={tab.id} className="mt-1">
              <label className="flex cursor-pointer items-center gap-1.5 px-1 text-[11px] font-semibold">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-maestro-accent"
                  checked={allTicked}
                  aria-label={`Select all terminals in ${tab.name}`}
                  onChange={(e) => selectProject(projectSessions, e.target.checked)}
                />
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="truncate" style={{ color }}>
                  {tab.name}
                </span>
              </label>
              {projectSessions.map((session) => {
                const badge = SESSION_STATUS_BADGES[session.status] ?? SESSION_STATUS_BADGES.Idle;
                const name = sessionDisplayName(session);
                return (
                  <label
                    key={session.id}
                    className="ml-2 flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-maestro-border/30"
                  >
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-maestro-accent"
                      checked={selectedIds.includes(session.id)}
                      aria-label={name}
                      onChange={() => toggleSession(session.id)}
                    />
                    <span className="flex-1 truncate text-xs text-maestro-text">{name}</span>
                    <span className="text-[9px] text-maestro-muted">{session.mode}</span>
                    <span className={`${badgeBaseClass} ${badge.cls}`}>{badge.label}</span>
                  </label>
                );
              })}
            </div>
          );
        })
      )}

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter sends; plain Enter keeps editing (multi-line messages).
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void handleInject();
          }
        }}
        rows={3}
        placeholder="Message for the ticked terminals… (Ctrl+Enter to send)"
        aria-label="Message to inject"
        className="mt-2 w-full resize-y rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1.5 text-xs text-maestro-text placeholder:text-maestro-muted/70 focus:border-maestro-accent focus:outline-none"
      />

      <button
        type="button"
        onClick={() => void handleInject()}
        disabled={!canInject}
        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded bg-maestro-accent px-2 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {injecting ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
        {injecting
          ? "Injecting…"
          : `Inject into ${liveSelected.length} terminal${liveSelected.length === 1 ? "" : "s"}`}
      </button>

      {lastRun && (
        <output className="mt-1.5 block px-1 text-[10px]">
          {lastRun.failures.length === 0 ? (
            <span className="text-maestro-green">
              Sent to {lastRun.sent} terminal{lastRun.sent === 1 ? "" : "s"}.
            </span>
          ) : (
            <>
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
            </>
          )}
        </output>
      )}
    </div>
  );
}
