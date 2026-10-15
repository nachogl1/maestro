import { describe, expect, it } from "vitest";
import {
  daysBetween,
  defaultWorkJournalTitle,
  isValidJournalDate,
  isWeekend,
  localDateString,
  msUntilNextLocalMidnight,
} from "../workJournalDates";

describe("workJournalDates", () => {
  it("builds the local date, not the UTC one", () => {
    // 00:30 local on 15 Oct is still 14 Oct in UTC east of Greenwich; the
    // local parts must win either way.
    expect(localDateString(new Date(2026, 9, 15, 0, 30))).toBe("2026-10-15");
    expect(localDateString(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("formats the default title like the backend", () => {
    expect(defaultWorkJournalTitle("2026-10-14")).toBe("Wed 14 Oct 2026");
    expect(defaultWorkJournalTitle("2026-11-01")).toBe("Sun 1 Nov 2026");
  });

  it("validates calendar dates", () => {
    expect(isValidJournalDate("2026-02-28")).toBe(true);
    expect(isValidJournalDate("2026-02-30")).toBe(false);
    expect(isValidJournalDate("")).toBe(false);
  });

  it("knows weekends and day distances", () => {
    expect(isWeekend("2026-10-17")).toBe(true);
    expect(isWeekend("2026-10-18")).toBe(true);
    expect(isWeekend("2026-10-19")).toBe(false);
    expect(daysBetween("2026-10-14", "2026-10-11")).toBe(3);
  });

  it("measures the time to the next local midnight", () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 9, 14, 23, 59, 0))).toBe(60_000);
  });
});
