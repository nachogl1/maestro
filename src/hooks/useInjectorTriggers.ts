import { useEffect } from "react";
import { injectIntoAll } from "@/lib/injector";
import { evaluateTriggers, triggerRecipients } from "@/lib/injectorTriggers";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { useInjectorTriggerStore } from "@/stores/useInjectorTriggerStore";
import { useSessionStore } from "@/stores/useSessionStore";

/**
 * Fires Injector triggers: whenever a session's context usage or the trigger
 * list changes, every watched terminal that just reached its trigger's
 * threshold sends that trigger's message. Mounted once by `App`.
 */
export function useInjectorTriggers(): void {
  useEffect(() => {
    const check = () => {
      const { triggers } = useInjectorTriggerStore.getState();
      if (triggers.length === 0) return;
      const { sessions } = useSessionStore.getState();
      const { firedIds, firings } = evaluateTriggers(triggers, sessions);
      // Record the firing before sending, so the store update this causes
      // (which re-runs `check`) sees the terminals as already fired.
      if (firedIds.size > 0) useInjectorTriggerStore.getState().setFiredIds(firedIds);

      const liveIds = sessions.map((s) => s.id);
      const nameOf = (id: number) => {
        const session = sessions.find((s) => s.id === id);
        return session ? sessionDisplayName(session) : `Terminal ${id}`;
      };
      for (const firing of firings) {
        const trigger = triggers.find((t) => t.id === firing.triggerId);
        if (!trigger) continue;
        const targets = triggerRecipients(trigger, firing.reachedIds, liveIds).map((id) => ({
          sessionId: id,
          name: nameOf(id),
        }));
        const reachedNames = firing.reachedIds.map(nameOf);
        void injectIntoAll(targets, trigger.message).then((result) =>
          useInjectorTriggerStore
            .getState()
            .setLastFire(trigger.id, { at: Date.now(), reachedNames, result }),
        );
      }
    };
    const unsubscribeSessions = useSessionStore.subscribe(check);
    const unsubscribeTriggers = useInjectorTriggerStore.subscribe(check);
    check();
    return () => {
      unsubscribeSessions();
      unsubscribeTriggers();
    };
  }, []);
}
