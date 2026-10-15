/**
 * Injector sidebar tab: send one message to many running terminals at once.
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * Types `text` into Maestro terminal `sessionId` and presses Enter.
 * Resolves once the text has reached the terminal; the Enter follows on its
 * own after a short settle gap (same two-frame delivery as `/rename`).
 */
export function injectMessage(sessionId: number, text: string): Promise<void> {
  return invoke("inject_message", { sessionId, text });
}

/** One terminal's outcome from an injector run. */
export interface InjectorFailure {
  sessionId: number;
  name: string;
  error: string;
}

/** What the last Inject click did, shown under the button. */
export interface InjectorRunResult {
  sent: number;
  failures: InjectorFailure[];
}

/**
 * Sends `text` to every target and collects the outcome; one failed terminal
 * never stops the others.
 */
export async function injectIntoAll(
  targets: { sessionId: number; name: string }[],
  text: string,
): Promise<InjectorRunResult> {
  const settled = await Promise.allSettled(targets.map((t) => injectMessage(t.sessionId, text)));
  const failures: InjectorFailure[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      const reason = outcome.reason;
      failures.push({
        sessionId: targets[i].sessionId,
        name: targets[i].name,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });
  return { sent: targets.length - failures.length, failures };
}
