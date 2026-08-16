import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { formatCountdown, formatFireDateTime } from "@/lib/parkTime";
import { type SamuraiScheduleEntry, useSessionStore } from "@/stores/useSessionStore";
import { earliestEntry, SamuraiScheduleChip } from "../SamuraiScheduleChip";

/** Fixed clock, so every countdown assertion below is exact. */
const NOW = new Date("2026-08-06T10:00:00+00:00");

function entry(overrides: Partial<SamuraiScheduleEntry> = {}): SamuraiScheduleEntry {
  return {
    project_path: "C:/proj",
    epic: "#37",
    fire_at: "2026-08-06T14:32:00+00:00",
    reason: "park",
    ...overrides,
  };
}

describe("SamuraiScheduleChip (issue #61)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useSessionStore.setState({ samuraiSchedule: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the park countdown for a project with a pending timer", () => {
    const e = entry();
    useSessionStore.setState({ samuraiSchedule: [e] });
    render(<SamuraiScheduleChip projectPath="C:/proj" />);

    // The exact date/time rendering is locale/timezone-dependent — compare
    // against the same formatter the chip uses. The countdown is not: it is
    // computed off the fixed clock above.
    expect(screen.getByText(/^parked · resumes /).textContent).toBe(
      `parked · resumes ${formatFireDateTime(e.fire_at)} · in 4h 32m`,
    );
  });

  it("dates the reading, so a week-out park cannot read as this afternoon", () => {
    // The 7-day allowance window is what parks most runs: a bare `HH:MM` said
    // "09:05" for a resume a whole week away.
    const e = entry({ fire_at: "2026-08-13T09:05:00+00:00" });
    useSessionStore.setState({ samuraiSchedule: [e] });
    render(<SamuraiScheduleChip projectPath="C:/proj" />);

    const chip = screen.getByText(/^parked · resumes /);
    expect(chip.textContent).toContain(formatFireDateTime(e.fire_at));
    expect(chip.textContent).toContain("in 6d 23h 5m");
  });

  it("keeps the countdown live while it is mounted", () => {
    useSessionStore.setState({ samuraiSchedule: [entry()] });
    render(<SamuraiScheduleChip projectPath="C:/proj" />);
    expect(screen.getByText(/in 4h 32m/)).toBeInTheDocument();

    // A minute passes with nothing else happening — the chip must not sit
    // frozen on the reading it mounted with.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/in 4h 31m/)).toBeInTheDocument();
  });

  it("renders nothing without a pending timer for the project", () => {
    useSessionStore.setState({ samuraiSchedule: [entry({ project_path: "C:/other" })] });
    const { container } = render(<SamuraiScheduleChip projectPath="C:/proj" />);

    expect(container).toBeEmptyDOMElement();
  });

  // Issue #129's scheduled-launch timers share the schedule list but are NOT
  // parks: one would paint "parked · resumes 09:00 — work resumes
  // automatically" on a project that has no run at all, and a held (overdue)
  // one would count down into the past.
  it("ignores scheduled-launch timers — they are not parks", () => {
    useSessionStore.setState({
      samuraiSchedule: [entry({ reason: "scheduled_launch" })],
    });
    const { container } = render(<SamuraiScheduleChip projectPath="C:/proj" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("counts down to a real park while a scheduled launch is also armed", () => {
    const park = entry({ epic: "#37", fire_at: "2026-08-06T18:00:00+00:00" });
    // Earlier than the park: an unfiltered chip would count down to THIS.
    const scheduled = entry({
      epic: "#99",
      fire_at: "2026-08-06T13:00:00+00:00",
      reason: "scheduled_launch",
    });
    useSessionStore.setState({ samuraiSchedule: [scheduled, park] });
    render(<SamuraiScheduleChip projectPath="C:/proj" />);

    const chip = screen.getByText(/^parked · resumes /);
    expect(chip.textContent).toContain(formatFireDateTime(park.fire_at));
    expect(chip.getAttribute("title")).not.toContain("#99");
  });

  it("counts down to the EARLIEST epic when several parked", () => {
    const early = entry({ epic: "#38", fire_at: "2026-08-06T13:00:00+00:00" });
    const late = entry({ epic: "#37", fire_at: "2026-08-06T18:00:00+00:00" });
    useSessionStore.setState({ samuraiSchedule: [late, early] });
    render(<SamuraiScheduleChip projectPath="C:/proj" />);

    const chip = screen.getByText(/^parked · resumes /);
    expect(chip.textContent).toContain(formatFireDateTime(early.fire_at));
    // The title still lists every parked epic.
    expect(chip.getAttribute("title")).toContain("#37");
    expect(chip.getAttribute("title")).toContain("#38");
  });

  it("still shows 'parked' when the fire time does not parse", () => {
    useSessionStore.setState({ samuraiSchedule: [entry({ fire_at: "garbage" })] });
    render(<SamuraiScheduleChip projectPath="C:/proj" />);

    expect(screen.getByText("parked")).toBeInTheDocument();
  });

  it("matches project paths tolerantly (separators, case)", () => {
    useSessionStore.setState({ samuraiSchedule: [entry({ project_path: "C:/proj" })] });
    // JSX string attributes don't process JS escapes — pass an expression so
    // the chip really receives the backslash spelling `C:\proj`.
    render(<SamuraiScheduleChip projectPath={"C:\\proj"} />);

    expect(screen.getByText(/parked/)).toBeInTheDocument();
  });

  it("disappears live when the last timer fires (empty schedule event)", () => {
    useSessionStore.setState({ samuraiSchedule: [entry()] });
    const { container } = render(<SamuraiScheduleChip projectPath="C:/proj" />);
    expect(screen.getByText(/parked/)).toBeInTheDocument();

    act(() => {
      useSessionStore.setState({ samuraiSchedule: [] });
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("earliestEntry / park time formatting", () => {
  it("picks the earliest parseable fire time", () => {
    const a = entry({ epic: "a", fire_at: "2026-08-06T13:00:00+00:00" });
    const b = entry({ epic: "b", fire_at: "2026-08-06T12:00:00+00:00" });
    const bad = entry({ epic: "c", fire_at: "garbage" });
    expect(earliestEntry([a, b, bad])?.epic).toBe("b");
    // Unparseable-only lists still return an entry (the chip must show).
    expect(earliestEntry([bad])?.epic).toBe("c");
    expect(earliestEntry([])).toBeNull();
  });

  it("formats RFC 3339 to a local date + time and rejects garbage", () => {
    const formatted = formatFireDateTime("2026-08-06T14:32:00+00:00");
    // Locale-dependent, but it always carries a date AND a time — the whole
    // point is that the day is no longer implied.
    expect(formatted).toMatch(/\d{1,2}.\d{1,2}.\d{2}/);
    expect(formatted).toMatch(/\d{1,2}.\d{2}/);
    expect(formatFireDateTime("garbage")).toBeNull();
  });

  it("counts down in d/h/m and never shows a negative one", () => {
    const now = new Date("2026-08-06T10:00:00+00:00").getTime();
    expect(formatCountdown("2026-08-13T13:07:00+00:00", now)).toBe("in 7d 3h 7m");
    // Leading units are dropped when zero, not padded in…
    expect(formatCountdown("2026-08-06T13:07:00+00:00", now)).toBe("in 3h 7m");
    expect(formatCountdown("2026-08-06T10:07:00+00:00", now)).toBe("in 7m");
    // …but a unit below a bigger one is kept, so the shape stays readable.
    expect(formatCountdown("2026-08-13T10:00:00+00:00", now)).toBe("in 7d 0h 0m");
    expect(formatCountdown("2026-08-06T10:00:30+00:00", now)).toBe("in <1m");
    // The fire event and a render race by design — never a negative reading.
    expect(formatCountdown("2026-08-06T09:00:00+00:00", now)).toBe("due now");
    expect(formatCountdown("garbage", now)).toBeNull();
  });
});
