import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  History,
  Info,
  MessagesSquare,
  Play,
  RotateCcw,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { formatRecentDate } from "@/lib/format";
import { normalizePath } from "@/lib/path";
import { projectColorFor } from "@/lib/projectColor";
import {
  type ClaudeSessionInfo,
  type ClaudeSessionListing,
  EMPTY_CLAUDE_SESSION_LISTING,
  listClaudeSessions,
} from "@/lib/terminal";
import { listWorktrees, type WorktreeInfo } from "@/lib/worktreeManager";
import { useActivityStore } from "@/stores/useActivityStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { type SessionSummaryEntry, useSessionSummaryStore } from "@/stores/useSessionSummaryStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { HistoryConversationLabel } from "./HistoryConversationLabel";
import { cardClass, SectionHeader } from "./sectionChrome";

/** Cap per project — "show all" lifts it, so nothing is cut silently. */
const MAX_CONVERSATIONS_SHOWN = 10;

/**
 * The one case this tab cannot cover, stated where it would otherwise look
 * like a bug. Maestro keeps worktrees in app data, outside the repo, so their
 * encoded transcript directory shares no prefix with the project path — once
 * the worktree is deleted nothing left on disk names it.
 */
const KNOWN_LIMIT =
  "Not listed: conversations from a deleted worktree that lived outside the repo — Maestro keeps worktrees in app data, and once the directory is gone nothing names it.";

interface ProjectHistory {
  loading: boolean;
  /** The checkout the scan was rooted at — what "CHECKOUT" means for this tab. */
  repoPath: string;
  listing: ClaudeSessionListing;
  worktrees: WorktreeInfo[];
  /** Non-null when a load call failed: an error state, never an empty list. */
  error: string | null;
}

/** Last path segment, for a compact directory label. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Exact timestamp, for the hover the relative label cannot give. */
function formatAbsoluteTime(isoDate: string): string {
  const then = new Date(isoDate);
  return Number.isFinite(then.getTime()) ? then.toLocaleString() : isoDate;
}

/** What a conversation's directory IS, relative to this project tab. */
type GroupKind = "checkout" | "worktree" | "other" | "missing" | "unknown";

/** Checkout first, then live worktrees, then the directories that are gone. */
const KIND_RANK: Record<GroupKind, number> = {
  checkout: 0,
  worktree: 1,
  other: 2,
  missing: 3,
  unknown: 4,
};

/** Group key for transcripts that never recorded a working directory. */
const NO_DIR_KEY = "\u0000no-directory";

/** Registered worktree paths, normalized, excluding the checkout itself. */
function worktreeKeySet(repoKey: string, worktrees: WorktreeInfo[]): Set<string> {
  return new Set(
    worktrees
      .filter((w) => !w.is_bare && normalizePath(w.path) !== repoKey)
      .map((w) => normalizePath(w.path)),
  );
}

/**
 * What a single conversation's directory IS — the per-row half of grouping,
 * pulled out so the search/filter row can classify a conversation without
 * building a whole group.
 */
function classifyConversationKind(
  conv: ClaudeSessionInfo,
  repoKey: string,
  worktreeKeys: Set<string>,
): GroupKind {
  if (conv.cwd === null) return "unknown";
  const key = normalizePath(conv.cwd);
  if (key === repoKey) return "checkout";
  if (worktreeKeys.has(key)) return "worktree";
  return conv.cwd_exists ? "other" : "missing";
}

/**
 * Case-insensitive substring match for the search box: the agent name, the
 * session name and AI summary shown on the row, the prompt previews, the directory (full path
 * and basename), the git branch, and the session id — everything a user might
 * recognise a conversation by.
 */
