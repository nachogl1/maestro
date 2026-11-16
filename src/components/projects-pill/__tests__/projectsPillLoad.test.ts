import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetRunningLoads, loadAndRemember, type PillProject } from "../projectsPillLoad";
import { forgetRememberedProjects, recallProject } from "../projectsPillMemory";

const project = (repoPath: string): PillProject => ({
  id: "tab-1",
  name: "widgets",
  repoPath,
  nonGit: false,
});

describe("loadAndRemember", () => {
  beforeEach(() => {
    forgetRememberedProjects();
    forgetRunningLoads();
  });

  afterEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("does not remember a load for a folder the tab has since left", async () => {
    let releaseOld: () => void = () => {};
    const oldFolderAnswered = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (_command: string, args?: unknown) => {
      if ((args as { repoPath: string }).repoPath === "/work/old") await oldFolderAnswered;
      return [];
    });

    const oldLoad = loadAndRemember(project("/work/old"));
    await loadAndRemember(project("/work/new"));
    releaseOld();
    await oldLoad;

    expect(recallProject("tab-1", "/work/new")).toEqual({
      kind: "ready",
      data: { labels: [], openIssues: [], truncated: false },
    });
    expect(recallProject("tab-1", "/work/old")).toBeNull();
  });
});
