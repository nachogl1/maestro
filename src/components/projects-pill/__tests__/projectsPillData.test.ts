import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueLinks } from "@/lib/issueGraph";
import { buildIssueMap, MAP_ISSUE_LIMIT } from "@/lib/issueMap";
import type { IssueInfo } from "@/stores/useGitHubStore";
import {
  blockedIssueNumbers,
  isNoRepositoryError,
  loadPillProject,
  ProjectsPillDataError,
} from "../projectsPillData";

const REPO = "https://github.com/acme/widgets";

const rawIssue = (number: number, state: string, labels: string[]) => ({
  number,
  title: `Issue ${number}`,
  state,
  url: `${REPO}/issues/${number}`,
  labels: labels.map((name) => ({ name, color: "ff0000" })),
  author: { login: "someone" },
  createdAt: "",
  updatedAt: "",
  closedAt: null,
  assignees: [],
});

const rawLinks = (number: number, blockedBy: number[] = [], body = "") => ({
  number,
  blockedBy,
  blocking: [],
  parent: null,
  subIssues: [],
  body,
});

interface Answers {
  labels: unknown;
  issues: unknown;
  links: unknown;
}

function answer(answers: Answers) {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "github_list_labels") return answers.labels;
    if (command === "github_list_issues") return answers.issues;
    if (command === "github_issue_links") return answers.links;
    throw new Error(`unexpected command ${command}`);
  });
}

const LABELS = [
  { name: "bug", color: "f87171" },
  { name: "story", color: "58a6ff" },
  { name: "wontfix", color: "82828e" },
];

describe("loadPillProject", () => {
  afterEach(() => vi.mocked(invoke).mockReset());

  it("counts each label's open issues, leaving closed ones out and showing 0 for an empty label", async () => {
    answer({
      labels: LABELS,
      issues: [
        rawIssue(3, "OPEN", ["bug", "story"]),
        rawIssue(1, "OPEN", ["bug"]),
        rawIssue(2, "CLOSED", ["bug"]),
        rawIssue(4, "OPEN", []),
      ],
      links: [rawLinks(1), rawLinks(2), rawLinks(3), rawLinks(4)],
    });

    const data = await loadPillProject("/repo");

    expect(data.labels.map((l) => [l.name, l.issues.map((i) => i.number)])).toEqual([
      ["bug", [1, 3]],
      ["story", [3]],
      ["wontfix", []],
    ]);
    expect(data.openIssues.map((i) => i.number)).toEqual([1, 3, 4]);
    expect(data.truncated).toBe(false);
  });

  it("reads issues the way the issue map does and asks for links only when there are issues", async () => {
    answer({ labels: LABELS, issues: [], links: null });

    const data = await loadPillProject("/repo");

    expect(data.openIssues).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("github_list_issues", {
      repoPath: "/repo",
      state: "all",
      limit: MAP_ISSUE_LIMIT,
      search: null,
    });
    expect(invoke).not.toHaveBeenCalledWith("github_issue_links", expect.anything());
  });

  it("turns every malformed GitHub answer into the one pill error", async () => {
    const good: Answers = {
      labels: [{ name: "bug", color: "f87171" }],
      issues: [rawIssue(1, "OPEN", ["bug"])],
      links: [rawLinks(1)],
    };
    const open = (extra: Record<string, unknown>) => [{ ...rawIssue(1, "OPEN", []), ...extra }];
    const linked = (extra: Record<string, unknown>) => [{ ...rawLinks(1), ...extra }];
    const cases: Array<[string, Partial<Answers>]> = [
      ["labels are null", { labels: null }],
      ["a label is null", { labels: [null] }],
      ["a label has no name", { labels: [{ color: "fff" }] }],
      ["a label colour is null", { labels: [{ name: "bug", color: null }] }],
      [
        "a label is listed twice",
        {
          labels: [
            { name: "bug", color: "" },
            { name: "BUG", color: "" },
          ],
        },
      ],
      ["issues are null", { issues: null }],
      ["an issue is null", { issues: [null] }],
      ["an issue has no number", { issues: open({ number: null }) }],
      ["an issue has no title", { issues: open({ title: undefined }) }],
      ["an issue state is null", { issues: open({ state: null }) }],
      ["an issue's labels are null", { issues: open({ labels: null }) }],
      ["an issue label is null", { issues: open({ labels: [null] }) }],
      ["an issue is listed twice", { issues: [rawIssue(1, "OPEN", []), rawIssue(1, "OPEN", [])] }],
      ["an issue carries an unknown label", { issues: [rawIssue(1, "OPEN", ["mystery"])] }],
      ["links are null", { links: null }],
      ["a link entry is null", { links: [null] }],
      ["a link names an issue not asked for", { links: [rawLinks(99)] }],
      ["an issue has two link entries", { links: [rawLinks(1), rawLinks(1)] }],
      ["a blocker list is null", { links: linked({ blockedBy: null }) }],
      ["a blocker list holds a null", { links: linked({ blockedBy: [null] }) }],
      ["a link body is null", { links: linked({ body: null }) }],
      ["a parent is not a number", { links: linked({ parent: "7" }) }],
    ];
    for (const [name, spoiled] of cases) {
      answer({ ...good, ...spoiled });
      await expect(loadPillProject("/repo"), name).rejects.toBeInstanceOf(ProjectsPillDataError);
    }
  });

  it("passes a command's own error through untouched", async () => {
    vi.mocked(invoke).mockRejectedValue(
      new Error("GitHub API rate limit exceeded. Try again later."),
    );

    await expect(loadPillProject("/repo")).rejects.toThrow("rate limit");
  });
});

