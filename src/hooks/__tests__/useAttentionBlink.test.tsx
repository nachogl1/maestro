import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTENTION_BLINK_MS, useAttentionBlink } from "../useAttentionBlink";

/** Where in its blink an animation started at `startMs` with this style is at `atMs`. */
function phaseAt(startMs: number, style: React.CSSProperties | undefined, atMs: number): number {
  const delay = Number.parseFloat(String(style?.animationDelay));
  return (
    (((atMs - startMs - delay) % ATTENTION_BLINK_MS) + ATTENTION_BLINK_MS) % ATTENTION_BLINK_MS
  );
}

describe("useAttentionBlink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts tabs that start blinking at different moments on the same rhythm", () => {
    const clock = vi.spyOn(performance, "now");
    const starts = [1_000, 2_300, 7_777.5];
    const styles = starts.map((start) => {
      clock.mockReturnValue(start);
      return renderHook(() => useAttentionBlink(true)).result.current;
    });

    for (const style of styles) {
      expect(style?.animationDuration).toBe(`${ATTENTION_BLINK_MS}ms`);
    }
    for (const at of [8_000, 9_150]) {
      const phases = starts.map((start, i) => phaseAt(start, styles[i], at));
      expect(new Set(phases).size).toBe(1);
    }
  });

  it("keeps the phase it started with while it stays on, and none when off", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(500);
    const { result, rerender } = renderHook(({ on }) => useAttentionBlink(on), {
      initialProps: { on: true },
    });
    const first = result.current;

    clock.mockReturnValue(900);
    rerender({ on: true });
    expect(result.current).toBe(first);

    rerender({ on: false });
    expect(result.current).toBeUndefined();
  });
});
