import { describe, expect, it } from "vitest";
import { findUnpinnedActions } from "./check-pinned-actions.mjs";

const HASH = "11d5960a326750d5838078e36cf38b85af677262";

describe("findUnpinnedActions", () => {
  it.each([
    ["a step pinned to a hash with its version", `      - uses: actions/checkout@${HASH} # v4.4.0`],
    ["a key on its own line", `        uses: actions/checkout@${HASH} # v4.4.0`],
    ["a quoted reference", `      - uses: "actions/checkout@${HASH}" # v4.4.0`],
    ["an action in a sub-folder", `      - uses: github/codeql-action/init@${HASH} # v3.1.0`],
    ["a local action or reusable workflow", "    uses: ./.github/workflows/pr-checks.yml"],
    ["a Docker image pinned to a digest", `      - uses: docker://alpine@sha256:${"a".repeat(64)}`],
    ["a line that only mentions uses in a comment", "      # uses: actions/checkout@v4"],
  ])("accepts %s", (_name, line) => {
    expect(findUnpinnedActions(line)).toEqual([]);
  });

  it.each([
    ["a moving major tag", "      - uses: actions/checkout@v4"],
    ["an exact version tag", "      - uses: actions/checkout@v4.4.0"],
    ["a branch", "        uses: dtolnay/rust-toolchain@master"],
    ["a short hash", "      - uses: actions/checkout@11d5960"],
    ["no reference at all", "      - uses: actions/checkout"],
    ["a quoted moving tag", "      - uses: 'actions/checkout@v4' # v4"],
    ["a Docker image by tag", "      - uses: docker://alpine:3.20"],
    ["a hash with no readable version beside it", `      - uses: actions/checkout@${HASH}`],
  ])("flags %s", (_name, line) => {
    expect(findUnpinnedActions(line)).toHaveLength(1);
  });

  it("reports the line number and the reference of each finding", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    steps:",
      `      - uses: actions/checkout@${HASH} # v4.4.0`,
      "      - uses: actions/setup-node@v4",
    ].join("\n");

    expect(findUnpinnedActions(workflow)).toEqual([
      expect.objectContaining({ line: 5, reference: "actions/setup-node@v4" }),
    ]);
  });
});
