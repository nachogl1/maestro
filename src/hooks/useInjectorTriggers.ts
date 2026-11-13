import { useEffect } from "react";
import { sessionsForTab } from "@/hooks/useProjectStatus";
import { injectIntoAll } from "@/lib/injector";
import {
  evaluateFollowUps,
  evaluateTriggers,
  firingHistory,
  type HistoryTerminal,
  triggerRecipients,
} from "@/lib/injectorTriggers";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { recordInjectorRun, triggerSender } from "@/stores/useInjectedMessageStore";
import { useInjectorTriggerStore, useTriggerHistoryStore } from "@/stores/useInjectorTriggerStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

function newHistoryId(): string {
  return crypto.randomUUID();
}

/** The project a terminal belongs to, as its workspace tab names it. */
function projectOf(session: SessionConfig): string {
  const tab = useWorkspaceStore
    .getState()
    .tabs.find((t) => sessionsForTab(t, [session]).length > 0);
  if (tab) return tab.name;
  return session.project_path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/**
 * Fires Injector triggers: whenever a session's context usage or the trigger
 * list changes, every watched terminal that just reached its trigger's
 * threshold sends that trigger's message. Each firing and each follow-up
 * line (a recipient's context dropping again) goes to the History. Mounted
 * once by `App`.
 */
export function useInjectorTriggers(): void {
  useEffect(() => {
    const check = () => {
      const { sessions } = useSessionStore.getState();
      const history = useTriggerHistoryStore.getState();
      if (history.pending.length > 0) {
        const followUps = evaluateFollowUps(history.pending, sessions, Date.now(), newHistoryId);
        if (followUps.changed) history.setPendingFollowUps(followUps.pending);
        if (followUps.entries.length > 0) history.recordHistory(followUps.entries);
      }

      const { triggers } = useInjectorTriggerStore.getState();
      if (triggers.length === 0) return;
      const { firedIds, firings } = evaluateTriggers(triggers, sessions);
      // Record the firing before sending, so the store update this causes
      // (which re-runs `check`) sees the terminals as already fired.
      if (firedIds.size > 0) useInjectorTriggerStore.getState().setFiredIds(firedIds);

      const liveIds = sessions.map((s) => s.id);
      const terminalOf = (id: number): HistoryTerminal => {
        const session = sessions.find((s) => s.id === id);
        return session
          ? {
              id,
              name: sessionDisplayName(session),
              project: projectOf(session),
              contextPercent: session.contextPercent,
            }
          : { id, name: `Terminal ${id}`, project: "" };
      };
      for (const firing of firings) {
        const trigger = triggers.find((t) => t.id === firing.triggerId);
        if (!trigger) continue;
        const recipients = triggerRecipients(trigger, firing.reachedIds, liveIds).map(terminalOf);
        const reached = firing.reachedIds.map(terminalOf);
        const targets = recipients.map((r) => ({ sessionId: r.id, name: r.name }));
        const reachedNames = reached.map((r) => r.name);
        void injectIntoAll(targets, trigger.message).then((result) => {
          const at = Date.now();
          useInjectorTriggerStore.getState().setLastFire(trigger.id, { at, reachedNames, result });
          recordInjectorRun(targets, result, triggerSender(trigger.threshold), trigger.message);
          const { entries, pending } = firingHistory({
            trigger,
            reached,
            recipients,
            result,
            at,
            newId: newHistoryId,
          });
          const store = useTriggerHistoryStore.getState();
          store.recordHistory(entries);
          store.addPendingFollowUps(pending);
        });
      }
    };
    void useTriggerHistoryStore.getState().loadHistory();
    const unsubscribeSessions = useSessionStore.subscribe(check);
    const unsubscribeTriggers = useInjectorTriggerStore.subscribe(check);
    check();
    return () => {
      unsubscribeSessions();
      unsubscribeTriggers();
    };
  }, []);
}
