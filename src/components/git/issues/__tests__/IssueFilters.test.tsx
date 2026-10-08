import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IssueFilters } from "../IssueFilters";

describe("IssueFilters", () => {
  it("opens the issue hierarchy from the Waypoints button", () => {
    const onOpenHierarchy = vi.fn();
    render(<IssueFilters repoPath="C:\\repo" onOpenHierarchy={onOpenHierarchy} />);
    fireEvent.click(screen.getByRole("button", { name: "Show issue hierarchy" }));
    expect(onOpenHierarchy).toHaveBeenCalledTimes(1);
  });
});
