import { beforeEach, describe, expect, it } from "vitest";
import { usePendingLaunchStore, type PendingLaunch } from "../usePendingLaunchStore";

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

  it("consuming one tab's entry leaves other tabs' entries untouched", () => {
    const other = launchFor("tab-2");
    usePendingLaunchStore.getState().request(launchFor("tab-1"));
    usePendingLaunchStore.getState().request(other);

    usePendingLaunchStore.getState().consume("tab-1");

    expect(usePendingLaunchStore.getState().pending).toEqual([other]);
  });
});
