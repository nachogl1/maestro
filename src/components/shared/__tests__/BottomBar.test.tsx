import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The footer's siblings poll the backend; the Launch button is what is under test.
vi.mock("../TerminalNavigator", () => ({ TerminalNavigator: () => null }));
vi.mock("../SystemMetrics", () => ({ SystemMetrics: () => <div>metrics</div> }));
vi.mock("../UsageBar", () => ({ UsageBar: () => <div>usage</div> }));
vi.mock("@/stores/useClaudeAccountStore", () => ({
  useClaudeAccountStore: (selector: (s: { account: null; fetch: () => void }) => unknown) =>
    selector({ account: null, fetch: () => {} }),
}));

import { BottomBar } from "../BottomBar";

describe("BottomBar launch button", () => {
  it("shows no Launch button when there is nothing to launch", () => {
    render(
      <BottomBar
        slotCount={0}
        launchedCount={0}
        onLaunchAll={() => {}}
        onNavigateToSession={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /launch/i })).not.toBeInTheDocument();
    // The usage area is still there, uncovered.
    expect(screen.getByText("usage")).toBeInTheDocument();
  });

  it("shows no Launch button when every slot is already running", () => {
    render(
      <BottomBar
        slotCount={2}
        launchedCount={2}
        onLaunchAll={() => {}}
        onNavigateToSession={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /launch/i })).not.toBeInTheDocument();
  });

  it("launches the pending slots from the button", () => {
    const onLaunchAll = vi.fn();
    render(
      <BottomBar
        slotCount={3}
        launchedCount={1}
        onLaunchAll={onLaunchAll}
        onNavigateToSession={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "Launch All (2)" });
    fireEvent.click(button);
    expect(onLaunchAll).toHaveBeenCalledTimes(1);
  });

  it("names a single pending slot in the singular", () => {
    render(
      <BottomBar
        slotCount={1}
        launchedCount={0}
        onLaunchAll={() => {}}
        onNavigateToSession={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Launch Session" })).toBeInTheDocument();
  });
});
