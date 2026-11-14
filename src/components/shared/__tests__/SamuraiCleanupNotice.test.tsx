import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SamuraiCleanupNotice } from "../SamuraiCleanupNotice";

const mockInvoke = vi.mocked(invoke);

describe("SamuraiCleanupNotice", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("shows nothing when the cleanup kept no worktree", async () => {
    mockInvoke.mockResolvedValue([]);

    const { container } = render(<SamuraiCleanupNotice />);

    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("samurai_cleanup_kept_worktrees"),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each kept worktree with its reasons until it is closed", async () => {
    mockInvoke.mockResolvedValue([
      { path: "C:/wt/run-a", reasons: ["unmerged commits"] },
      { path: "C:/wt/run-b", reasons: ["unmerged commits", "uncommitted files"] },
    ]);

    render(<SamuraiCleanupNotice />);

    expect(await screen.findByText("C:/wt/run-a")).toBeInTheDocument();
    expect(screen.getByText("unmerged commits")).toBeInTheDocument();
    expect(screen.getByText("C:/wt/run-b")).toBeInTheDocument();
    expect(screen.getByText("unmerged commits, uncommitted files")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close notice" }));

    expect(screen.queryByText("C:/wt/run-a")).not.toBeInTheDocument();
  });
});
