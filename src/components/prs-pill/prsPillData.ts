/**
 * PRs pill data: the open pull requests of one project, read through the
 * existing `github_list_prs` command, plus the pure rules the pill shows them
 * by (order, labels for checks and reviews, the created date).
 *
 * Everything that comes back from GitHub is untrusted here: a null, a missing
 * field or a duplicate becomes one `PrsPillDataError`, which the pill shows
 * with "Try again".
 */

import { invoke } from "@tauri-apps/api/core";

/** How many open pull requests are read per project. */
export const PR_LIMIT = 100;

/** The CI verdict values `github_list_prs` sends in `checksSummary.verdict`. */
export type ChecksVerdict = "success" | "failure" | "pending" | "none";

/** One open pull request as the pill lists and describes it. */
export interface PillPr {
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  /** ISO timestamp from GitHub. */
  createdAt: string;
  /** GitHub's review decision (`APPROVED`, …), or null when there is none yet. */
  reviewDecision: string | null;
  checks: ChecksVerdict;
}

/** One project's open pull requests. */
export interface PillPrsResult {
  prs: PillPr[];
  /** True when the fetch hit {@link PR_LIMIT}, so the count may be low. */
  truncated: boolean;
}

/** The one error a malformed GitHub answer becomes. */
export class PrsPillDataError extends Error {
  constructor(detail: string) {
    super(`GitHub sent an answer Maestro could not read (${detail})`);
    this.name = "PrsPillDataError";
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const KNOWN_VERDICTS: ReadonlySet<string> = new Set(["success", "failure", "pending", "none"]);

function asString(item: Json, field: string, what: string): string {
  const value = item[field];
  if (typeof value !== "string") throw new PrsPillDataError(`${what} has no ${field}`);
  return value;
}

/** An unknown verdict shows like "none", as the Git panel's PR rows do. */
function readVerdict(item: Json): ChecksVerdict {
  const summary = item.checksSummary;
  if (!isObject(summary) || typeof summary.verdict !== "string") return "none";
  return KNOWN_VERDICTS.has(summary.verdict) ? (summary.verdict as ChecksVerdict) : "none";
}

/** The pull requests, as `github_list_prs` returns them. */
export function readPrs(raw: unknown): PillPr[] {
  if (!Array.isArray(raw)) throw new PrsPillDataError("the pull request list is not a list");
  const seen = new Set<number>();
  return raw.map((item) => {
    if (!isObject(item)) throw new PrsPillDataError("a pull request is empty");
    const number = item.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      throw new PrsPillDataError("a pull request has no number");
    }
    if (seen.has(number)) throw new PrsPillDataError(`pull request #${number} is listed twice`);
    seen.add(number);
    const what = `pull request #${number}`;
    if (!isObject(item.author)) throw new PrsPillDataError(`${what} has no author`);
    if (typeof item.isDraft !== "boolean") throw new PrsPillDataError(`${what} has no isDraft`);
    const review = item.reviewDecision;
    if (review !== undefined && review !== null && typeof review !== "string") {
      throw new PrsPillDataError(`${what} has a bad reviewDecision`);
    }
    return {
      number,
      title: asString(item, "title", what),
      url: asString(item, "url", what),
      author: asString(item.author, "login", `the author of ${what}`),
      isDraft: item.isDraft,
      createdAt: asString(item, "createdAt", what),
      reviewDecision: review ? review : null,
      checks: readVerdict(item),
    };
  });
}

/**
 * Load one project's open pull requests. Rejects with the command's own
 * error or a `PrsPillDataError`.
 */
export async function loadProjectPrs(repoPath: string): Promise<PillPrsResult> {
  const raw = await invoke<unknown>("github_list_prs", {
    repoPath,
    state: "open",
    limit: PR_LIMIT,
    search: null,
  });
  const prs = readPrs(raw);
  return { prs, truncated: prs.length >= PR_LIMIT };
}

/** Errors `gh` gives for a folder with no GitHub repository behind it. */
const NO_REPOSITORY_MARKERS = ["not a github repository", "no git remotes found"];

/** True when a load error means the project simply has no GitHub repository. */
export function isNoRepositoryError(message: string): boolean {
  const lower = message.toLowerCase();
  return NO_REPOSITORY_MARKERS.some((marker) => lower.includes(marker));
}

/** Waiting for my review first, then the rest; newest first within each group. */
export function sortPrs(prs: PillPr[], reviewRequested: ReadonlySet<number>): PillPr[] {
  return [...prs].sort((a, b) => {
    const mine = Number(reviewRequested.has(b.number)) - Number(reviewRequested.has(a.number));
    return mine || Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number;
  });
}

const CHECKS_LABELS: Record<ChecksVerdict, string> = {
  success: "Passing",
  failure: "Failing",
  pending: "Running",
  none: "No checks",
};

/** The checks line of the detail card. */
export function checksLabel(verdict: ChecksVerdict): string {
  return CHECKS_LABELS[verdict];
}

const REVIEW_LABELS: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};

/** The review line of the detail card; an unknown decision is shown as GitHub words it. */
export function reviewLabel(decision: string | null): string {
  if (!decision) return "No review yet";
  const known = REVIEW_LABELS[decision.toUpperCase()];
  if (known) return known;
  const words = decision.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** The created line of the detail card, e.g. "14 Nov 2026 (2 days ago)". */
export function createdLabel(iso: string, now: Date): string {
  const created = new Date(iso);
  if (Number.isNaN(created.getTime())) return "Unknown";
  const days = Math.round((startOfDay(now) - startOfDay(created)) / DAY_MS);
  const when = created.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const ago = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `${when} (${ago})`;
}
