import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The session store subscribes to Tauri events at listener-init time; the
// global setup already mocks @tauri-apps/api/core, event needs its own stub.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { formatFireDateTime } from "@/lib/parkTime";
import { type SamuraiParkAlert, useSessionStore } from "@/stores/useSessionStore";
import { ParkedRunsBadge, soonestPark } from "../ParkedRunsBadge";

/** Fixed clock, so every countdown assertion below is exact. */
const NOW = new Date("2026-08-06T10:00:00+00:00");

function alert(overrides: Partial<SamuraiParkAlert> = {}): SamuraiParkAlert {
  return {
    key: "c:/proj|#37|2026-08-13T09:05:00+00:00",
    project: "C:/proj",
    epic: "#37",
    fireAt: "2026-08-13T09:05:00+00:00",
    acknowledged: false,
    ...overrides,
  };
}

describe("ParkedRunsBadge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useSessionStore.setState({ samuraiParkAlerts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing while nothing is parked", () => {
    const { container } = render(<ParkedRunsBadge />);

    expect(container).toBeEmptyDOMElement();
  });

  it("counts the parked runs and counts down to the earliest resume", () => {
    useSessionStore.setState({
      samuraiParkAlerts: [
        alert({ epic: "#37", fireAt: "2026-08-13T09:05:00+00:00" }),
        alert({ key: "b", epic: "#42", fireAt: "2026-08-08T09:05:00+00:00" }),
      ],
    });

    render(<ParkedRunsBadge />);

    expect(screen.getByText("2 parked · resumes in 1d 23h 5m")).toBeInTheDocument();
  });

  it("lists project, epic and a DATED resume time in the tooltip", () => {
    useSessionStore.setState({ samuraiParkAlerts: [alert()] });

    render(<ParkedRunsBadge />);

    const title = screen.getByRole("button").getAttribute("title") ?? "";
    expect(title).toContain("proj · #37 · ");
    // A week-out park must never read as a bare time-of-day.
    expect(title).toContain(formatFireDateTime("2026-08-13T09:05:00+00:00") ?? "");
    expect(title).toContain("in 6d 23h 5m");
  });

  it("shines until acknowledged, then stays legible", () => {
    useSessionStore.setState({ samuraiParkAlerts: [alert()] });
    const onNavigate = vi.fn();

    render(<ParkedRunsBadge onNavigate={onNavigate} />);
    expect(screen.getByRole("button").className).toContain("samurai-park-shine");

    // Clicking is the acknowledgement, and it takes the user to the project.
    fireEvent.click(screen.getByRole("button"));
    expect(onNavigate).toHaveBeenCalledWith("C:/proj");
    const button = screen.getByRole("button");
    expect(button.className).not.toContain("samurai-park-shine");
    expect(button.textContent).toContain("1 parked");
  });

  it("keeps the countdown live while it is mounted", () => {
    useSessionStore.setState({ samuraiParkAlerts: [alert()] });

    render(<ParkedRunsBadge />);
    expect(screen.getByText(/in 6d 23h 5m/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/in 6d 23h 4m/)).toBeInTheDocument();
  });

  it("still shows the count when the fire time does not parse", () => {
    useSessionStore.setState({ samuraiParkAlerts: [alert({ fireAt: "garbage" })] });

    render(<ParkedRunsBadge />);

    expect(screen.getByText("1 parked")).toBeInTheDocument();
  });

  it("picks the earliest parseable park, and never an empty list", () => {
    const early = alert({ key: "a", fireAt: "2026-08-07T09:05:00+00:00" });
    const late = alert({ key: "b", fireAt: "2026-08-13T09:05:00+00:00" });
    const bad = alert({ key: "c", fireAt: "garbage" });
    expect(soonestPark([late, early, bad])).toBe(early);
    // An unparseable-only list still returns one — the badge must show.
    expect(soonestPark([bad])).toBe(bad);
    expect(soonestPark([])).toBeNull();
  });
});
