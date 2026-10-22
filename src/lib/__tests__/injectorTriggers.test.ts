import { describe, expect, it } from "vitest";
import { evaluateTriggers, type InjectorTrigger, triggerRecipients } from "../injectorTriggers";

function buildTrigger(overrides: Partial<InjectorTrigger> = {}): InjectorTrigger {
  return {
    id: "t1",
    watchIds: [1, 2],
    threshold: 60,
    message: "write a handoff",
    target: "all",
    firedIds: [],
    lastFire: null,
    ...overrides,
  };
}

describe("evaluateTriggers", () => {
  it("fires for a watched terminal that reached the threshold", () => {
    const result = evaluateTriggers(
      [buildTrigger()],
      [
        { id: 1, contextPercent: 61 },
        { id: 2, contextPercent: 20 },
      ],
    );
    expect(result.firings).toEqual([{ triggerId: "t1", reachedIds: [1] }]);
    expect(result.firedIds.get("t1")).toEqual([1]);
  });

  it("compares the whole percent the badge shows", () => {
    const result = evaluateTriggers([buildTrigger()], [{ id: 1, contextPercent: 59.6 }]);
    expect(result.firings).toHaveLength(1);
  });

  it("ignores terminals that are not watched or have no usage yet", () => {
    const result = evaluateTriggers([buildTrigger()], [{ id: 2 }, { id: 3, contextPercent: 99 }]);
    expect(result.firings).toEqual([]);
    expect(result.firedIds.size).toBe(0);
  });

  it("does not fire again while the terminal stays over the threshold", () => {
    const result = evaluateTriggers(
      [buildTrigger({ firedIds: [1] })],
      [{ id: 1, contextPercent: 75 }],
    );
    expect(result.firings).toEqual([]);
    expect(result.firedIds.size).toBe(0);
  });

  it("re-arms once the context drops below the threshold (e.g. after /clear)", () => {
    const trigger = buildTrigger({ firedIds: [1] });
    const dropped = evaluateTriggers([trigger], [{ id: 1 }]);
    expect(dropped.firedIds.get("t1")).toEqual([]);
    expect(dropped.firings).toEqual([]);

    const again = evaluateTriggers([{ ...trigger, firedIds: [] }], [{ id: 1, contextPercent: 60 }]);
    expect(again.firings).toEqual([{ triggerId: "t1", reachedIds: [1] }]);
  });

  it("forgets a fired terminal that has closed", () => {
    const result = evaluateTriggers([buildTrigger({ firedIds: [2] })], []);
    expect(result.firedIds.get("t1")).toEqual([]);
  });
});

describe("triggerRecipients", () => {
  it("sends to every open watched terminal when the target is all", () => {
    expect(triggerRecipients(buildTrigger(), [1], [1, 2, 3])).toEqual([1, 2]);
  });

  it("sends only to the terminals that reached it when the target is reached", () => {
    expect(triggerRecipients(buildTrigger({ target: "reached" }), [2], [1, 2, 3])).toEqual([2]);
  });
});
