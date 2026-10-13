import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageData } from "@/lib/usageParser";

const getClaudeUsage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/usageParser", () => ({ getClaudeUsage }));

import { useUsageStore } from "../useUsageStore";

function usage(overrides: Partial<UsageData> = {}): UsageData {
  return {
    sessionPercent: 10,
    sessionResetsAt: null,
    weeklyPercent: 20,
    weeklyResetsAt: null,
    weeklyOpusPercent: null,
    weeklyOpusResetsAt: null,
    weeklySonnetPercent: null,
    weeklySonnetResetsAt: null,
    weeklyOauthAppsPercent: null,
    weeklyOauthAppsResetsAt: null,
    spendPercent: null,
    spendResetsAt: null,
    spendUsedDollars: null,
    spendLimitDollars: null,
    modelWindows: [],
    errorMessage: null,
    needsAuth: false,
    ...overrides,
  };
}

describe("useUsageStore", () => {
  let stopPolling: (() => void) | null = null;

  beforeEach(async () => {
    // The error counter that drives back-off is module-level; one successful
    // fetch zeroes it so earlier error tests do not leak into polling timing.
    useUsageStore.setState({ isLoading: false });
    getClaudeUsage.mockReset().mockResolvedValue(usage());
    await useUsageStore.getState().fetchUsage();
    getClaudeUsage.mockReset();
    useUsageStore.setState({ usage: null, isLoading: false, error: null, needsAuth: false });
  });

  afterEach(() => {
    // Releases the module-level ref count and timer so tests stay independent.
    stopPolling?.();
    stopPolling = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("fetchUsage", () => {
    it("stores the usage on success", async () => {
      const data = usage();
      getClaudeUsage.mockResolvedValue(data);
      await useUsageStore.getState().fetchUsage();
      const s = useUsageStore.getState();
      expect(s.usage).toEqual(data);
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeNull();
      expect(s.needsAuth).toBe(false);
      expect(getClaudeUsage).toHaveBeenCalledWith(false);
    });

    it("passes force through to the parser", async () => {
      getClaudeUsage.mockResolvedValue(usage());
      await useUsageStore.getState().fetchUsage(true);
      expect(getClaudeUsage).toHaveBeenCalledWith(true);
    });

    it("surfaces the parser errorMessage as error", async () => {
      getClaudeUsage.mockResolvedValue(usage({ errorMessage: "rate limited" }));
      await useUsageStore.getState().fetchUsage();
      expect(useUsageStore.getState().error).toBe("rate limited");
    });

    it("flags needsAuth and suppresses the error message", async () => {
      getClaudeUsage.mockResolvedValue(usage({ needsAuth: true, errorMessage: "log in" }));
      await useUsageStore.getState().fetchUsage();
      const s = useUsageStore.getState();
      expect(s.needsAuth).toBe(true);
      expect(s.error).toBeNull();
    });

    it("records a thrown error and clears isLoading", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      getClaudeUsage.mockRejectedValue(new Error("boom"));
      await useUsageStore.getState().fetchUsage();
      const s = useUsageStore.getState();
      expect(s.error).toBe("Error: boom");
      expect(s.isLoading).toBe(false);
    });

    it("skips the call while a fetch is in flight", async () => {
      useUsageStore.setState({ isLoading: true });
      await useUsageStore.getState().fetchUsage();
      expect(getClaudeUsage).not.toHaveBeenCalled();
    });
  });

  describe("startPolling", () => {
    it("fetches at once, then every 60s, and stops on cleanup", async () => {
      vi.useFakeTimers();
      getClaudeUsage.mockResolvedValue(usage());
      stopPolling = useUsageStore.getState().startPolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(getClaudeUsage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(getClaudeUsage).toHaveBeenCalledTimes(2);

      stopPolling();
      stopPolling = null;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(getClaudeUsage).toHaveBeenCalledTimes(2);
    });

    it("ref-counts subscribers: one timer, cleared only when the last one leaves", async () => {
      vi.useFakeTimers();
      getClaudeUsage.mockResolvedValue(usage());
      const stopA = useUsageStore.getState().startPolling();
      const stopB = useUsageStore.getState().startPolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(getClaudeUsage).toHaveBeenCalledTimes(1);

      stopA();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getClaudeUsage).toHaveBeenCalledTimes(2);

      stopB();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(getClaudeUsage).toHaveBeenCalledTimes(2);
    });

    it("backs off after an error", async () => {
      vi.useFakeTimers();
      getClaudeUsage.mockResolvedValue(usage({ errorMessage: "down" }));
      stopPolling = useUsageStore.getState().startPolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(getClaudeUsage).toHaveBeenCalledTimes(1);

      // The first timer was scheduled before the error landed: plain 60s.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getClaudeUsage).toHaveBeenCalledTimes(2);

      // The next one is scheduled with one error counted: 60s * 2^1 = 120s.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getClaudeUsage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getClaudeUsage).toHaveBeenCalledTimes(3);
    });
  });
});
