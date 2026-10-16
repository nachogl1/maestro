import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri dependencies before importing the store
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/terminal", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../useWorkspaceStore";

const mockInvoke = vi.mocked(invoke);

describe("openProject dedupe across path spellings", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [] });
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd) => (cmd === "is_git_repository" ? true : null));
  });

  it("activates the open tab when the CLI sends the \\\\?\\ spelling", async () => {
    const { openProject } = useWorkspaceStore.getState();
    await openProject("C:\\git\\proj");
    await openProject("D:\\other");
    await openProject("\\\\?\\C:\\git\\proj");

    const { tabs } = useWorkspaceStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.active)?.projectPath).toBe("C:\\git\\proj");
  });

  it("re-checks with the same rule after the repo scan (concurrent opens)", async () => {
    const { openProject } = useWorkspaceStore.getState();
    await Promise.all([openProject("C:\\git\\proj"), openProject("\\\\?\\C:\\git\\proj")]);

    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  });
});
