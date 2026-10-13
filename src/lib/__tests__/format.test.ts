import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAgeMs, formatBytes, formatGiB, formatIsoAge, formatTimeAgo } from "../format";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatAgeMs", () => {
  it("reads under a minute (and the future) as just now", () => {
    expect(formatAgeMs(59_999)).toBe("just now");
    expect(formatAgeMs(-5 * MIN)).toBe("just now");
    expect(formatAgeMs(0, { capitalize: true })).toBe("Just now");
  });

  it("floors minutes, hours and days by default", () => {
    expect(formatAgeMs(90_000)).toBe("1m ago");
    expect(formatAgeMs(59 * MIN + 59_000)).toBe("59m ago");
    expect(formatAgeMs(HOUR)).toBe("1h ago");
    expect(formatAgeMs(23 * HOUR + 59 * MIN)).toBe("23h ago");
    expect(formatAgeMs(10 * DAY)).toBe("10d ago");
  });

  it("rounds to the nearest unit when asked", () => {
    expect(formatAgeMs(29_000, { rounding: "nearest" })).toBe("just now");
    expect(formatAgeMs(90_000, { rounding: "nearest" })).toBe("2m ago");
    expect(formatAgeMs(89 * MIN, { rounding: "nearest" })).toBe("1h ago");
    expect(formatAgeMs(23 * HOUR + 50 * MIN, { rounding: "nearest" })).toBe("1d ago");
  });

  it("reads weeks, months and years only with longUnits", () => {
    expect(formatAgeMs(6 * DAY, { longUnits: true })).toBe("6d ago");
    expect(formatAgeMs(14 * DAY, { longUnits: true })).toBe("2w ago");
    expect(formatAgeMs(65 * DAY, { longUnits: true })).toBe("2mo ago");
    expect(formatAgeMs(400 * DAY, { longUnits: true })).toBe("1y ago");
    expect(formatAgeMs(400 * DAY)).toBe("400d ago");
  });
});

describe("formatTimeAgo / formatIsoAge", () => {
  const NOW = new Date("2026-10-13T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a missing timestamp as never, in the caller's casing", () => {
    expect(formatTimeAgo(null)).toBe("never");
    expect(formatTimeAgo(null, { capitalize: true })).toBe("Never");
  });

  it("measures an epoch-ms timestamp against now", () => {
    expect(formatTimeAgo(NOW - 5 * MIN)).toBe("5m ago");
    expect(formatTimeAgo(NOW - 3 * HOUR)).toBe("3h ago");
    expect(formatTimeAgo(NOW - 10_000, { capitalize: true })).toBe("Just now");
  });

  it("returns empty for a missing or unparsable ISO time", () => {
    expect(formatIsoAge(null)).toBe("");
    expect(formatIsoAge("")).toBe("");
    expect(formatIsoAge("not-a-date")).toBe("");
  });

  it("measures an ISO time against now", () => {
    expect(formatIsoAge(new Date(NOW - 2 * DAY).toISOString())).toBe("2d ago");
  });
});

describe("formatBytes", () => {
  it("defaults to B / KB / MB", () => {
    expect(formatBytes(800)).toBe("800 B");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(6.2 * 1024 * 1024)).toBe("6.2 MB");
  });

  it("with minUnit KB, rounds non-empty sizes up to at least 1 KB", () => {
    expect(formatBytes(0, { minUnit: "KB" })).toBe("0 KB");
    expect(formatBytes(1, { minUnit: "KB" })).toBe("1 KB");
    expect(formatBytes(3 * 1024, { minUnit: "KB" })).toBe("3 KB");
    expect(formatBytes(1.2 * 1024 * 1024, { minUnit: "KB" })).toBe("1.2 MB");
  });

  it("with maxUnit KB, never switches to MB", () => {
    expect(formatBytes(2 * 1024 * 1024, { minUnit: "KB", maxUnit: "KB" })).toBe("2048 KB");
  });
});

describe("formatGiB", () => {
  it("keeps one decimal below 10 GiB and none above", () => {
    expect(formatGiB(7.5 * 1024 ** 3)).toBe("7.5");
    expect(formatGiB(16 * 1024 ** 3)).toBe("16");
  });
});
