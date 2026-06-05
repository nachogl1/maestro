import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatResetTime } from "../usageParser";

describe("formatResetTime", () => {
  // Anchor "now" so relative formatting is deterministic.
  const NOW = new Date("2026-06-05T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty string for null input", () => {
    expect(formatResetTime(null)).toBe("");
  });

  it("returns 'now' when the reset time is in the past", () => {
    expect(formatResetTime("2026-06-05T11:00:00.000Z")).toBe("now");
  });

  it("returns 'now' when the reset time is exactly now", () => {
    expect(formatResetTime("2026-06-05T12:00:00.000Z")).toBe("now");
  });

  it("formats sub-hour durations in minutes", () => {
    expect(formatResetTime("2026-06-05T12:45:00.000Z")).toBe("45m");
  });

  it("formats whole-hour durations without trailing minutes", () => {
    expect(formatResetTime("2026-06-05T14:00:00.000Z")).toBe("2h");
  });

  it("formats hours with remaining minutes", () => {
    expect(formatResetTime("2026-06-05T14:30:00.000Z")).toBe("2h 30m");
  });

  it("formats whole-day durations without trailing hours", () => {
    expect(formatResetTime("2026-06-08T12:00:00.000Z")).toBe("3d");
  });

  it("formats days with remaining hours", () => {
    expect(formatResetTime("2026-06-08T17:00:00.000Z")).toBe("3d 5h");
  });

  it("returns an empty string for an unparseable date", () => {
    expect(formatResetTime("not-a-date")).toBe("");
  });
});
