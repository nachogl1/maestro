import { describe, expect, it } from "vitest";
import { quotePathsForShell, shellEscapePath, shellEscapePaths } from "../shellEscape";

describe("shellEscapePath", () => {
  it("wraps a simple path in single quotes", () => {
    expect(shellEscapePath("/home/user/file.txt")).toBe("'/home/user/file.txt'");
  });

  it("quotes paths containing spaces so they stay one argument", () => {
    expect(shellEscapePath("/my docs/a b.txt")).toBe("'/my docs/a b.txt'");
  });

  it("escapes an embedded single quote using the '\\'' idiom", () => {
    // O'Brien -> 'O'\''Brien'
    expect(shellEscapePath("O'Brien")).toBe("'O'\\''Brien'");
  });

  it("escapes multiple single quotes", () => {
    expect(shellEscapePath("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("neutralizes shell metacharacters by quoting them literally", () => {
    const dangerous = "foo; rm -rf ~ && echo $(whoami) `id` | cat > out";
    const escaped = shellEscapePath(dangerous);
    // No single quote inside, so the whole thing is wrapped verbatim.
    expect(escaped).toBe(`'${dangerous}'`);
  });

  it("handles an empty string", () => {
    expect(shellEscapePath("")).toBe("''");
  });
});

describe("shellEscapePaths", () => {
  it("joins escaped paths with a single space", () => {
    expect(shellEscapePaths(["/a/b", "/c d/e"])).toBe("'/a/b' '/c d/e'");
  });

  it("returns an empty string for no paths", () => {
    expect(shellEscapePaths([])).toBe("");
  });

  it("escapes each path independently", () => {
    expect(shellEscapePaths(["it's", "x"])).toBe("'it'\\''s' 'x'");
  });
});

describe("quotePathsForShell (drag-drop / Attach Files)", () => {
  it("double-quotes Windows paths for cmd.exe instead of POSIX single quotes", () => {
    expect(quotePathsForShell(["C:\\Users\\me\\My Docs\\report.txt"], "cmd")).toBe(
      '"C:\\Users\\me\\My Docs\\report.txt"',
    );
  });

  it("single-quotes for a posix shell", () => {
    expect(quotePathsForShell(["/a/b", "/c d/e"], "posix")).toBe("'/a/b' '/c d/e'");
  });

  it("still double-quotes a cmd path that a launch line would refuse (% & !)", () => {
    expect(quotePathsForShell(["C:\\100% off&calc.txt", "C:\\dir\\"], "cmd")).toBe(
      '"C:\\100% off&calc.txt" "C:\\dir\\\\"',
    );
  });

  it("keeps a newline inside posix single quotes instead of typing it bare", () => {
    expect(quotePathsForShell(["/a\nb"], "posix")).toBe("'/a\nb'");
  });

  it("falls back to posix single quotes when the shell family is unknown", () => {
    expect(quotePathsForShell(["/a b/c", "d"], null)).toBe("'/a b/c' 'd'");
  });
});
