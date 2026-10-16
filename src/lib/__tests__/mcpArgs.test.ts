import { describe, expect, it } from "vitest";
import { formatArgs, parseArgs } from "../mcpArgs";

describe("mcpArgs", () => {
  it("splits plain args on spaces and groups quoted text", () => {
    expect(parseArgs('--dir "C:\\My Project" -y')).toEqual(["--dir", "C:\\My Project", "-y"]);
    expect(parseArgs("  ")).toEqual([]);
  });

  it("leaves plain args unquoted", () => {
    expect(formatArgs(["-y", "@scope/server", "--port=3000"])).toBe("-y @scope/server --port=3000");
  });

  it.each([
    [["--dir", "C:\\Users\\Me\\My Project"]],
    [["say it's fine"]],
    [['{"key": "value"}']],
    [["mixed \"double\" and 'single'"]],
    [['"', "'", "\"'", "a\"b'c"]],
    [["", "tab\there", "two  spaces"]],
  ])("round-trips %j exactly through the editor text", (args) => {
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });
});
