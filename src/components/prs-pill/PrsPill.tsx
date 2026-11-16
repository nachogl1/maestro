import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronLeft, ChevronRight, GitPullRequest, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizePath } from "@/lib/path";
import { useProjectColors } from "@/lib/useProjectColors";
import { useGitHubWatchdogStore, watchedProjectsFromTabs } from "@/stores/useGitHubWatchdogStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { checksLabel, createdLabel, type PillPr, reviewLabel, sortPrs } from "./prsPillData";
import { type PrsLoad, type PrsPillProject, usePrsPillStore } from "./usePrsPillStore";

/** The mark for a pull request waiting for my review. */
const REVIEW_MARK = "👁";
const NO_REVIEW_REQUESTS: ReadonlySet<number> = new Set();

/** Where the list is: the projects, one project's pull requests, or one pull request. */
type PrsPath = { key: string; number: number | null } | null;

const ROW =
  "flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-xs text-maestro-text " +
  "transition-colors hover:bg-maestro-card";
const ROW_STATIC = "flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-xs";

const CHECKS_DOT: Record<PillPr["checks"], string> = {
  success: "bg-maestro-green",
  failure: "bg-maestro-red",
  pending: "bg-maestro-orange",
  none: "bg-maestro-muted",
};

/** Open git projects, one per repository (the first tab wins), as the pill reads them. */
export function pillProjects(tabs: WorkspaceTab[]): PrsPillProject[] {
  const gitTabs = tabs.filter((tab) => tab.workspaceType !== "non-git");
  return watchedProjectsFromTabs(gitTabs).map(({ name, repoPath }) => ({
    key: normalizePath(repoPath),
    name,
    repoPath,
  }));
}

const projectsSignature = (projects: PrsPillProject[]): string =>
  projects.map((p) => `${p.key}\u0000${p.name}\u0000${p.repoPath}`).join("\n");

/** The open projects, kept as the same array until a project is opened, closed or renamed. */
function useOpenProjects(): PrsPillProject[] {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const stable = useRef<PrsPillProject[]>([]);
  const next = pillProjects(tabs);
  if (projectsSignature(next) !== projectsSignature(stable.current)) stable.current = next;
  return stable.current;
}

/**
 * The PRs pill in the top bar: the total of open pull requests across open
 * projects, hidden at zero. It opens a list you step into one level at a
 * time (projects with open pull requests → that project's pull requests,
 * waiting-for-my-review first → a detail card with an Open on GitHub link).
 * Fetched at start, on every watchdog poll and on each open; the last
 * results show at once while they refresh.
 */
