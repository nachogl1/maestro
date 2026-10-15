import { describe, expect, it, vi } from "vitest";
import { emitParticleEffect, subscribeParticleEffects } from "../particleEffects";
import { chipSelector, paneSelector, parseCssRgb } from "../particleEngine";

describe("particleEffects bus", () => {
  it("delivers an effect to every subscriber and stops after unsubscribe", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeParticleEffects(a);
    const unsubB = subscribeParticleEffects(b);

    emitParticleEffect({ kind: "park", sessionId: 7 });
    expect(a).toHaveBeenCalledWith({ kind: "park", sessionId: 7 });
    expect(b).toHaveBeenCalledWith({ kind: "park", sessionId: 7 });

    unsubA();
    emitParticleEffect({ kind: "resume", sessionId: 7 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    unsubB();
  });

  it("is a no-op with nobody listening", () => {
    expect(() => emitParticleEffect({ kind: "attention", sessionId: 1 })).not.toThrow();
  });
});

describe("particleEngine helpers", () => {
  it("parses computed rgb() colours into 0..1 triples", () => {
    expect(parseCssRgb("rgb(255, 0, 128)")).toEqual([1, 0, 128 / 255]);
    expect(parseCssRgb("rgba(0, 0, 0, 0.5)")).toEqual([0, 0, 0]);
    expect(parseCssRgb("transparent")).toBeNull();
  });

  it("targets the pane and shelf chip by their session id", () => {
    expect(paneSelector(12)).toBe('[data-session-id="12"]');
    expect(chipSelector(12)).toBe('[data-parked-session-id="12"]');
  });
});
