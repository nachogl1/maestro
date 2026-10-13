import { invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust `BranchPullRequest` struct returned by `github_pr_for_branch`. */
export interface BranchPullRequest {
  number: number;
  title: string;
  /** "OPEN", "MERGED" or "CLOSED", as `gh` reports it. */
  state: string;
  isDraft: boolean;
  url: string;
}

/**
 * How long a branch → PR answer is reused.
 *
 * Every visible terminal asks for this, and each miss costs a `gh` subprocess
 * (1-3 s). PRs are opened and merged on human timescales, so a few minutes of
 * staleness is invisible while the cache is what keeps a grid of terminals from
 * spawning a process storm.
 */
const PR_CACHE_TTL_MS = 5 * 60_000;

/**
 * Longer reuse after a failure. `gh` missing, not authenticated, or the repo
 * not being on GitHub at all are all sticky conditions — retrying them at the
 * normal cadence would spawn a doomed subprocess per terminal per few minutes.
 */
const PR_ERROR_TTL_MS = 15 * 60_000;

interface CacheEntry {
  value: BranchPullRequest | null;
  at: number;
  failed: boolean;
}

const prCache = new Map<string, CacheEntry>();
const activeFetches = new Map<string, Promise<BranchPullRequest | null>>();

/** Cache key. The NUL separator cannot occur in a path or a branch name. */
function cacheKey(repoPath: string, branch: string): string {
  return `${repoPath}\0${branch}`;
}

/**
 * The pull request opened from `branch`, or null when there is none.
 *
 * Deduplicates like {@link getDeduplicatedCurrentBranch}: simultaneous callers
 * (every terminal on the same branch) share one in-flight `gh` call, and later
 * callers reuse the cached answer until it ages out.
 *
 * Never rejects — a repo with no GitHub remote, no `gh`, or no login is an
 * ordinary "no PR to link" for the caller, not an error to render.
 */
export async function getBranchPullRequest(
  repoPath: string,
  branch: string,
): Promise<BranchPullRequest | null> {
  const key = cacheKey(repoPath, branch);

  const cached = prCache.get(key);
  if (cached) {
    const ttl = cached.failed ? PR_ERROR_TTL_MS : PR_CACHE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
  }

  const existing = activeFetches.get(key);
  if (existing) return existing;

  const promise = invoke<BranchPullRequest | null>("github_pr_for_branch", {
    repoPath,
    branch,
  })
    .then((pr) => {
      prCache.set(key, { value: pr ?? null, at: Date.now(), failed: false });
      return pr ?? null;
    })
    .catch(() => {
      prCache.set(key, { value: null, at: Date.now(), failed: true });
      return null;
    })
    .finally(() => {
      activeFetches.delete(key);
    });

  activeFetches.set(key, promise);
  return promise;
}
