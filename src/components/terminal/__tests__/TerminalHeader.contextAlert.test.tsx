import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { TerminalHeader } from "../TerminalHeader";

function renderHeader(props: Partial<React.ComponentProps<typeof TerminalHeader>> = {}) {
  return render(<TerminalHeader sessionId={3} onKill={() => {}} {...props} />);
}

describe("TerminalHeader context-alert warning", () => {
  it("renders nothing extra while the alert is not active", () => {
    renderHeader({ contextAlert: false, contextAlertTitle: "Context 42% ≥ 80% alert" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Context threshold reached/)).toBeNull();
  });

  it("shows a red warning icon with the full text and the percent on hover", () => {
    renderHeader({ contextAlert: true, contextAlertTitle: "Context 87% ≥ 80% alert" });
    const icon = screen.getByRole("status");
    expect(icon.getAttribute("title")).toBe("Context threshold reached — Context 87% ≥ 80% alert");
    expect(icon.className).toContain("text-maestro-red");
    // Blinks in step with the frame; the CSS class carries the animation.
    expect(icon.className).toContain("context-alert-pill");
    expect(icon.querySelector("svg")).not.toBeNull();
    // Only the icon shows; the words are on hover.
    expect(icon.textContent).toBe("");
  });

  it("sits in the row right after the terminal name, never floating over the header", () => {
    renderHeader({ contextAlert: true, contextAlertTitle: "Context 90% ≥ 80% alert" });
    const icon = screen.getByRole("status");
    expect(screen.getByText("Terminal 3").nextElementSibling).toBe(icon);
    expect(icon.className).not.toContain("absolute");
    // Hover must reach it, so it may not ignore the pointer.
    expect(icon.className).not.toContain("pointer-events-none");
  });

  it("falls back to the plain warning text when no detail is given", () => {
    renderHeader({ contextAlert: true, terminalCount: 6 });
    const icon = screen.getByRole("status");
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(icon.getAttribute("title")).toBe("Context threshold reached");
  });
});
