import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { TerminalHeader } from "../TerminalHeader";

function renderHeader(props: Partial<React.ComponentProps<typeof TerminalHeader>> = {}) {
  return render(<TerminalHeader sessionId={3} onKill={() => {}} {...props} />);
}

describe("TerminalHeader context-alert banner", () => {
  it("renders nothing extra while the alert is not active", () => {
    renderHeader({ contextAlert: false, contextAlertTitle: "Context 42% ≥ 80% alert" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Context threshold reached/)).toBeNull();
  });

  it("shows a centred red warning pill with the percent and threshold while alerting", () => {
    renderHeader({ contextAlert: true, contextAlertTitle: "Context 87% ≥ 80% alert" });
    const pill = screen.getByRole("status");
    expect(pill.textContent).toContain("Context threshold reached");
    expect(pill.getAttribute("title")).toBe("Context 87% ≥ 80% alert");
    expect(pill.className).toContain("text-maestro-red");
    // Blinks in step with the frame; the CSS class carries the animation.
    expect(pill.className).toContain("context-alert-pill");
    // Must not steal header clicks (flag toggle / drag handle).
    expect(pill.className).toContain("pointer-events-none");
    expect(pill.querySelector("svg")).not.toBeNull();
  });

  it("keeps the name on the left and the controls on the right around the pill", () => {
    renderHeader({ contextAlert: true, contextAlertTitle: "Context 90% ≥ 80% alert" });
    const pill = screen.getByRole("status");
    const header = pill.parentElement;
    expect(header).not.toBeNull();
    // Header is the positioning context; the pill is absolutely centred.
    expect(header?.className).toContain("relative");
    expect(pill.className).toContain("absolute");
    expect(pill.className).toContain("left-1/2");
    // The two existing clusters are still direct children of the header.
    expect(screen.getByText("Terminal 3").closest("div")?.parentElement).toBe(header);
    expect(screen.getByLabelText("Kill session 3").closest("div")?.parentElement).toBe(header);
    // Never wider than the middle of the header, so the controls stay visible.
    expect(pill.className).toContain("max-w-[40%]");
  });

  it("keeps only the icon in a dense grid", () => {
    renderHeader({ contextAlert: true, terminalCount: 6 });
    const pill = screen.getByRole("status");
    expect(pill.querySelector("svg")).not.toBeNull();
    expect(pill.textContent).toBe("");
    expect(pill.getAttribute("title")).toBe("Context threshold reached");
  });
});
