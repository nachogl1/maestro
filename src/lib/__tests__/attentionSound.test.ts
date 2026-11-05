import { afterEach, describe, expect, it, vi } from "vitest";

/** Records what the tone asks of Web Audio; makes no sound. */
function installFakeAudioContext(state: "running" | "suspended" = "running") {
  const started: { frequency: number; startAt: number; stopAt: number }[] = [];
  const resume = vi.fn(async () => {});
  class FakeAudioContext {
    state = state;
    currentTime = 2;
    destination = {};
    resume = resume;
    createOscillator() {
      const osc = {
        type: "",
        frequency: {
          value: 0,
          setValueAtTime: (v: number) => {
            osc.frequency.value = v;
          },
        },
        connect: vi.fn(),
        startAt: 0,
        start: (at: number) => {
          osc.startAt = at;
        },
        stop: (at: number) => {
          started.push({ frequency: osc.frequency.value, startAt: osc.startAt, stopAt: at });
        },
      };
      return osc;
    }
    createGain() {
      return {
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      };
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return { started, resume };
}

/** A fresh copy of the module, so its cached audio context starts empty. */
async function loadModule() {
  vi.resetModules();
  return import("../attentionSound");
}

describe("playAttentionTone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("plays one short built-in tone, and one more per call", async () => {
    const { started } = installFakeAudioContext();
    const { playAttentionTone, ATTENTION_TONE_HZ, ATTENTION_TONE_SECONDS } = await loadModule();

    playAttentionTone();
    expect(started).toEqual([
      { frequency: ATTENTION_TONE_HZ, startAt: 2, stopAt: 2 + ATTENTION_TONE_SECONDS },
    ]);
    playAttentionTone();
    expect(started).toHaveLength(2);
  });

  it("wakes an audio context the webview started suspended", async () => {
    const { resume, started } = installFakeAudioContext("suspended");
    const { playAttentionTone } = await loadModule();

    playAttentionTone();

    expect(resume).toHaveBeenCalled();
    expect(started).toHaveLength(1);
  });

  it("does nothing, and never throws, where Web Audio is missing or fails", async () => {
    vi.stubGlobal("AudioContext", undefined);
    let mod = await loadModule();
    expect(() => mod.playAttentionTone()).not.toThrow();

    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("no audio device");
        }
      },
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mod = await loadModule();
    expect(() => mod.playAttentionTone()).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
