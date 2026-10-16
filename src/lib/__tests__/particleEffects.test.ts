import { describe, expect, it, vi } from "vitest";
import { emitParticleEffect, subscribeParticleEffects } from "../particleEffects";
import { anchorOf, chipSelector, paneSelector, parseCssRgb } from "../particleEngine";

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
    expect(paneSelector(12)).toBe('[data-particle-session-id="12"]');
    expect(chipSelector(12)).toBe('[data-parked-session-id="12"]');
  });

  it("anchors only on panes that are on screen", () => {
    const parent = document.createElement("div");
    const pane = document.createElement("div");
    parent.appendChild(pane);
    document.body.appendChild(parent);
    pane.getBoundingClientRect = () => new DOMRect(10, 20, 100, 50);

    expect(anchorOf(pane)).toMatchObject({ x: 60, y: 45 });

    // A zoom-obscured tile keeps its full layout rect but is visibility:hidden.
    parent.style.visibility = "hidden";
    expect(anchorOf(pane)).toBeNull();

    parent.style.visibility = "";
    pane.style.visibility = "hidden";
    expect(anchorOf(pane)).toBeNull();

    parent.remove();
  });
});
