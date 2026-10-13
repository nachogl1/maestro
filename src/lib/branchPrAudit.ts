import { invoke } from "@tauri-apps/api/core";
import { formatIsoAge } from "@/lib/format";

/**
 * Slim pull-request shape the Branches tab needs to decide whether a branch
 * is safe to delete: was it merged, by whom, and when. Deliberately narrower
 * than `PullRequestInfo` in `useGitHubStore` — this is a one-shot audit list,
 * not the PRs tab's live-filtered state.
 */
export interface BranchPr {
  number: number;
  /** `OPEN`, `MERGED`, or `CLOSED`, as `gh` reports it. */
  state: string;
  headRefName: string;
  authorLogin: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  url: string;
}

/** Raw shape of the fields we ask `github_list_prs` for. */
interface RawBranchPr {
  number: number;
  state: string;
  author: { login: string } | null;
  createdAt: string;
  headRefName: string;
  mergedAt: string | null;
  closedAt: string | null;
  url: string;
}

/** How many PRs (any state) to pull for one audit pass. */
const PR_AUDIT_LIMIT = 100;

/**
 * Fetches every PR (any state) for the repo, once, to power the Branches
 * tab's per-row "was this merged / who opened it" badges. Always resolves —
 * on any failure (gh missing, not authenticated, network) it returns `[]` so
 * callers can join against an empty list rather than surface a blocking
 * error on a tab that isn't gh-gated.
 */
export async function fetchBranchPrAudit(repoPath: string): Promise<BranchPr[]> {
  try {
    const raw = await invoke<RawBranchPr[]>("github_list_prs", {
      repoPath,
      state: "all",
      limit: PR_AUDIT_LIMIT,
      search: null,
    });
    return raw.map((pr) => ({
      number: pr.number,
      state: pr.state,
      headRefName: pr.headRefName,
      authorLogin: pr.author?.login ?? "unknown",
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      url: pr.url,
    }));
  } catch {
    return [];
  }
}

/**
 * Strips a remote prefix like "origin/" off a branch name so it can be
 * compared against `headRefName`, which `gh pr list` always returns as the
 * plain branch name regardless of remote.
 */
function shortBranchName(branchName: string, isRemote: boolean): string {
  if (!isRemote) return branchName;
  const slash = branchName.indexOf("/");
  return slash === -1 ? branchName : branchName.slice(slash + 1);
}

/**
 * Finds the PR opened from `branchName`, if any. A branch can have more than
 * one PR over its lifetime (reopened, or reused after a previous PR closed);
 * an open PR always wins since that's the one still relevant, otherwise the
 * most recently created match wins.
 */
export function findPrForBranch(
  prs: BranchPr[],
  branchName: string,
  isRemote: boolean,
): BranchPr | undefined {
  const short = shortBranchName(branchName, isRemote);
  const matches = prs.filter((pr) => pr.headRefName === short);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  const open = matches.filter((pr) => pr.state.toUpperCase() === "OPEN");
  const pool = open.length > 0 ? open : matches;
  return pool.reduce((latest, pr) =>
    new Date(pr.createdAt).getTime() > new Date(latest.createdAt).getTime() ? pr : latest,
  );
}

/** Visual tone for a PR badge — merged is the "safe to delete" signal. */
export type PrBadgeTone = "merged" | "open" | "closed";

export interface PrBadgeInfo {
  label: string;
  tone: PrBadgeTone;
}

/**
 * Builds the badge label/tone for a matched PR.
 * `formatRelative` is injected so the presentational date formatting stays
 * out of this pure-logic helper (and out of its tests).
 */
export function prBadge(pr: BranchPr, formatRelative: (iso: string) => string): PrBadgeInfo {
  const state = pr.state.toUpperCase();
  if (state === "MERGED") {
    const when = pr.mergedAt ? formatRelative(pr.mergedAt) : "";
    return {
      label: `PR #${pr.number} merged${when ? ` ${when}` : ""} by ${pr.authorLogin}`,
      tone: "merged",
    };
  }
  if (state === "CLOSED") {
    return { label: `PR #${pr.number} closed`, tone: "closed" };
  }
  return { label: `PR #${pr.number} open by ${pr.authorLogin}`, tone: "open" };
}

/**
 * Formats an ISO timestamp as a short relative age ("3d", "2mo", "now").
 * Shared by the PR badge and the branch's last-commit metadata line.
 */
export function formatRelativeTime(iso: string): string {
  return formatIsoAge(iso, { longUnits: true });
}
