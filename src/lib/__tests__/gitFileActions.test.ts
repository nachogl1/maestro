import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { discardFile, removeFile } from "../git";

// `invoke` is mocked globally in src/test/setup.ts.
const invokeMock = vi.mocked(invoke);

describe("discardFile", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("forwards worktree path and file path, null old path by default", async () => {
    await discardFile("/repo/wt", "src/foo.ts");
    expect(invokeMock).toHaveBeenCalledWith("git_discard_file", {
      worktreePath: "/repo/wt",
      path: "src/foo.ts",
      oldPath: null,
    });
  });

  it("passes the rename source as oldPath when provided", async () => {
    await discardFile("/repo/wt", "src/new.ts", "src/old.ts");
    expect(invokeMock).toHaveBeenCalledWith("git_discard_file", {
      worktreePath: "/repo/wt",
      path: "src/new.ts",
      oldPath: "src/old.ts",
    });
  });

  it("normalizes a null oldPath argument to null", async () => {
    await discardFile("/repo/wt", "src/foo.ts", null);
    expect(invokeMock).toHaveBeenCalledWith("git_discard_file", {
      worktreePath: "/repo/wt",
      path: "src/foo.ts",
      oldPath: null,
    });
  });
});

describe("removeFile", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("forwards worktree path and untracked file path", async () => {
    await removeFile("/repo/wt", "junk.txt");
    expect(invokeMock).toHaveBeenCalledWith("git_remove_file", {
      worktreePath: "/repo/wt",
      path: "junk.txt",
    });
  });
});
