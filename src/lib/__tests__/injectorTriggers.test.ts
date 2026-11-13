import { describe, expect, it } from "vitest";
import {
  evaluateTriggers,
  type InjectorTrigger,
  parseSavedTriggers,
  toSavedTrigger,
  triggerLabel,
  triggerRecipients,
  watchedIds,
} from "../injectorTriggers";

function buildTrigger(overrides: Partial<InjectorTrigger> = {}): InjectorTrigger {
  return {
    id: "t1",
    name: "",
    watch: "ticked",
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

  it("watches every terminal, also one opened after it was made, when it watches all", () => {
    const trigger = buildTrigger({ watch: "all", watchIds: [] });
    const result = evaluateTriggers([trigger], [{ id: 7, contextPercent: 65 }]);
    expect(result.firings).toEqual([{ triggerId: "t1", reachedIds: [7] }]);
  });
});

describe("watchedIds", () => {
  it("is every open terminal for an all-terminals trigger and the open ticked ones otherwise", () => {
    expect(watchedIds(buildTrigger({ watch: "all", watchIds: [] }), [1, 5, 9])).toEqual([1, 5, 9]);
    expect(watchedIds(buildTrigger({ watchIds: [2, 4] }), [1, 2, 3])).toEqual([2]);
  });
});

describe("triggerLabel", () => {
  it.each([
    { name: "Compact reminder", message: "Run /compact now", label: "Compact reminder" },
    { name: "   ", message: "Run /compact before you continue", label: "Run /compact before you…" },
    { name: "", message: "  /clear  ", label: "/clear" },
    { name: "", message: "one two three four", label: "one two three four" },
  ])("names $label for name '$name'", ({ name, message, label }) => {
    expect(triggerLabel({ name, message })).toBe(label);
  });
});

describe("triggerRecipients", () => {
  it("sends to every open watched terminal when the target is all", () => {
    expect(triggerRecipients(buildTrigger(), [1], [1, 2, 3])).toEqual([1, 2]);
  });

  it("sends only to the terminals that reached it when the target is reached", () => {
    expect(triggerRecipients(buildTrigger({ target: "reached" }), [2], [1, 2, 3])).toEqual([2]);
  });

  it("sends to every open terminal when an all-terminals trigger targets all", () => {
    expect(triggerRecipients(buildTrigger({ watch: "all" }), [1], [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("saved triggers", () => {
  it("saves what defines a trigger and loads it back re-armed, watching no old terminal", () => {
    const trigger = buildTrigger({
      name: "Compact reminder",
      watchIds: [1, 2],
      firedIds: [1],
      lastFire: { at: 1, reachedNames: ["alpha"], result: { sent: 1, failures: [] } },
    });
    const saved = JSON.parse(JSON.stringify([toSavedTrigger(trigger)]));
    expect(parseSavedTriggers(saved)).toEqual([
      { ...trigger, watchIds: [], firedIds: [], lastFire: null },
    ]);
  });

  it.each([
    { what: "nothing saved", raw: undefined },
    { what: "null", raw: null },
    { what: "an object instead of a list", raw: { id: "t1" } },
    { what: "a string", raw: "trigger" },
  ])("loads no trigger from $what", ({ raw }) => {
    expect(parseSavedTriggers(raw)).toEqual([]);
  });

  it("skips broken entries and keeps the good ones", () => {
    const good = { id: "ok", name: "", watch: "all", threshold: 80, message: "m", target: "all" };
    const loaded = parseSavedTriggers([
      null,
      7,
      "trigger",
      [],
      { ...good, id: "" },
      { ...good, id: 12 },
      { ...good, id: "no-message", message: "   " },
      { ...good, id: "message-not-text", message: 5 },
      { ...good, id: "threshold-text", threshold: "80" },
      { ...good, id: "threshold-nan", threshold: null },
      good,
      { ...good, message: "a duplicate of ok" },
    ]);
    expect(loaded.map((t) => t.id)).toEqual(["ok"]);
    expect(loaded[0].message).toBe("m");
  });

  it("fills an old or odd entry with safe values", () => {
    const [loaded] = parseSavedTriggers([
      {
        id: "old",
        watchIds: [1, 2],
        firedIds: [1],
        threshold: 250.4,
        message: "hand off",
        target: "everyone",
        watch: "some",
        name: 3,
      },
    ]);
    expect(loaded).toEqual({
      id: "old",
      name: "",
      watch: "ticked",
      watchIds: [],
      threshold: 100,
      message: "hand off",
      target: "reached",
      firedIds: [],
      lastFire: null,
    });
  });
});