function matchesSearch(
  conv: ClaudeSessionInfo,
  needle: string,
  aiLabel: SessionSummaryEntry | undefined,
): boolean {
  const haystacks = [
    conv.agent_name,
    conv.title,
    aiLabel?.name,
    aiLabel?.summary,
    conv.summary,
    conv.first_prompt,
    conv.last_prompt,
    conv.cwd,
    conv.cwd ? baseName(conv.cwd) : null,
    conv.git_branch,
    conv.session_id,
  ];
  return haystacks.some((h) => h?.toLowerCase().includes(needle));
}

/** One directory and every conversation that ran in it. */
interface ConversationGroup {
  key: string;
  kind: GroupKind;
  /** Null only for `unknown` — the transcript recorded no directory. */
  path: string | null;
  /** The worktree's currently checked-out branch, for its launch button. */
  branch: string | null;
  conversations: ClaudeSessionInfo[];
}

/**
 * Buckets conversations by the directory they ran in, so the
 * conversation→worktree relationship is visible rather than inferred.
 *
 * The checkout and every registered worktree get a group whether or not they
 * hold conversations — an empty worktree is still somewhere you can launch.
 * Any other directory a conversation names becomes its own group, classified
 * by what it is: a directory still on disk, one that is gone, or none at all.
 */
function groupConversations(
  conversations: ClaudeSessionInfo[],
  repoPath: string,
  worktrees: WorktreeInfo[],
): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>();
  const repoKey = normalizePath(repoPath);
  groups.set(repoKey, {
    key: repoKey,
    kind: "checkout",
    path: repoPath,
    branch: null,
    conversations: [],
  });

  // Skip only the worktree that IS repoPath under another spelling. Keying on
  // is_main_worktree here hid the main checkout's conversations whenever the
  // project tab points at a LINKED worktree — is_main marks the repo's first
  // worktree, not the one this tab opened.
  for (const worktree of worktrees) {
    const key = normalizePath(worktree.path);
    if (worktree.is_bare || key === repoKey || groups.has(key)) continue;
    groups.set(key, {
      key,
      kind: "worktree",
      path: worktree.path,
      branch: worktree.branch,
      conversations: [],
    });
  }

  const worktreeKeys = worktreeKeySet(repoKey, worktrees);
  for (const conv of conversations) {
    const key = conv.cwd ? normalizePath(conv.cwd) : NO_DIR_KEY;
    const existing = groups.get(key);
    if (existing) {
      existing.conversations.push(conv);
      continue;
    }
    groups.set(key, {
      key,
      kind: classifyConversationKind(conv, repoKey, worktreeKeys),
      path: conv.cwd,
      branch: null,
      conversations: [conv],
    });
  }

  // Conversations arrive newest-first, so `[0]` is each group's newest.
  return [...groups.values()].sort((a, b) => {
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return (b.conversations[0]?.last_active ?? "").localeCompare(
      a.conversations[0]?.last_active ?? "",
    );
  });
}

interface HistorySectionProps {
  /** Called after a recovery launch is queued so App can reveal the project. */
  onLaunch?: (tabId: string) => void;
  /**
   * Zoom into a live terminal — the same sidebar→terminal route the Agents and
   * Launch sections take. Used to reach a conversation that is hidden from the
   * resume list because it is already running.
   */
  onNavigate?: (tabId: string, sessionId: number) => void;
}

/**
 * Sidebar History tab: per-project collapsibles listing past Claude
 * conversations grouped by the checkout or worktree they ran in — one click
 * resumes a conversation, one click launches a fresh agent in a worktree.
 * Conversations currently running in a terminal are listed separately (with a
 * jump to that terminal) rather than dropped, and everything the scan could
 * not return — a display cap, Claude's own cap, unreadable transcripts, a load
 * failure — is stated. Rows that cannot resume (`claude --resume` only works
 * from the transcript's own directory, issue #104) are disabled with the
 * reason in place, never silently retargeted. Everything here is
 * non-destructive: deleting worktrees stays in the git panel.
 */
