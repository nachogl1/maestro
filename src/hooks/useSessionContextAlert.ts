import {
  describeContextAlert,
  isContextAlert,
  useContextAlertStore,
} from "@/stores/useContextAlertStore";
import { useSessionStore } from "@/stores/useSessionStore";

/**
 * Whether one terminal is past the context alert threshold picked in Settings,
 * plus the hover text that says so ("Context 87% ≥ 80% alert"). Used by every
 * small stand-in for a terminal frame (zoom strip tabs) so they blink in step
 * with the frame itself. A null session id (pre-launch slot) never alerts.
 */
export function useSessionContextAlert(sessionId: number | null): {
  active: boolean;
  title: string | null;
} {
  const contextPercent = useSessionStore((s) =>
    sessionId === null ? undefined : s.sessions.find((x) => x.id === sessionId)?.contextPercent,
  );
  const threshold = useContextAlertStore((s) => s.threshold);
  const active = isContextAlert(contextPercent, threshold);
  const title =
    active && contextPercent !== undefined && threshold !== null
      ? describeContextAlert(contextPercent, threshold)
      : null;
  return { active, title };
}
