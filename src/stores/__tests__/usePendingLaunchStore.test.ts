import { beforeEach, describe, expect, it } from "vitest";
import {
  type PendingLaunch,
  pendingLaunchImminent,
  usePendingLaunchStore,
} from "../usePendingLaunchStore";

function launchFor(tabId: string, resumeSessionId?: string): PendingLaunch {
  return {
    tabId,
    mode: "Claude",
    resumeSessionId: resumeSessionId ?? "11111111-2222-3333-4444-555555555555",
    workingDirOverride: null,
    branch: null,
  };
}

describe("usePendingLaunchStore", () => {
  beforeEach(() => {
    usePendingLaunchStore.setState({ pending: [] });
  });

  it("consume returns and clears the pending launch for the matching tab", () => {
    const launch = launchFor("tab-1");
    usePendingLaunchStore.getState().request(launch);

    const consumed = usePendingLaunchStore.getState().consume("tab-1");

    expect(consumed).toEqual(launch);
    expect(usePendingLaunchStore.getState().pending).toEqual([]);
  });

  it("consume for a different tab returns null and keeps the request queued", () => {
    const launch = launchFor("tab-1");
    usePendingLaunchStore.getState().request(launch);

    expect(usePendingLaunchStore.getState().consume("tab-2")).toBeNull();
    expect(usePendingLaunchStore.getState().pending).toEqual([launch]);
  });

  it("consume with nothing queued returns null", () => {
    expect(usePendingLaunchStore.getState().consume("tab-1")).toBeNull();
  });

  // Fresh-eyes finding B: the store is a FIFO queue, not a single slot — a
  // second request must never silently destroy an unconsumed first one.
  it("keeps concurrent requests for different tabs (two epics, one tick)", () => {
    usePendingLaunchStore.getState().request(launchFor("tab-1"));
    usePendingLaunchStore.getState().request(launchFor("tab-2"));

    expect(usePendingLaunchStore.getState().consume("tab-1")).toMatchObject({ tabId: "tab-1" });
    expect(usePendingLaunchStore.getState().consume("tab-2")).toMatchObject({ tabId: "tab-2" });
    expect(usePendingLaunchStore.getState().pending).toEqual([]);
  });

  it("consume takes the oldest matching entry first (FIFO within a tab)", () => {
    const first = launchFor("tab-1", "aaaaaaaa-0000-0000-0000-000000000001");
    const second = launchFor("tab-1", "aaaaaaaa-0000-0000-0000-000000000002");
    usePendingLaunchStore.getState().request(first);
    usePendingLaunchStore.getState().request(second);

    expect(usePendingLaunchStore.getState().consume("tab-1")).toEqual(first);
    expect(usePendingLaunchStore.getState().consume("tab-1")).toEqual(second);
    expect(usePendingLaunchStore.getState().consume("tab-1")).toBeNull();
  });

  // The old single-slot store accidentally deduped a rapid double-request
  // (History-tab double-click → the same session resumed twice); the queue
  // restores that on purpose while keeping distinct launches.
  it("drops an exact duplicate of an unconsumed request", () => {
    const launch = launchFor("tab-1");
    usePendingLaunchStore.getState().request(launch);
    usePendingLaunchStore.getState().request(launchFor("tab-1"));

    expect(usePendingLaunchStore.getState().pending).toEqual([launch]);

    usePendingLaunchStore.getState().consume("tab-1");
    expect(usePendingLaunchStore.getState().consume("tab-1")).toBeNull();
  });

  // Issue #98: two identical "Harvest now" clicks are ONE launch (the store
  // is the double-click guard), but a harvest launch never dedupes against a
  // plain launch that happens to match on every other field.
  it("dedupes identical harvest requests but not harvest-vs-plain", () => {
    const plain: PendingLaunch = { ...launchFor("tab-1"), resumeSessionId: null };
    const harvest: PendingLaunch = { ...plain, harvest: true };
    usePendingLaunchStore.getState().request(harvest);
    usePendingLaunchStore.getState().request({ ...harvest });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(1);

    usePendingLaunchStore.getState().request(plain);
    expect(usePendingLaunchStore.getState().pending).toHaveLength(2);
  });

  // Generic initial-prompt launches: two identical requests are ONE launch
  // (the store is the double-click guard), but two launches carrying
  // DIFFERENT prompts must both queue — deduping them would silently drop a
  // prompt the user asked for.
  it("dedupes identical initialPrompt requests but queues different prompts", () => {
    const plain: PendingLaunch = { ...launchFor("tab-1"), resumeSessionId: null };
    const prompted: PendingLaunch = { ...plain, initialPrompt: "review the diff" };
    usePendingLaunchStore.getState().request(prompted);
    usePendingLaunchStore.getState().request({ ...prompted });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(1);

    usePendingLaunchStore.getState().request({ ...plain, initialPrompt: "run the tests" });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(2);

    // A prompted launch never dedupes against an otherwise identical plain one.
    usePendingLaunchStore.getState().request(plain);
    expect(usePendingLaunchStore.getState().pending).toHaveLength(3);
  });

  // Review finding C11: the de-dup compared neither the brief target nor the
  // PR record, so two PR reviews differing only in where their brief lands —
  // or in which review they record — silently collapsed into one launch.
  it("queues launches that differ only in brief target or PR record", () => {
    const base: PendingLaunch = {
      ...launchFor("tab-1"),
      resumeSessionId: null,
      initialPrompt: "review the PR",
      briefDir: "C:/git/maestro",
      briefStem: "pr-1-check-aaaaaaaa",
    };
    const record = {
      pr: 1,
      title: "one",
      repo: "nachogl1/maestro",
      project_path: "C:/git/maestro",
      steps: ["check"],
    };
    const store = usePendingLaunchStore.getState();

    store.request(base);
    store.request({ ...base });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(1);

    store.request({ ...base, briefStem: "pr-1-check-review-bbbbbbbb" });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(2);

    store.request({ ...base, briefDir: "C:/git/other" });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(3);

    store.request({ ...base, prRun: record });
    store.request({ ...base, prRun: { ...record } });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(4);

    store.request({ ...base, prRun: { ...record, pr: 2 } });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(5);

    store.request({ ...base, prRun: { ...record, project_path: "C:/git/other" } });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(6);

    store.request({ ...base, prRun: { ...record, steps: ["check", "review"] } });
    expect(usePendingLaunchStore.getState().pending).toHaveLength(7);
  });

  it("consuming one tab's entry leaves other tabs' entries untouched", () => {
    const other = launchFor("tab-2");
    usePendingLaunchStore.getState().request(launchFor("tab-1"));
    usePendingLaunchStore.getState().request(other);

    usePendingLaunchStore.getState().consume("tab-1");

    expect(usePendingLaunchStore.getState().pending).toEqual([other]);
  });
});

// The last-slot guard in TerminalGrid: the grid must not drop to the landing
// view (unmounting itself) while a launch for it is queued or already claimed.
describe("pendingLaunchImminent", () => {
  it.each([
    ["nothing queued, nothing claimed (a normal last-slot close)", [], 0, "tab-1", false],
    ["a launch queued for this tab", [launchFor("tab-1")], 0, "tab-1", true],
    ["a launch queued for another tab only", [launchFor("tab-2")], 0, "tab-1", false],
    ["a launch this grid has claimed", [], 1, "tab-1", true],
    ["a claimed launch, even without a tab id", [], 1, undefined, true],
    ["a queued launch, but no tab id to match it", [launchFor("tab-1")], 0, undefined, false],
  ] as const)("%s", (_label, queued, claimed, tabId, expected) => {
    expect(pendingLaunchImminent(queued, claimed, tabId)).toBe(expected);
  });
});