export function HistorySection({ onLaunch, onNavigate }: HistorySectionProps) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const setSessionsLaunched = useWorkspaceStore((s) => s.setSessionsLaunched);
  const requestLaunch = usePendingLaunchStore((s) => s.request);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [history, setHistory] = useState<Record<string, ProjectHistory>>({});

  // Search, shared across every project — component state only, reset on
  // remount, never persisted.
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim().toLowerCase();
  const isSearching = trimmedQuery.length > 0;
  const aiLabels = useSessionSummaryStore((s) => s.entries);

  // Claude conversation UUIDs currently attached to a live terminal, mapped to
  // the terminal running them so the row can offer a jump instead of a resume.
  const activitySessions = useActivityStore((s) => s.sessions);
  const liveSessions = useSessionStore((s) => s.sessions);
  const liveConversations = useMemo(() => {
    const liveIds = new Set(liveSessions.map((s) => s.id));
    // Value null = live, but its terminal is in no open tab, so there is
    // nowhere to jump to. Key presence alone is what hides the resume row.
    const targets = new Map<string, { tabId: string; sessionId: number } | null>();
    for (const [maestroId, activity] of Object.entries(activitySessions)) {
      const sessionId = Number(maestroId);
      if (!liveIds.has(sessionId)) continue;
      const owner = tabs.find((t) => t.sessionIds.includes(sessionId));
      // conversationUuids is kept outside the capped event list: deriving
      // this from SessionStarted events broke once a long session evicted
      // its own start event, making a live conversation double-resumable.
      for (const uuid of activity.conversationUuids) {
        targets.set(uuid, owner ? { tabId: owner.id, sessionId } : null);
      }
    }
    return targets;
  }, [activitySessions, liveSessions, tabs]);

  const loadProject = useCallback(async (tab: WorkspaceTab) => {
    const repoPath = tab.selectedRepoPath ?? tab.projectPath;
    setHistory((prev) => ({
      ...prev,
      [tab.id]: {
        loading: true,
        repoPath,
        listing: EMPTY_CLAUDE_SESSION_LISTING,
        worktrees: [],
        error: null,
      },
    }));

    // Failures are collected, never swallowed: a permission error used to be
    // indistinguishable from "this project has no history".
    const errors: string[] = [];
    const worktrees = await listWorktrees(repoPath).catch((err) => {
      errors.push(`Worktrees could not be listed (${String(err)}).`);
      return [] as WorktreeInfo[];
    });

    // ONE call, not one per directory: the backend sweeps the checkout's own
    // transcript directory, every directory encoded from a path under it (repo
    // subdirectories and worktrees that lived inside the repo, deleted ones
    // included), and each extra root. Maestro keeps worktrees OUTSIDE the repo,
    // where no prefix can reach them, so they only come into scope by being
    // passed here — and a worktree list that failed above means fewer roots,
    // which is exactly why that failure is reported rather than ignored.
    const extraRoots = worktrees.filter((w) => !w.is_bare).map((w) => w.path);
    const listing = await listClaudeSessions(repoPath, extraRoots).catch((err) => {
      errors.push(`Conversations could not be listed (${String(err)}).`);
      return EMPTY_CLAUDE_SESSION_LISTING;
    });

    setHistory((prev) => ({
      ...prev,
      [tab.id]: {
        loading: false,
        repoPath,
        listing,
        worktrees,
        error: errors.length > 0 ? errors.join(" ") : null,
      },
    }));
  }, []);

  const toggleProject = useCallback(
    (tab: WorkspaceTab) => {
      setExpanded((prev) => ({ ...prev, [tab.id]: !prev[tab.id] }));
      if (!expanded[tab.id]) void loadProject(tab);
    },
    [expanded, loadProject],
  );

  /** Queue the launch, make sure the project's grid mounts, reveal it. */
  const queueLaunch = useCallback(
    (
      tab: WorkspaceTab,
      resumeSessionId: string | null,
      workingDir: string | null,
      branch: string | null,
    ) => {
      requestLaunch({
        tabId: tab.id,
        mode: "Claude",
        resumeSessionId,
        workingDirOverride: workingDir,
        branch,
      });
      setSessionsLaunched(tab.id, true);
      onLaunch?.(tab.id);
    },
    [requestLaunch, setSessionsLaunched, onLaunch],
  );

  return (
    <div>
      <SectionHeader icon={History} label="History" />
      <p className="mb-2 text-[10px] leading-snug text-maestro-muted">
        Recover past agent conversations and worktrees. Click one to relaunch it in its project — no
        typing needed.
      </p>

      <div className="relative mb-2">
        <Search
          size={11}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-maestro-muted/60"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations..."
          aria-label="Search conversations"
          className="w-full rounded border border-maestro-border bg-maestro-card py-1 pl-6 pr-6 text-[11px] text-maestro-text placeholder:text-maestro-muted/50 focus:border-maestro-accent focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
          >
            <X size={11} />
          </button>
        )}
      </div>

      {tabs.map((tab) => {
        const color = projectColorFor(tab.name);
        const isOpen = Boolean(expanded[tab.id]);
        const data = history[tab.id];
        const listing = data?.listing ?? EMPTY_CLAUDE_SESSION_LISTING;
        const running = listing.sessions.filter((c) => liveConversations.has(c.session_id));
        const resumable = listing.sessions.filter((c) => !liveConversations.has(c.session_id));

        const repoPath = data?.repoPath ?? tab.projectPath;
        const worktreeList = data?.worktrees ?? [];
        const matched = isSearching
          ? resumable.filter((conv) => matchesSearch(conv, trimmedQuery, aiLabels[conv.session_id]))
          : resumable;

        const expandAll = Boolean(showAll[tab.id]);
        // A search that hides its own matches behind the cap is useless, so
        // the cap only applies when the user isn't actively searching. Lifting
        // it is still bounded: the backend returns at most MAX_SESSIONS_RETURNED
        // (50, claude_sessions.rs) per project, so no virtualization is needed.
        const shown =
          isSearching || expandAll ? matched : matched.slice(0, MAX_CONVERSATIONS_SHOWN);
        const hiddenByCap = isSearching ? 0 : matched.length - shown.length;
        const droppedByBackend = listing.total_found - listing.sessions.length;
        const groups = groupConversations(shown, repoPath, worktreeList);
        const searchHidesEverything = isSearching && matched.length === 0 && resumable.length > 0;

        return (
          <div key={tab.id} className={`${cardClass} mb-2 !p-2`}>
            <button
              type="button"
              onClick={() => toggleProject(tab)}
              className="flex w-full items-center gap-1.5 text-left text-xs font-semibold text-maestro-text"
            >
              {isOpen ? (
                <ChevronDown size={12} className="shrink-0 text-maestro-muted" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-maestro-muted" />
              )}
              <FolderGit2 size={12} className="shrink-0" style={{ color }} />
              <span className="truncate" style={{ color }}>
                {tab.name}
              </span>
            </button>

            {isOpen && (
              <div className="mt-1.5">
                {data?.loading ? (
                  <p className="px-1 py-0.5 text-[10px] text-maestro-muted">Loading…</p>
                ) : (
                  <>
                    {data?.error && (
                      <div className="mb-1.5 flex items-start gap-1 rounded border border-maestro-red/40 bg-maestro-red/10 p-1 text-[10px] leading-snug text-maestro-red">
                        <AlertTriangle size={11} className="mt-px shrink-0" />
                        <span className="min-w-0 flex-1">
                          {data.error} This list is incomplete.
                        </span>
                        <button
                          type="button"
                          onClick={() => void loadProject(tab)}
                          className="shrink-0 rounded px-1 font-semibold underline hover:bg-maestro-surface"
                        >
                          Retry
                        </button>
                      </div>
                    )}

                    {running.length > 0 && (
                      <div className="mb-1.5 rounded border border-maestro-border/50 bg-maestro-surface/50 p-1">
                        <p className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-maestro-muted/80">
                          Running now — {running.length} not resumable
                        </p>
                        {running.map((conv) => {
                          const target = liveConversations.get(conv.session_id) ?? null;
                          const canJump = Boolean(target && onNavigate);
                          return (
                            // The reason rides the wrapper: a disabled button
                            // takes no pointer events, so its own title never
                            // surfaces on hover.
                            <span
                              key={conv.session_id}
                              className="flex"
                              title={
                                canJump
                                  ? "Open the terminal running this conversation"
                                  : "Running in this Maestro session, but its terminal is not in an open project tab"
                              }
                            >
                              <button
                                type="button"
                                disabled={!canJump}
                                onClick={() =>
                                  target && onNavigate?.(target.tabId, target.sessionId)
                                }
                                aria-label={`Open the live terminal for conversation ${conv.session_id.slice(0, 8)}`}
                                className="group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-maestro-surface disabled:opacity-40"
                              >
                                <TerminalSquare
                                  size={11}
                                  className="shrink-0 text-maestro-muted group-hover:text-maestro-accent"
                                />
                                <HistoryConversationLabel conv={conv} compact />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {isSearching && resumable.length > 0 && (
                      <p className="mb-1 px-1 text-[10px] text-maestro-muted">
                        {matched.length} of {resumable.length} conversation
                        {resumable.length === 1 ? "" : "s"}
                      </p>
                    )}

                    {searchHidesEverything ? (
                      <div className="mb-1.5 rounded border border-maestro-border/50 bg-maestro-surface/30 p-2 text-center">
                        <p className="text-[10px] text-maestro-muted">
                          No conversations match your search.
                        </p>
                        <button
                          type="button"
                          onClick={() => setQuery("")}
                          className="mt-1 rounded px-2 py-0.5 text-[10px] font-semibold text-maestro-accent hover:bg-maestro-surface"
                        >
                          Clear search
                        </button>
                      </div>
                    ) : (
                      <>
                        {groups.map((group) => {
                          return (
                            <div key={group.key} className="mb-1.5">
                              <div className="flex items-center gap-1 px-1">
                                <FolderGit2 size={10} className="shrink-0 text-maestro-muted" />
                                <span
                                  className="min-w-0 flex-1 truncate text-[10px] font-semibold text-maestro-text"
                                  title={group.path ?? "No directory recorded in the transcript"}
                                >
                                  {group.path ? baseName(group.path) : "Unknown directory"}
                                </span>
                                {group.kind === "worktree" && group.path && (
                                  <button
                                    type="button"
                                    onClick={() => queueLaunch(tab, null, group.path, group.branch)}
                                    aria-label={`Launch an agent in ${group.path}`}
                                    title={`Launch an agent in ${group.path}`}
                                    className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-green"
                                  >
                                    <Play size={11} />
                                  </button>
                                )}
                              </div>

                              {group.conversations.length === 0 ? (
                                <p className="px-1 text-[10px] text-maestro-muted">
                                  No conversations here
                                </p>
                              ) : (
                                group.conversations.map((conv) => {
                                  return (
                                    <button
                                      key={conv.session_id}
                                      type="button"
                                      disabled={!conv.resumable}
                                      // Resume in the conversation's own directory —
                                      // `claude --resume` cannot find the session
                                      // from anywhere else, which is also why rows
                                      // whose directory is gone are disabled
                                      // outright instead of silently retargeting
                                      // the launch (issue #104).
                                      onClick={() =>
                                        queueLaunch(tab, conv.session_id, conv.cwd, conv.git_branch)
                                      }
                                      title={
                                        conv.resumable
                                          ? `Resume this conversation in ${conv.cwd}`
                                          : `Not resumable — ${conv.resume_blocked_reason ?? "unknown reason"}${
                                              conv.cwd ? ` (ran in ${conv.cwd})` : ""
                                            }`
                                      }
                                      className="group mb-0.5 flex w-full items-start gap-1.5 rounded px-1 py-1 text-left transition-colors enabled:hover:bg-maestro-surface disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                      {conv.resumable ? (
                                        <RotateCcw
                                          size={11}
                                          className="mt-0.5 shrink-0 text-maestro-muted group-hover:text-maestro-accent"
                                        />
                                      ) : (
                                        <Ban
                                          size={11}
                                          className="mt-0.5 shrink-0 text-maestro-red"
                                        />
                                      )}
                                      <span className="min-w-0 flex-1">
                                        {/* Identity: the session name and an AI
                                        summary of what it did — the prompt text
                                        alone rarely identifies a run. */}
                                        <HistoryConversationLabel conv={conv} />
                                        <span className="flex flex-wrap items-center gap-1.5 text-[9px] text-maestro-muted">
                                          <span
                                            className="shrink-0"
                                            title={formatAbsoluteTime(conv.last_active)}
                                          >
                                            {formatRecentDate(conv.last_active)}
                                          </span>
                                          {conv.git_branch && (
                                            <span className="flex min-w-0 items-center gap-0.5">
                                              <GitBranch size={8} />
                                              <span className="truncate">{conv.git_branch}</span>
                                            </span>
                                          )}
                                          <span className="flex items-center gap-0.5">
                                            <MessagesSquare size={8} />
                                            {conv.message_count} msgs
                                          </span>
                                        </span>
                                        {!conv.resumable && (
                                          <span className="mt-0.5 flex items-center gap-1 text-[9px] font-medium text-maestro-red">
                                            <Ban size={8} className="shrink-0" />
                                            <span className="truncate">
                                              Not resumable —{" "}
                                              {conv.resume_blocked_reason ?? "unknown reason"}
                                            </span>
                                          </span>
                                        )}
                                      </span>
                                    </button>
                                  );
                                })
                              )}
                            </div>
                          );
                        })}

                        {hiddenByCap > 0 && (
                          <button
                            type="button"
                            onClick={() => setShowAll((prev) => ({ ...prev, [tab.id]: true }))}
                            className="mb-0.5 w-full rounded px-1 py-0.5 text-left text-[10px] text-maestro-accent hover:bg-maestro-surface"
                          >
                            Showing {shown.length} of {resumable.length} — show all
                          </button>
                        )}
                        {expandAll && resumable.length > MAX_CONVERSATIONS_SHOWN && (
                          <button
                            type="button"
                            onClick={() => setShowAll((prev) => ({ ...prev, [tab.id]: false }))}
                            className="mb-0.5 w-full rounded px-1 py-0.5 text-left text-[10px] text-maestro-accent hover:bg-maestro-surface"
                          >
                            Showing all {resumable.length} — show only the {MAX_CONVERSATIONS_SHOWN}{" "}
                            most recent
                          </button>
                        )}
                      </>
                    )}

                    {listing.truncated && (
                      <p className="px-1 text-[9px] leading-snug text-maestro-orange">
                        Claude's own list is capped: {listing.sessions.length} of{" "}
                        {listing.total_found} conversations were returned. The other{" "}
                        {droppedByBackend} are still on disk — resume one with{" "}
                        <code>claude --resume</code> from its directory.
                      </p>
                    )}
                    {listing.unreadable > 0 && (
                      <p className="px-1 text-[9px] leading-snug text-maestro-orange">
                        {listing.unreadable} transcript{listing.unreadable === 1 ? "" : "s"} could
                        not be read and {listing.unreadable === 1 ? "is" : "are"} not listed (logged
                        with the file path).
                      </p>
                    )}

                    <p className="mt-1 flex items-start gap-1 px-1 text-[9px] leading-snug text-maestro-muted/80">
                      <Info size={9} className="mt-0.5 shrink-0" />
                      <span>{KNOWN_LIMIT}</span>
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
