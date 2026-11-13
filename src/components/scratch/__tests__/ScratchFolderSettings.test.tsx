import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useScratchStore } from "@/stores/useScratchStore";
import { ScratchFolderSettings } from "../ScratchFolderSettings";

const mockInvoke = vi.mocked(invoke);
const mockOpen = vi.mocked(open);
const DEFAULT_FOLDER = "/home/someone/Maestro Scratch";

describe("ScratchFolderSettings", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd, args) =>
      cmd === "scratch_list"
        ? { folder: (args as { folder: string | null }).folder ?? DEFAULT_FOLDER, projects: [] }
        : undefined,
    );
    mockOpen.mockReset();
    useScratchStore.setState({ folderSetting: null, folder: null, projects: [], error: null });
  });
  afterEach(cleanup);

  it("shows the default scratch folder in the home folder", async () => {
    render(<ScratchFolderSettings />);

    expect(await screen.findByText(DEFAULT_FOLDER)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use default" })).toBeNull();
  });

  it("Choose folder sets a new scratch folder and lists it", async () => {
    mockOpen.mockResolvedValue("/data/scratch");
    render(<ScratchFolderSettings />);

    fireEvent.click(screen.getByRole("button", { name: "Choose scratch folder" }));

    expect(await screen.findByText("/data/scratch")).toBeTruthy();
    expect(useScratchStore.getState().folderSetting).toBe("/data/scratch");
    expect(mockInvoke).toHaveBeenLastCalledWith("scratch_list", { folder: "/data/scratch" });

    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    await waitFor(() => expect(screen.getByText(DEFAULT_FOLDER)).toBeTruthy());
    expect(useScratchStore.getState().folderSetting).toBeNull();
  });
});
