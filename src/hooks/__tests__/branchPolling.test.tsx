import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionBranch } from "@/hooks/useSessionBranch";
import { getDeduplicatedCurrentBranch } from "@/lib/git";

vi.mock("@/lib/git", () => ({ getDeduplicatedCurrentBranch: vi.fn() }));

/** Lets pending fetch promises settle and React apply the state updates. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("terminal branch polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.mocked(getDeduplicatedCurrentBranch).mockReset().mockResolvedValue("main");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("useSessionBranch: views on the same repo share one git poll", async () => {
    const views = [1, 2, 3].map(() => renderHook(() => useSessionBranch("/repo", false, null)));
    await advance(0);

    expect(getDeduplicatedCurrentBranch).toHaveBeenCalledTimes(1);
    for (const view of views) expect(view.result.current).toBe("main");

    await advance(15_000);
    expect(getDeduplicatedCurrentBranch).toHaveBeenCalledTimes(2);

    for (const view of views) view.unmount();
  });

  it("useSessionBranch: stops polling once every view unmounts", async () => {
    const a = renderHook(() => useSessionBranch("/repo", false, null));
    const b = renderHook(() => useSessionBranch("/repo", false, null));
    await advance(0);

    a.unmount();
    await advance(15_000);
    expect(getDeduplicatedCurrentBranch).toHaveBeenCalledTimes(2);

    b.unmount();
    await advance(60_000);
    expect(getDeduplicatedCurrentBranch).toHaveBeenCalledTimes(2);
  });

  it("useSessionBranch: maps a failed git read to null", async () => {
    vi.mocked(getDeduplicatedCurrentBranch).mockRejectedValue(new Error("not a repo"));
    const view = renderHook(() => useSessionBranch("/broken", false, null));
    await advance(0);

    expect(view.result.current).toBeNull();
    view.unmount();
  });
});
