import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedPoller } from "../sharedPoller";

const INTERVAL_MS = 1_000;

/** Lets the fetcher's promise chain settle under fake timers. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("createSharedPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs one fetch per tick for many subscribers of the same key", async () => {
    const poller = createSharedPoller<string>(INTERVAL_MS);
    const fetcher = vi.fn().mockResolvedValue("main");
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();

    poller.subscribe("repo", fetcher, a, true);
    poller.subscribe("repo", fetcher, b, true);
    poller.subscribe("repo", fetcher, c, true);
    await flush();

    // Subscribing while the first fetch is in flight joins it.
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const listener of [a, b, c]) expect(listener).toHaveBeenCalledWith("main");

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const listener of [a, b, c]) expect(listener).toHaveBeenCalledTimes(2);
  });

  it("polls different keys independently", async () => {
    const poller = createSharedPoller<string>(INTERVAL_MS);
    const fetchA = vi.fn().mockResolvedValue("a");
    const fetchB = vi.fn().mockResolvedValue("b");

    poller.subscribe("repo-a", fetchA, vi.fn(), true);
    poller.subscribe("repo-b", fetchB, vi.fn(), true);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(fetchA).toHaveBeenCalledTimes(2);
    expect(fetchB).toHaveBeenCalledTimes(2);
  });

  it("keeps polling until the last subscriber leaves, then stops", async () => {
    const poller = createSharedPoller<string>(INTERVAL_MS);
    const fetcher = vi.fn().mockResolvedValue("main");
    const first = vi.fn();
    const second = vi.fn();

    const unsubFirst = poller.subscribe("repo", fetcher, first, true);
    const unsubSecond = poller.subscribe("repo", fetcher, second, true);
    await flush();

    unsubFirst();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    unsubSecond();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not deliver a fetch that lands after unsubscribing", async () => {
    const poller = createSharedPoller<string>(INTERVAL_MS);
    let resolve: (value: string) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const listener = vi.fn();

    const unsub = poller.subscribe("repo", fetcher, listener, true);
    unsub();
    resolve("main");
    await flush();

    expect(listener).not.toHaveBeenCalled();
  });

  it("only fetches for active subscribers, but shares results with inactive ones", async () => {
    const poller = createSharedPoller<string>(INTERVAL_MS);
    const fetcher = vi.fn().mockResolvedValue("main");
    const inactive = vi.fn();

    poller.subscribe("repo", fetcher, inactive, false);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(fetcher).not.toHaveBeenCalled();

    poller.subscribe("repo", fetcher, vi.fn(), true);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(inactive).toHaveBeenCalledWith("main");
  });

  it("skips ticks while the window is blurred", async () => {
    const poller = createSharedPoller<string>(INTERVAL_MS);
    const fetcher = vi.fn().mockResolvedValue("main");

    poller.subscribe("repo", fetcher, vi.fn(), true);
    await flush();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
