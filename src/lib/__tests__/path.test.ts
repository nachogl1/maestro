import { describe, it, expect } from "vitest";
import { normalizePath, samePath } from "../path";

describe("normalizePath", () => {
  it("strips Windows extended-length \\\\?\\ prefix", () => {
    expect(normalizePath("\\\\?\\C:\\git\\maestro")).toBe("c:/git/maestro");
  });

  it("preserves UNC server paths after stripping \\\\?\\UNC\\", () => {
    expect(normalizePath("\\\\?\\UNC\\server\\share\\folder")).toBe(
      "//server/share/folder"
    );
  });

  it("normalizes backslashes to forward slashes and case-folds", () => {
    expect(normalizePath("C:\\Git\\Maestro")).toBe("c:/git/maestro");
  });

  it("trims trailing separators", () => {
    expect(normalizePath("C:\\git\\maestro\\\\")).toBe("c:/git/maestro");
  });

  it("leaves Unix paths intact (case-folded)", () => {
    expect(normalizePath("/Home/Me/Project")).toBe("/home/me/project");
  });
});

describe("samePath", () => {
  it("matches Windows UNC and plain forms of the same path", () => {
    expect(samePath("\\\\?\\C:\\git\\maestro", "C:\\git\\maestro")).toBe(true);
  });

  it("matches case-insensitive Windows paths", () => {
    expect(samePath("C:\\Git\\Maestro", "c:\\git\\maestro")).toBe(true);
  });

  it("rejects different paths", () => {
    expect(samePath("C:\\git\\maestro", "C:\\git\\other")).toBe(false);
  });

  it("treats trailing-slash variants as the same path", () => {
    expect(samePath("C:\\git\\maestro", "C:\\git\\maestro\\")).toBe(true);
  });
});
