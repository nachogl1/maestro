import { beforeEach, describe, expect, it, vi } from "vitest";

// We need to test pathRequiresFDA as a pure function and ensurePathAccess/checkFullDiskAccess with mocks.
// The module-level state (initialized, initPromise, macPermissions) makes testing tricky,
// so we re-import fresh for each group using vi.resetModules().

describe("pathRequiresFDA", () => {
  let pathRequiresFDA: (path: string) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../permissions");
    pathRequiresFDA = mod.pathRequiresFDA;
  });

  it("returns true for ~/Desktop", () => {
    expect(pathRequiresFDA("/Users/john/Desktop")).toBe(true);
  });

  it("returns true for ~/Desktop subdirectory", () => {
    expect(pathRequiresFDA("/Users/john/Desktop/my-project")).toBe(true);
  });

  it("returns true for ~/Documents", () => {
    expect(pathRequiresFDA("/Users/john/Documents")).toBe(true);
  });

  it("returns true for ~/Documents deep subdirectory", () => {
    expect(pathRequiresFDA("/Users/john/Documents/work/repo")).toBe(true);
  });

  it("returns true for ~/Downloads", () => {
    expect(pathRequiresFDA("/Users/john/Downloads")).toBe(true);
  });

  it("returns true for ~/Downloads subdirectory", () => {
    expect(pathRequiresFDA("/Users/john/Downloads/archive/project")).toBe(true);
  });

  it("returns true for iCloud Drive path (~/Library/Mobile Documents)", () => {
    expect(
      pathRequiresFDA("/Users/john/Library/Mobile Documents/com~apple~CloudDocs/project"),
    ).toBe(true);
  });

  it("returns true for ~/Library/Mobile Documents root", () => {
    expect(pathRequiresFDA("/Users/john/Library/Mobile Documents")).toBe(true);
  });

  it("returns false for /Volumes/ (external drive)", () => {
    expect(pathRequiresFDA("/Volumes/ExternalDrive/project")).toBe(false);
  });

  it("returns false for /Volumes/ (network share)", () => {
    expect(pathRequiresFDA("/Volumes/NetworkShare/repo")).toBe(false);
  });

  it("returns false for /Applications", () => {
    expect(pathRequiresFDA("/Applications/MyApp")).toBe(false);
  });

  it("returns false for user home root (no protected subdir)", () => {
    expect(pathRequiresFDA("/Users/john")).toBe(false);
  });

  it("returns false for /tmp", () => {
    expect(pathRequiresFDA("/tmp/project")).toBe(false);
  });

  it("returns false for /usr/local/src", () => {
    expect(pathRequiresFDA("/usr/local/src")).toBe(false);
  });

  it("returns false for unprotected home subdirectory", () => {
    expect(pathRequiresFDA("/Users/john/Projects/my-repo")).toBe(false);
  });

  it("returns false for ~/Library (not Mobile Documents)", () => {
    expect(pathRequiresFDA("/Users/john/Library/Preferences")).toBe(false);
  });

  it("handles different usernames correctly", () => {
    expect(pathRequiresFDA("/Users/alice/Desktop/project")).toBe(true);
    expect(pathRequiresFDA("/Users/bob/Documents/work")).toBe(true);
  });
});

describe("ensurePathAccess", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns hasAccess: true, needsFDA: false for non-FDA path", async () => {
    const { ensurePathAccess } = await import("../permissions");
    const result = await ensurePathAccess("/Users/john/Projects/repo");
    expect(result).toEqual({ hasAccess: true, needsFDA: false });
  });

  it("returns hasAccess: true, needsFDA: true for FDA path with access", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce(true);

    const { ensurePathAccess } = await import("../permissions");
    const result = await ensurePathAccess("/Users/john/Desktop/project");
    expect(result).toEqual({ hasAccess: true, needsFDA: true });
  });

  it("returns hasAccess: false, needsFDA: true for FDA path without access", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce(false);

    const { ensurePathAccess } = await import("../permissions");
    const result = await ensurePathAccess("/Users/john/Desktop/project");
    expect(result).toEqual({ hasAccess: false, needsFDA: true });
  });

  it("falls back to hasAccess: true when the check throws", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("check error"));

    const { ensurePathAccess } = await import("../permissions");
    const result = await ensurePathAccess("/Users/john/Desktop/project");
    expect(result).toEqual({ hasAccess: true, needsFDA: true });
  });
});

describe("checkFullDiskAccess", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns true when the check reports access", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce(true);

    const { checkFullDiskAccess } = await import("../permissions");
    const result = await checkFullDiskAccess();
    expect(result).toBe(true);
  });

  it("asks Maestro's own command, not the plugin's container probe", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const macPerms = await import("tauri-plugin-macos-permissions-api");
    vi.mocked(invoke).mockResolvedValueOnce(true);

    const { checkFullDiskAccess } = await import("../permissions");
    await checkFullDiskAccess();
    expect(invoke).toHaveBeenCalledWith("check_full_disk_access");
    expect(macPerms.checkFullDiskAccessPermission).not.toHaveBeenCalled();
  });

  it("returns false when the check reports no access", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValueOnce(false);

    const { checkFullDiskAccess } = await import("../permissions");
    const result = await checkFullDiskAccess();
    expect(result).toBe(false);
  });

  it("returns true when the check throws (fail-open)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("crash"));

    const { checkFullDiskAccess } = await import("../permissions");
    const result = await checkFullDiskAccess();
    expect(result).toBe(true);
  });
});

describe("initPermissions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is idempotent (multiple calls return same promise)", async () => {
    const { initPermissions } = await import("../permissions");
    const p1 = initPermissions();
    const p2 = initPermissions();
    expect(p1).toBe(p2);
    await p1;
    await p2;
  });
});
