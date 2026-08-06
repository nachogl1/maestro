import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import {
  earliestEntry,
  formatFireTime,
  SamuraiScheduleChip,
} from "../SamuraiScheduleChip";
import { useSessionStore, type SamuraiScheduleEntry } from "@/stores/useSessionStore";

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
    useSessionStore.setState({ samuraiSchedule: [] });
  });

  it("renders the park countdown for a project with a pending timer", () => {
    const e = entry();
    useSessionStore.setState({ samuraiSchedule: [e] });
    render(<SamuraiScheduleChip projectPath="C:/proj" />);

    // The exact HH:MM is locale/timezone-dependent — compare against the
    // same formatter the chip uses.
    expect(
      screen.getByText(`parked · resumes ${formatFireTime(e.fire_at)}`)
    ).toBeInTheDocument();
  });

  it("renders nothing without a pending timer for the project", () => {
    useSessionStore.setState({ samuraiSchedule: [entry({ project_path: "C:/other" })] });
    const { container } = render(<SamuraiScheduleChip projectPath="C:/proj" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("counts down to the EARLIEST epic when several parked", () => {
    const early = entry({ epic: "#38", fire_at: "2026-08-06T13:00:00+00:00" });
    const late = entry({ epic: "#37", fire_at: "2026-08-06T18:00:00+00:00" });
    useSessionStore.setState({ samuraiSchedule: [late, early] });
    render(<SamuraiScheduleChip projectPath="C:/proj" />);

    const chip = screen.getByText(`parked · resumes ${formatFireTime(early.fire_at)}`);
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

describe("earliestEntry / formatFireTime", () => {
  it("picks the earliest parseable fire time", () => {
    const a = entry({ epic: "a", fire_at: "2026-08-06T13:00:00+00:00" });
    const b = entry({ epic: "b", fire_at: "2026-08-06T12:00:00+00:00" });
    const bad = entry({ epic: "c", fire_at: "garbage" });
    expect(earliestEntry([a, b, bad])?.epic).toBe("b");
    // Unparseable-only lists still return an entry (the chip must show).
    expect(earliestEntry([bad])?.epic).toBe("c");
    expect(earliestEntry([])).toBeNull();
  });

  it("formats RFC 3339 to a local HH:MM and rejects garbage", () => {
    expect(formatFireTime("2026-08-06T14:32:00+00:00")).toMatch(/\d{1,2}.\d{2}/);
    expect(formatFireTime("garbage")).toBeNull();
  });
});
