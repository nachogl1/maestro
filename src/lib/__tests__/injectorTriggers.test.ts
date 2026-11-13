import { describe, expect, it } from "vitest";
import type { InjectorRunResult } from "@/lib/injector";
import {
  evaluateFollowUps,
  evaluateTriggers,
  firingHistory,
  groupTriggerHistory,
  HISTORY_EXCERPT_CHARS,
  type InjectorTrigger,
  messageExcerpt,
  parseSavedTriggers,
  parseTriggerHistory,
  TRIGGER_HISTORY_KEEP_MS,
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

describe("trigger history", () => {
  const AT = new Date(2026, 10, 8, 14, 32).getTime();
  const ids = () => {
    let n = 0;
    return () => `h${++n}`;
  };
  const api = { id: 1, name: "api", project: "shop", contextPercent: 81.4 };
  const ui = { id: 2, name: "ui", project: "shop", contextPercent: 40 };
  const docs = { id: 3, name: "docs", project: "site" };

  function fire(result: InjectorRunResult = { sent: 3, failures: [] }) {
    return firingHistory({
      trigger: buildTrigger({ id: "t1", name: "Compact reminder", threshold: 80 }),
      reached: [api],
      recipients: [api, ui, docs],
      result,
      at: AT,
      newId: ids(),
    });
  }

  const docsFailed: InjectorRunResult = {
    sent: 2,
    failures: [{ sessionId: 3, name: "docs", error: "terminal closed" }],
  };

  it("records a firing with every field, and which recipients failed and why", () => {
    expect(fire(docsFailed).entries).toEqual([
      {
        kind: "firing",
        id: "h1",
        at: AT,
        triggerId: "t1",
        triggerName: "Compact reminder",
        terminal: "api",
        project: "shop",
        percent: 81,
        excerpt: "write a handoff",
        recipients: [
          { name: "api", delivered: true },
          { name: "ui", delivered: true },
          { name: "docs", delivered: false, error: "terminal closed" },
        ],
      },
    ]);
  });

  it("keeps only a short one-line excerpt of the message", () => {
    expect(messageExcerpt("  run\n  /compact  ")).toBe("run /compact");
    const long = messageExcerpt("word ".repeat(40));
    expect(long).toHaveLength(HISTORY_EXCERPT_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("writes one follow-up line per delivered recipient once its context drops", () => {
    const { pending } = fire(docsFailed);
    // The failed recipient waits for nothing.
    expect(pending.map((p) => p.sessionId)).toEqual([1, 2]);

    // api is still over the threshold and ui has not dropped: nothing yet.
    let step = evaluateFollowUps(
      pending,
      [
        { id: 1, contextPercent: 85 },
        { id: 2, contextPercent: 45 },
      ],
      AT + 1,
      ids(),
    );
    expect(step.entries).toEqual([]);
    expect(step.changed).toBe(false);

    // api drops below the threshold (the re-arm); ui drops after a /compact.
    step = evaluateFollowUps(
      pending,
      [
        { id: 1, contextPercent: 22 },
        { id: 2, contextPercent: 15 },
      ],
      AT + 60_000,
      ids(),
    );
    expect(step.entries).toEqual([
      expect.objectContaining({
        kind: "follow_up",
        terminal: "api",
        project: "shop",
        percent: 22,
        firingId: "h1",
        firedBy: "api",
      }),
      expect.objectContaining({ terminal: "ui", percent: 15, firingId: "h1", firedBy: "api" }),
    ]);
    // One line each: nothing is left to follow up.
    expect(step.pending).toEqual([]);
  });

  it("waits for a recipient's first usage, and forgets a closed one", () => {
    const docsPending = fire().pending.filter((p) => p.sessionId === 3);
    expect(docsPending[0].baseline).toBeNull();

    const noUsage = evaluateFollowUps(docsPending, [{ id: 3 }], AT, ids());
    expect(noUsage).toEqual({ entries: [], pending: docsPending, changed: false });

    const firstUsage = evaluateFollowUps(docsPending, [{ id: 3, contextPercent: 30 }], AT, ids());
    expect(firstUsage.entries).toEqual([]);
    expect(firstUsage.pending[0].baseline).toBe(30);

    expect(evaluateFollowUps(docsPending, [], AT, ids())).toEqual({
      entries: [],
      pending: [],
      changed: true,
    });
  });

  function firingAt(id: string, at: number, terminal: string, triggerId = "t1") {
    return {
      kind: "firing" as const,
      id,
      at,
      triggerId,
      triggerName: "Compact reminder",
      terminal,
      project: "shop",
      percent: 80,
      excerpt: "run /compact",
      recipients: [{ name: terminal, delivered: true }],
    };
  }

  it("groups by day newest first, then by terminal, a follow-up under its firing", () => {
    const sunday = new Date(2026, 10, 8, 14, 32).getTime();
    const saturday = new Date(2026, 10, 7, 9, 10).getTime();
    const followUp = {
      ...firingAt("u1", sunday + 3 * 60_000, "api"),
      kind: "follow_up" as const,
      firingId: "f2",
      firingAt: sunday,
      firedBy: "api",
    };
    const days = groupTriggerHistory(
      [
        firingAt("f1", saturday, "docs"),
        firingAt("f3", sunday - 3 * 3_600_000, "ui", "t2"),
        firingAt("f2", sunday, "api"),
        followUp,
      ],
      { now: sunday + 3_600_000, triggerId: null },
    );
    expect(days.map((d) => d.groups.map((g) => [g.terminal, g.entries.map((e) => e.id)]))).toEqual([
      [
        ["api", ["f2", "u1"]],
        ["ui", ["f3"]],
      ],
      [["docs", ["f1"]]],
    ]);

    const onlyT2 = groupTriggerHistory(
      [firingAt("f2", sunday, "api"), firingAt("f3", sunday, "ui", "t2")],
      { now: sunday, triggerId: "t2" },
    );
    expect(onlyT2.flatMap((d) => d.groups.map((g) => g.terminal))).toEqual(["ui"]);
  });

  it("keeps one terminal name in two projects as two groups", () => {
    const at = new Date(2026, 10, 8, 10, 0).getTime();
    const days = groupTriggerHistory(
      [firingAt("a", at, "claude"), { ...firingAt("b", at + 1, "claude"), project: "site" }],
      { now: at, triggerId: null },
    );
    expect(days[0].groups.map((g) => `${g.terminal} · ${g.project}`)).toEqual([
      "claude · site",
      "claude · shop",
    ]);
  });

  it("leaves out lines older than seven days", () => {
    const now = new Date(2026, 10, 13, 12, 0).getTime();
    const days = groupTriggerHistory(
      [
        firingAt("old", now - TRIGGER_HISTORY_KEEP_MS - 1, "api"),
        firingAt("kept", now - TRIGGER_HISTORY_KEEP_MS, "api"),
      ],
      { now, triggerId: null },
    );
    expect(days.flatMap((d) => d.groups.flatMap((g) => g.entries.map((e) => e.id)))).toEqual([
      "kept",
    ]);
  });

  it("reads only well-shaped entries from the backend", () => {
    const good = firingAt("f1", AT, "api");
    expect(
      parseTriggerHistory([
        good,
        null,
        7,
        { ...good, id: 3 },
        { ...good, kind: "other" },
        { ...good, recipients: [null] },
        { ...good, recipients: undefined },
      ]),
    ).toEqual([good]);
    expect(parseTriggerHistory(undefined)).toEqual([]);
    expect(parseTriggerHistory({ entries: [good] })).toEqual([]);
  });
});
