/**
 * PROJECTS pill data: per open project, every label of its GitHub repository
 * with that label's open issues, each marked blocked or not.
 *
 * "Blocked" is exactly the issue map's rule: an open issue with an open
 * blocker, by GitHub's native link or the body's "### Blocked by" section,
 * read through `buildIssueGraph` from the same fetch the map makes, so the
 * pill and the map always agree.
 *
 * Everything that comes back from GitHub is untrusted here: a null, a missing
 * field, a duplicate or a label the repository does not list becomes one
 * `ProjectsPillDataError`, which the pill shows with "Try again".
 */

import { invoke } from "@tauri-apps/api/core";
import { buildIssueGraph, type IssueLinks } from "@/lib/issueGraph";
import { MAP_ISSUE_LIMIT } from "@/lib/issueMap";
import type { IssueInfo } from "@/stores/useGitHubStore";

/** One open issue as the pill lists it. */
export interface PillIssue {
  number: number;
  title: string;
  url: string;
  /** Has an open blocker, by the issue map's rule. */
  blocked: boolean;
}

/** One repository label with its open issues (lowest number first). */
export interface PillLabel {
  name: string;
  /** Hex colour without the leading `#`; empty when GitHub gave none. */
  color: string;
  issues: PillIssue[];
}

export interface PillProjectData {
  /** Every label of the repository, in GitHub's order. */
  labels: PillLabel[];
  /** Every open issue, labelled or not (lowest number first). */
  openIssues: PillIssue[];
  /** True when the fetch hit the issue map's load limit, so counts may be low. */
  truncated: boolean;
}