export function PrsPill() {
  const projects = useOpenProjects();
  const colors = useProjectColors();
  const loads = usePrsPillStore((s) => s.loads);
  const refreshing = usePrsPillStore((s) => s.refreshing);
  const refresh = usePrsPillStore((s) => s.refresh);
  const watchdogProjects = useGitHubWatchdogStore((s) => s.projects);

  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<PrsPath>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  // At start and whenever a project is opened or closed.
  useEffect(() => {
    void refresh(projects);
  }, [projects, refresh]);

  // On the watchdog's 5-minute cadence, so the pill has a count while closed.
  useEffect(
    () =>
      useGitHubWatchdogStore.subscribe((state, prev) => {
        if (state.lastPolledAt !== prev.lastPolledAt) void refresh(projectsRef.current);
      }),
    [refresh],
  );

  const reviewRequests = useMemo(() => {
    const byKey = new Map<string, Set<number>>();
    for (const p of watchdogProjects) {
      byKey.set(normalizePath(p.repoPath), new Set(p.reviewRequests.map((pr) => pr.number)));
    }
    return byKey;
  }, [watchdogProjects]);
  const requestedIn = (key: string) => reviewRequests.get(key) ?? NO_REVIEW_REQUESTS;

  const readyPrs = (load: PrsLoad | undefined): PillPr[] =>
    load?.kind === "ready" ? load.prs : [];
  const total = projects.reduce((sum, p) => sum + readyPrs(loads[p.key]).length, 0);

  const close = useCallback(() => setOpen(false), []);

  // Nothing left to list: the pill hides, and so does an open list.
  useEffect(() => {
    if (total === 0) close();
  }, [total, close]);

  // Close on any outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  if (total === 0) return null;

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    setPath(null);
    void refresh(projects);
  };

  const project = path ? projects.find((p) => p.key === path.key) : undefined;
  const projectLoad = project ? loads[project.key] : undefined;
  const projectPrs = project ? sortPrs(readyPrs(projectLoad), requestedIn(project.key)) : [];
  const pr =
    path?.number != null ? projectPrs.find((candidate) => candidate.number === path.number) : null;
  const level = project && projectPrs.length > 0 ? (pr ? 3 : 2) : 1;

  const anyRefreshing = projects.some((p) => refreshing[p.key]);
  const listed = projects.filter((p) => {
    const load = loads[p.key];
    return load?.kind === "error" || readyPrs(load).length > 0;
  });

  const dot = (p: PrsPillProject) => (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: colors.get(p.name) }}
    />
  );

  const renderProjectRow = (p: PrsPillProject) => {
    const load = loads[p.key];
    if (load?.kind === "error") {
      return (
        <div key={p.key} className={ROW_STATIC}>
          {dot(p)}
          <span className="min-w-0 flex-1 truncate text-maestro-text">{p.name}</span>
          <span className="text-[10.5px] text-maestro-red" role="alert">
            Could not load: {load.message.replace(/\.$/, "")}.{" "}
            <button
              type="button"
              className="text-maestro-text underline"
              onClick={() => void refresh([p])}
            >
              Try again
            </button>
          </span>
        </div>
      );
    }
    const prs = readyPrs(load);
    const mine = prs.filter((x) => requestedIn(p.key).has(x.number)).length;
    return (
      <button
        key={p.key}
        type="button"
        className={ROW}
        onClick={() => setPath({ key: p.key, number: null })}
      >
        {dot(p)}
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        {mine > 0 && (
          <span
            className="text-[11px] text-maestro-accent"
            title={`${mine} waiting for your review`}
          >
            {REVIEW_MARK} {mine}
          </span>
        )}
        <span className="text-[10px] text-maestro-muted">{prs.length} open</span>
        <ChevronRight size={12} className="text-maestro-muted" />
      </button>
    );
  };

  const renderPrRow = (p: PrsPillProject, x: PillPr) => (
    <button
      key={x.number}
      type="button"
      className={ROW}
      onClick={() => setPath({ key: p.key, number: x.number })}
    >
      <span className="w-[38px] shrink-0 tabular-nums text-maestro-muted">#{x.number}</span>
      <span className="min-w-0 flex-1 truncate">{x.title}</span>
      {x.isDraft && (
        <span className="rounded-full border border-maestro-border px-1.5 text-[9.5px] text-maestro-muted">
          draft
        </span>
      )}
      {requestedIn(p.key).has(x.number) && (
        <span
          role="img"
          aria-label="Waiting for your review"
          title="Waiting for your review"
          className="text-[11px] text-maestro-accent"
        >
          {REVIEW_MARK}
        </span>
      )}
      <ChevronRight size={12} className="text-maestro-muted" />
    </button>
  );

  const renderDetail = (p: PrsPillProject, x: PillPr) => (
    <div className="px-2.5 pt-2 pb-2.5">
      <div className="mb-0.5 text-[13px] font-semibold text-maestro-text">{x.title}</div>
      <div className="mb-2 text-[11px] text-maestro-muted">
        #{x.number} · by {x.author}
      </div>
      {requestedIn(p.key).has(x.number) && (
        <div className="mb-2 text-[11px] text-maestro-accent">
          {REVIEW_MARK} Waiting for your review
        </div>
      )}
      <dl className="grid grid-cols-[70px_1fr] gap-x-2 gap-y-1 text-[11.5px] text-maestro-text">
        <dt className="text-maestro-muted">State</dt>
        <dd>{x.isDraft ? "Draft" : "Ready for review"}</dd>
        <dt className="text-maestro-muted">Checks</dt>
        <dd className="flex items-center gap-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${CHECKS_DOT[x.checks]}`} />
          {checksLabel(x.checks)}
        </dd>
        <dt className="text-maestro-muted">Review</dt>
        <dd>{reviewLabel(x.reviewDecision)}</dd>
        <dt className="text-maestro-muted">Created</dt>
        <dd>{createdLabel(x.createdAt, new Date())}</dd>
      </dl>
      <button
        type="button"
        className="mt-2.5 w-full rounded border border-maestro-accent/60 py-1 text-xs font-semibold text-maestro-accent transition-colors hover:bg-maestro-accent/10"
        onClick={() => {
          if (!x.url.startsWith("https://")) return;
          openUrl(x.url).catch((err) => console.error("Failed to open pull request URL:", err));
        }}
      >
        Open on GitHub ↗
      </button>
    </div>
  );

  const renderBody = () => {
    if (level === 3 && project && pr) return renderDetail(project, pr);
    if (level === 2 && project) {
      return (
        <>
          {projectLoad?.kind === "ready" && projectLoad.truncated && (
            <div className="px-2.5 py-1 text-[10px] text-maestro-muted">
              Only the newest pull requests were read, so the count may be low.
            </div>
          )}
          {projectPrs.map((x) => renderPrRow(project, x))}
        </>
      );
    }
    return listed.map(renderProjectRow);
  };

  const crumbLink = (text: string, onClick: () => void) => (
    <button type="button" className="uppercase hover:text-maestro-text" onClick={onClick}>
      {text}
    </button>
  );

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`mr-1 flex items-center gap-1 rounded-full border bg-maestro-card px-2 py-0.5 text-[10px] font-bold tracking-wider transition-colors ${
          open
            ? "border-maestro-accent/60 text-maestro-accent"
            : "border-maestro-border text-maestro-text hover:border-maestro-accent/60 hover:text-maestro-accent"
        }`}
        title="Open pull requests in your open projects"
      >
        <GitPullRequest size={11} />
        <span className="tabular-nums">{total}</span> <span>{total === 1 ? "PR" : "PRs"}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-[340px] rounded-md border border-maestro-border bg-maestro-surface shadow-lg"
          role="dialog"
          aria-label="Pull requests list"
        >
          <div className="flex items-center gap-1.5 border-b border-maestro-border px-2 py-1.5">
            <button
              type="button"
              aria-label="Back"
              title="Back"
              onClick={() =>
                setPath(level === 3 && project ? { key: project.key, number: null } : null)
              }
              className={`rounded px-0.5 text-maestro-muted hover:bg-maestro-card hover:text-maestro-text ${
                level === 1 ? "invisible" : ""
              }`}
            >
              <ChevronLeft size={13} />
            </button>
            <nav
              aria-label="Path"
              className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-maestro-muted"
            >
              {level === 1 || !project ? (
                "Pull requests"
              ) : (
                <>
                  {crumbLink("Pull requests", () => setPath(null))}
                  {" › "}
                  {level === 3
                    ? crumbLink(project.name, () => setPath({ key: project.key, number: null }))
                    : project.name}
                  {level === 3 && pr && ` › #${pr.number}`}
                </>
              )}
            </nav>
            {anyRefreshing && (
              <span
                className="flex items-center gap-1 whitespace-nowrap text-[10px] text-maestro-muted"
                title="Showing the last results while they refresh"
              >
                <Loader2 size={9} className="animate-spin text-maestro-accent" />
                updating
              </span>
            )}
          </div>
          <div className="max-h-[340px] overflow-y-auto py-1">{renderBody()}</div>
          <div className="border-t border-maestro-border px-2.5 py-1 text-[10px] text-maestro-muted">
            {anyRefreshing ? "Updating…" : "Updated just now."}
          </div>
        </div>
      )}
    </div>
  );
}
