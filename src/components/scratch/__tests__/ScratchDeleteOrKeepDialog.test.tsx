import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { useScratchStore } from "@/stores/useScratchStore";
import { ScratchDeleteOrKeepDialog } from "../ScratchDeleteOrKeepDialog";

const answer = vi.fn().mockResolvedValue(undefined);

describe("ScratchDeleteOrKeepDialog", () => {
  beforeEach(() => {
    answer.mockClear();
    useScratchStore.setState({ question: null, error: null, answer });
  });
  afterEach(cleanup);

  it("shows nothing until a scratch project is being closed", () => {
    render(<ScratchDeleteOrKeepDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks Delete or Keep and passes the answer on", async () => {
    useScratchStore.setState({
      question: {
        tabId: "t1",
        name: "demo",
        path: "/home/someone/Maestro Scratch/demo",
        reason: "close-tab",
        runningCount: 2,
      },
    });
    render(<ScratchDeleteOrKeepDialog />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Delete the scratch project's files, or keep them?");
    expect(dialog.textContent).toContain("stops its 2 running terminals");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Keep" })));
    expect(answer).toHaveBeenLastCalledWith("keep");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
    expect(answer).toHaveBeenLastCalledWith("delete");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close" })));
    expect(answer).toHaveBeenLastCalledWith("cancel");
  });
});