/** The one error a malformed GitHub answer becomes. */
export class ProjectsPillDataError extends Error {
  constructor(detail: string) {
    super(`GitHub sent an answer Maestro could not read (${detail})`);
    this.name = "ProjectsPillDataError";
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIssueNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new ProjectsPillDataError(`${what} is not a list`);
  return value;
}

function asString(item: Json, field: string, what: string): string {
  const value = item[field];
  if (typeof value !== "string") throw new ProjectsPillDataError(`${what} has no ${field}`);
  return value;
}

function asNumberList(item: Json, field: string, what: string): number[] {
  const value = item[field];
  if (!Array.isArray(value) || !value.every(isIssueNumber)) {
    throw new ProjectsPillDataError(`${what} has a bad ${field} list`);
  }
  return value;
}

/** The repository's labels, as `github_list_labels` returns them. */
export function readLabels(raw: unknown): Array<{ name: string; color: string }> {
  const seen = new Set<string>();
  return asArray(raw, "the label list").map((item) => {
    if (!isObject(item)) throw new ProjectsPillDataError("a label is empty");
    const name = asString(item, "name", "a label");
    const color = asString(item, "color", `label "${name}"`);
    // GitHub label names are unique regardless of case.
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ProjectsPillDataError(`label "${name}" is listed twice`);
    seen.add(key);
    return { name, color };
  });
}

/**
 * The issues, as `github_list_issues` returns them, checked against the
 * repository's label names (lower-cased). Fields the pill does not read are
 * filled with neutral values so the issue map's reader can take them.
 */
export function readIssues(raw: unknown, labelNames: Set<string>): IssueInfo[] {
  const seen = new Set<number>();
  return asArray(raw, "the issue list").map((item) => {
    if (!isObject(item)) throw new ProjectsPillDataError("an issue is empty");
    const number = item.number;
    if (!isIssueNumber(number)) throw new ProjectsPillDataError("an issue has no number");
    if (seen.has(number)) throw new ProjectsPillDataError(`issue #${number} is listed twice`);
    seen.add(number);
    const what = `issue #${number}`;
    const labels = asArray(item.labels, `the labels of ${what}`).map((label) => {
      if (!isObject(label)) throw new ProjectsPillDataError(`${what} has an empty label`);
      const name = asString(label, "name", `a label of ${what}`);
      if (!labelNames.has(name.toLowerCase())) {
        throw new ProjectsPillDataError(
          `${what} carries label "${name}", which the repository does not list`,
        );
      }
      return { name, color: typeof label.color === "string" ? label.color : "" };
    });
    return {
      number,
      title: asString(item, "title", what),
      state: asString(item, "state", what),
      url: asString(item, "url", what),
      labels,
      author: { login: "" },
      createdAt: "",
      updatedAt: "",
      closedAt: null,
      assignees: [],
    };
  });
}

/** The links, as `github_issue_links` returns them, for the fetched issues only. */
export function readLinks(raw: unknown, fetched: Set<number>): Record<number, IssueLinks> {
  const byNumber: Record<number, IssueLinks> = {};
  for (const item of asArray(raw, "the issue links")) {
    if (!isObject(item)) throw new ProjectsPillDataError("an issue link is empty");
    const number = item.number;
    if (!isIssueNumber(number)) throw new ProjectsPillDataError("an issue link has no number");
    if (!fetched.has(number)) {
      throw new ProjectsPillDataError(
        `links came back for issue #${number}, which was not asked for`,
      );
    }
    if (byNumber[number]) throw new ProjectsPillDataError(`issue #${number} has two link entries`);
    const what = `the links of issue #${number}`;
    const parent = item.parent;
    if (parent !== null && !isIssueNumber(parent)) {
      throw new ProjectsPillDataError(`${what} have a bad parent`);
    }
    byNumber[number] = {
      number,
      blockedBy: asNumberList(item, "blockedBy", what),
      blocking: asNumberList(item, "blocking", what),
      parent,
      subIssues: asNumberList(item, "subIssues", what),
      body: asString(item, "body", what),
    };
  }
  return byNumber;
}

const isOpen = (issue: IssueInfo) => issue.state.toUpperCase() === "OPEN";

/**
 * The open issues that have an open blocker, by the issue map's rule: the
 * kept "blocked by" edges of `buildIssueGraph` whose blocker is still open.
 */
export function blockedIssueNumbers(
  issues: IssueInfo[],
  links: Record<number, IssueLinks | undefined>,
): Set<number> {
  const open = new Set(issues.filter(isOpen).map((issue) => issue.number));
  const blocked = new Set<number>();
  for (const edge of buildIssueGraph(issues, links).edges) {
    if (open.has(edge.source) && open.has(edge.target)) blocked.add(edge.target);
  }
  return blocked;
}

/** Assemble the pill's view of one repository from the three checked answers. */
export function buildPillProject(
  labels: Array<{ name: string; color: string }>,
  issues: IssueInfo[],
  links: Record<number, IssueLinks>,
): PillProjectData {
  const blocked = blockedIssueNumbers(issues, links);
  const openIssues = issues
    .filter(isOpen)
    .sort((a, b) => a.number - b.number)
    .map((issue) => ({
      issue,
      pill: {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        blocked: blocked.has(issue.number),
      },
    }));
  return {
    labels: labels.map(({ name, color }) => {
      const key = name.toLowerCase();
      return {
        name,
        color,
        issues: openIssues
          .filter(({ issue }) => issue.labels.some((l) => l.name.toLowerCase() === key))
          .map(({ pill }) => pill),
      };
    }),
    openIssues: openIssues.map(({ pill }) => pill),
    truncated: issues.length >= MAP_ISSUE_LIMIT,
  };
}

/**
 * Load one repository for the pill: its labels and the issue map's fetch
 * (every state, up to the map's limit, then their links). Rejects with the
 * command's own error or a `ProjectsPillDataError`.
 */
export async function loadPillProject(repoPath: string): Promise<PillProjectData> {
  const [rawLabels, rawIssues] = await Promise.all([
    invoke<unknown>("github_list_labels", { repoPath }),
    invoke<unknown>("github_list_issues", {
      repoPath,
      state: "all",
      limit: MAP_ISSUE_LIMIT,
      search: null,
    }),
  ]);
  const labels = readLabels(rawLabels);
  const issues = readIssues(rawIssues, new Set(labels.map((l) => l.name.toLowerCase())));
  const numbers = issues.map((issue) => issue.number);
  const rawLinks =
    numbers.length > 0 ? await invoke<unknown>("github_issue_links", { repoPath, numbers }) : [];
  return buildPillProject(labels, issues, readLinks(rawLinks, new Set(numbers)));
}

/** Errors `gh` gives for a folder with no GitHub repository behind it. */
const NO_REPOSITORY_MARKERS = ["not a github repository", "no git remotes found"];

/** True when a load error means the project simply has no GitHub repository. */
export function isNoRepositoryError(message: string): boolean {
  const lower = message.toLowerCase();
  return NO_REPOSITORY_MARKERS.some((marker) => lower.includes(marker));
}

/** The issues the list shows and counts under the lock setting. */
export function visibleIssues(issues: PillIssue[], countBlocked: boolean): PillIssue[] {
  return countBlocked ? issues : issues.filter((issue) => !issue.blocked);
}
