import { describe, expect, it } from "vitest";
import {
  quotePathsForShell,
  quoteShellArgument,
  shellEscapePath,
  shellEscapePaths,
} from "../shellEscape";

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

// --- issue #158: quoting one argument for the `claude` launch line ---

describe("quoteShellArgument (posix)", () => {
  const quote = (v: string): string | null => quoteShellArgument(v, "posix");

  it("neutralizes the backtick that the brief pointer carries", () => {
    // The whole reason this exists: `pointer_instruction` embeds the brief
    // path in BACKTICKS, and a backtick inside DOUBLE quotes is command
    // substitution in bash/zsh — the shell would try to execute the path.
    // Single quotes make it inert.
    const pointer = "[Maestro Samurai] Read `.maestro/briefs/epic-38-gen-1-launch.md` in FULL";
    expect(quote(pointer)).toBe(`'${pointer}'`);
  });

  it("escapes an embedded single quote with the '\\'' idiom", () => {
    expect(quote("don't")).toBe("'don'\\''t'");
  });

  it("wraps a double quote, ampersand, pipe and percent literally", () => {
    const payload = 'say "hi" & echo x | cat 100%';
    expect(quote(payload)).toBe(`'${payload}'`);
  });

  it("wraps a Windows path with spaces as one argument", () => {
    expect(quote("C:\\Program Files\\a b\\brief.md")).toBe("'C:\\Program Files\\a b\\brief.md'");
  });

  it("refuses a payload with a newline — a bare CR/LF submits it half-typed", () => {
    expect(quote("line one\nline two")).toBeNull();
    expect(quote("line one\rline two")).toBeNull();
  });

  it("refuses an empty payload", () => {
    expect(quote("")).toBeNull();
  });
});

describe("quoteShellArgument (cmd)", () => {
  const quote = (v: string): string | null => quoteShellArgument(v, "cmd");

  it("wraps the pointer in double quotes — the backtick is inert in cmd.exe", () => {
    const pointer = "[Maestro Samurai] Read `.maestro/briefs/epic-38-gen-1-launch.md` in FULL";
    expect(quote(pointer)).toBe(`"${pointer}"`);
  });

  it("neutralizes &, |, <, >, ^ and ( ) by quoting them", () => {
    const payload = "a & b | c < d > e ^ f (g)";
    expect(quote(payload)).toBe(`"${payload}"`);
  });

  it("keeps a single quote verbatim — it is an ordinary character to cmd.exe", () => {
    expect(quote("don't")).toBe('"don\'t"');
  });

  it("refuses a double quote — it would close the quoted region mid-argument", () => {
    expect(quote('say "hi"')).toBeNull();
  });

  it("refuses % — cmd expands %VAR% inside double quotes and has no escape for it", () => {
    expect(quote("100% of %USERPROFILE%")).toBeNull();
  });

  it("refuses ! — delayed expansion eats it when the user enabled it", () => {
    expect(quote("do it!")).toBeNull();
  });

  it("doubles a trailing backslash run so it is not read as escaping the close quote", () => {
    expect(quote("C:\\Program Files\\wt\\")).toBe('"C:\\Program Files\\wt\\\\"');
    expect(quote("C:\\wt\\\\")).toBe('"C:\\wt\\\\\\\\"');
  });

  it("leaves interior backslashes alone — they only matter before a quote", () => {
    expect(quote("C:\\Program Files\\a b\\brief.md")).toBe('"C:\\Program Files\\a b\\brief.md"');
  });

  it("refuses newlines and an empty payload", () => {
    expect(quote("a\nb")).toBeNull();
    expect(quote("")).toBeNull();
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
