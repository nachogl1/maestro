import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IssueFilters } from "../IssueFilters";

describe("IssueFilters", () => {
  it("opens the issue map from the Waypoints button", () => {
    const onOpenMap = vi.fn();
    render(<IssueFilters repoPath="C:\\repo" onOpenMap={onOpenMap} />);
    fireEvent.click(screen.getByRole("button", { name: "Show issue map" }));
    expect(onOpenMap).toHaveBeenCalledTimes(1);
  });
});