describe("blockedIssueNumbers", () => {
  const issue = (n: number, state: string, labels: string[] = []): IssueInfo =>
    rawIssue(n, state, labels) as IssueInfo;

  // 2 waits on open 1 (native), 3 on open 1 (body section only), 4 on closed 5,
  // 6 on an open epic 7, 8 and 9 block each other (a loop), 10 is free.
  const issues = [
    issue(1, "OPEN"),
    issue(2, "OPEN"),
    issue(3, "OPEN"),
    issue(4, "OPEN"),
    issue(5, "CLOSED"),
    issue(6, "OPEN"),
    issue(7, "OPEN", ["epic"]),
    issue(8, "OPEN"),
    issue(9, "OPEN"),
    issue(10, "OPEN"),
  ];
  const links: Record<number, IssueLinks> = {
    1: rawLinks(1),
    2: rawLinks(2, [1]),
    3: rawLinks(3, [], "### Blocked by\n#1\n"),
    4: rawLinks(4, [5]),
    5: rawLinks(5),
    6: rawLinks(6, [7]),
    7: rawLinks(7),
    8: rawLinks(8, [9]),
    9: rawLinks(9, [8]),
    10: rawLinks(10),
  };

  it("marks exactly the open issues the issue map shows as blocked", () => {
    const blocked = blockedIssueNumbers(issues, links);
    const mapBlocked = buildIssueMap(issues, links)
      .nodes.filter((n) => n.status === "blocked")
      .map((n) => n.number);

    expect([...blocked].sort((a, b) => a - b)).toEqual(mapBlocked.sort((a, b) => a - b));
    expect(blocked.has(2)).toBe(true);
    expect(blocked.has(3)).toBe(true);
    expect(blocked.has(4)).toBe(false);
    expect(blocked.has(6)).toBe(false);
    expect(blocked.has(10)).toBe(false);
  });
});

describe("isNoRepositoryError", () => {
  it("recognises the errors of a folder with no GitHub repository behind it", () => {
    expect(isNoRepositoryError("not a GitHub repository")).toBe(true);
    expect(
      isNoRepositoryError(
        "gh command failed (exit code 1): unable to expand placeholder in path: no git remotes found",
      ),
    ).toBe(true);
    expect(isNoRepositoryError("GitHub API rate limit exceeded. Try again later.")).toBe(false);
    expect(isNoRepositoryError("Not authenticated with GitHub.")).toBe(false);
  });
});
