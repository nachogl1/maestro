import type { CSSProperties } from "react";
import { useMemo } from "react";

/**
 * One full blink of the attention cue (on, then dim), in milliseconds. The
 * single source of the rhythm: the `.attention-blink` class in globals.css
 * reads it from the inline style this hook returns.
 */
export const ATTENTION_BLINK_MS = 1200;

/**
 * The animation delay that puts a blink starting at `nowMs` on the shared
 * clock: negative, so the animation behaves as if it had started at the last
 * whole multiple of the period. Every element that starts blinking — at any
 * moment — therefore shows the same phase at the same time.
 */
export function attentionBlinkDelayMs(nowMs: number): number {
  return -(nowMs % ATTENTION_BLINK_MS);
}

/**
 * Inline style for an element carrying the `attention-blink` class (issue
 * #496): the session tab and the project tab of a terminal that needs the
 * user blink in step, even when one of them starts later.
 *
 * Pass `blinking` exactly when the class is applied AND the element is on
 * screen: the phase is computed when it turns on, which is when the browser
 * starts the animation. An element under display:none runs no animation and
 * restarts it when shown, so a caller that can be hidden (a background
 * project's zoom strip) folds its visibility into `blinking`. The clock
 * is `performance.now()`, the same origin as the document timeline CSS
 * animations run on.
 */
export function useAttentionBlink(blinking: boolean): CSSProperties | undefined {
  return useMemo(
    () =>
      blinking
        ? {
            animationDuration: `${ATTENTION_BLINK_MS}ms`,
            animationDelay: `${attentionBlinkDelayMs(performance.now())}ms`,
          }
        : undefined,
    [blinking],
  );
}
