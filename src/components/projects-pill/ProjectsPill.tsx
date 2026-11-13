import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderKanban,
  Loader2,
  Lock,
  Unlock,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectColors } from "@/lib/useProjectColors";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import {
  isNoRepositoryError,
  loadPillProject,
  type PillIssue,
  type PillProjectData,
  visibleIssues,
} from "./projectsPillData";
import { useProjectsPillLockStore } from "./useProjectsPillLockStore";

/** One open project tab, as the list's first level shows it. */
interface PillProject {
  id: string;
  name: string;
  repoPath: string;
  /** The tab's folder is not a git repository, so there is nothing to ask GitHub. */
  nonGit: boolean;
}

type ProjectLoad =
  | { kind: "loading" }
  | { kind: "no-repo" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: PillProjectData };

/** Where the list is: the projects, one project's labels, or one label's issues. */
type PillPath = { projectId: string; label: string | null } | null;

const LOCK_TIP_COUNTED =
  "Counting every open issue, blocked ones included (marked with a lock). Click to count only " +
  "ready issues: those with no open blocker, by the same rule as the issue map.";
const LOCK_TIP_READY =
  "Counting only ready issues: those with no open blocker, by the same rule as the issue map. " +
  "Click to count blocked issues too.";
const LOADED_NOTE = "Loaded just now. Counts refresh each time you open this list.";
const FALLBACK_LABEL_COLOR = "82828e";
const HEX_COLOR_RE = /^[0-9a-f]{6}$/i;

const labelColor = (color: string): string =>
  `#${HEX_COLOR_RE.test(color) ? color : FALLBACK_LABEL_COLOR}`;

const ROW =
  "flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-xs text-maestro-text " +
  "transition-colors hover:bg-maestro-card";
const ROW_STATIC = "flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-xs";

/**
 * The PROJECTS pill in the top bar: a list you step into one level at a time
 * (open projects → their labels with open-issue counts → one label's open
 * issues, which open on GitHub). Loads only when it opens, every time, and
 * never polls.
 */
export function ProjectsPill() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const colors = useProjectColors();
  const countBlocked = useProjectsPillLockStore((s) => s.countBlocked);
  const setCountBlocked = useProjectsPillLockStore((s) => s.setCountBlocked);

  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<PillProject[]>([]);
  const [loads, setLoads] = useState<Record<string, ProjectLoad>>({});
  const [path, setPath] = useState<PillPath>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Latest load per project id; a result from an older load (or from before
  // the list closed) is dropped.
  const loadSeq = useRef(0);
  const latestLoad = useRef<Record<string, number>>({});

  const tabProjects = useMemo<PillProject[]>(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        repoPath: tab.selectedRepoPath ?? tab.projectPath,
        nonGit: tab.workspaceType === "non-git",
      })),
    [tabs],
  );

  const loadProject = useCallback(async (project: PillProject): Promise<void> => {
    const seq = ++loadSeq.current;
    latestLoad.current[project.id] = seq;
    const settle = (load: ProjectLoad) => {
      if (latestLoad.current[project.id] !== seq) return;
      setLoads((current) => ({ ...current, [project.id]: load }));
    };
    if (project.nonGit) {
      settle({ kind: "no-repo" });
      return;
    }
    settle({ kind: "loading" });
    try {
      settle({ kind: "ready", data: await loadPillProject(project.repoPath) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isNoRepositoryError(message)) {
        settle({ kind: "no-repo" });
      } else {
        console.error(`Failed to load the PROJECTS list for ${project.name}:`, err);
        settle({ kind: "error", message });
      }
    }
  }, []);

  const close = useCallback(() => {
    latestLoad.current = {};
    setOpen(false);
  }, []);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    setPath(null);
    setProjects(tabProjects);
    setLoads(Object.fromEntries(tabProjects.map((p) => [p.id, { kind: "loading" }])));
    for (const project of tabProjects) void loadProject(project);
  };

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

  const project = path ? projects.find((p) => p.id === path.projectId) : undefined;
  const projectLoad = project ? loads[project.id] : undefined;
  const projectData = projectLoad?.kind === "ready" ? projectLoad.data : null;
  const label =
    path?.label && projectData ? projectData.labels.find((l) => l.name === path.label) : undefined;
  const level = !project ? 1 : label ? 3 : 2;

  const onToggleLock = () => {
    const next = !countBlocked;
    setCountBlocked(next);
    // A label whose every issue is blocked has nothing left to list: step back.
    if (label && visibleIssues(label.issues, next).length === 0 && project) {
      setPath({ projectId: project.id, label: null });
    }
  };

  const anyLoading = Object.values(loads).some((l) => l.kind === "loading");
  const bodyLoading = level === 1 ? anyLoading : projectLoad?.kind === "loading";

  const renderProjectRow = (p: PillProject) => {
    const load = loads[p.id];
    const dot = (
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: colors.get(p.name) }}
      />
    );
    if (load?.kind === "no-repo") {
      return (
        <div key={p.id} className={`${ROW_STATIC} text-maestro-muted`} aria-disabled="true">
          {dot}
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <span className="text-[10px]">no GitHub repository</span>
        </div>
      );
    }
    const count =
      load?.kind === "ready" ? visibleIssues(load.data.openIssues, countBlocked).length : null;
    return (
      <button
        key={p.id}
        type="button"
        className={ROW}
        onClick={() => setPath({ projectId: p.id, label: null })}
      >
        {dot}
        <span className="min-w-0 flex-1 truncate">{p.name}</span>
        {count !== null && <span className="text-[10px] text-maestro-muted">{count} open</span>}
        <ChevronRight size={12} className="text-maestro-muted" />
      </button>
    );
  };

  const renderLabelRows = (data: PillProjectData) => {
    if (data.labels.length === 0) {
      return (
        <div className="px-2.5 py-3 text-xs text-maestro-muted">This repository has no labels.</div>
      );
    }
    return data.labels.map((l) => {
      const n = visibleIssues(l.issues, countBlocked).length;
      const color = labelColor(l.color);
      const content = (
        <>
          <span
            className="truncate rounded-full border px-1.5 text-[10.5px] font-semibold"
            style={{ color, borderColor: `${color}66`, backgroundColor: `${color}1a` }}
          >
            {l.name}
          </span>
          <span className="flex-1" />
          <span
            className={`min-w-[22px] text-right tabular-nums ${
              n === 0 ? "text-maestro-muted" : "font-semibold"
            }`}
          >
            {n}
          </span>
        </>
      );
      if (n === 0) {
        return (
          <div key={l.name} className={`${ROW_STATIC} pr-[26px]`} data-testid="pill-label-row">
            {content}
          </div>
        );
      }
      return (
        <button
          key={l.name}
          type="button"
          className={ROW}
          data-testid="pill-label-row"
          onClick={() => project && setPath({ projectId: project.id, label: l.name })}
        >
          {content}
          <ChevronRight size={12} className="text-maestro-muted" />
        </button>
      );
    });
  };

  const renderIssueRow = (issue: PillIssue) => (
    <button
      key={issue.number}
      type="button"
      className={ROW}
      title={`Open #${issue.number} on GitHub`}
      onClick={() => {
        if (!issue.url.startsWith("https://")) return;
        openUrl(issue.url).catch((err) => console.error("Failed to open issue URL:", err));
      }}
    >
      <span className="w-[38px] shrink-0 tabular-nums text-maestro-muted">#{issue.number}</span>
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      {issue.blocked && (
        <span
          role="img"
          title="Blocked: has an open blocker"
          aria-label="Blocked"
          className="text-maestro-yellow"
        >
          <Lock size={10} />
        </span>
      )}
      <ExternalLink size={10} className="text-maestro-muted" />
    </button>
  );

  const renderBody = () => {
    if (bodyLoading) {
      return (
        <output className="flex items-center gap-2 px-2.5 py-3.5 text-xs text-maestro-muted">
          <Loader2 size={14} className="animate-spin text-maestro-accent" />
          Loading labels and counts…
        </output>
      );
    }
    if (level === 1) {
      if (projects.length === 0) {
        return <div className="px-2.5 py-3 text-xs text-maestro-muted">No projects are open.</div>;
      }
      return projects.map(renderProjectRow);
    }
    if (projectLoad?.kind === "error" && project) {
      return (
        <div className="px-2.5 py-2.5 text-[11px] text-maestro-red" role="alert">
          Could not load this repository's labels: {projectLoad.message.replace(/\.$/, "")}.{" "}
          <button
            type="button"
            className="text-maestro-text underline"
            onClick={() => void loadProject(project)}
          >
            Try again
          </button>
        </div>
      );
    }
    if (projectLoad?.kind === "no-repo") {
      return <div className="px-2.5 py-3 text-xs text-maestro-muted">No GitHub repository.</div>;
    }
    if (!projectData) return null;
    if (level === 2) {
      return (
        <>
          {projectData.truncated && (
            <div className="px-2.5 py-1 text-[10px] text-maestro-muted">
              Only the newest issues were read, so counts may be low.
            </div>
          )}
          {renderLabelRows(projectData)}
        </>
      );
    }
    const issues = label ? visibleIssues(label.issues, countBlocked) : [];
    if (issues.length === 0) {
      return (
        <div className="px-2.5 py-3 text-xs text-maestro-muted">
          No ready issues with this label.
        </div>
      );
    }
    return issues.map(renderIssueRow);
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
        title="Open issues per label, for every open project"
      >
        <FolderKanban size={11} />
        <span>PROJECTS</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-[330px] rounded-md border border-maestro-border bg-maestro-surface shadow-lg"
          role="dialog"
          aria-label="Projects list"
        >
          <div className="flex items-center gap-1.5 border-b border-maestro-border px-2 py-1.5">
            <button
              type="button"
              aria-label="Back"
              title="Back"
              onClick={() =>
                setPath(path?.label && project ? { projectId: project.id, label: null } : null)
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
              {level === 1 ? (
                "Projects"
              ) : (
                <>
                  {crumbLink("Projects", () => setPath(null))}
                  {" › "}
                  {level === 3 && project
                    ? crumbLink(project.name, () => setPath({ projectId: project.id, label: null }))
                    : project?.name}
                  {level === 3 && label && ` › ${label.name}`}
                </>
              )}
            </nav>
            <button
              type="button"
              onClick={onToggleLock}
              aria-pressed={countBlocked}
              aria-describedby="projects-pill-lock-tip"
              className={`group relative flex items-center gap-1 rounded border px-1.5 py-px text-[11px] ${
                countBlocked
                  ? "border-maestro-accent/50 text-maestro-accent"
                  : "border-maestro-border text-maestro-muted"
              }`}
            >
              {countBlocked ? <Lock size={11} /> : <Unlock size={11} />}
              <span>{countBlocked ? "Blocked counted" : "Ready only"}</span>
              <span
                id="projects-pill-lock-tip"
                role="tooltip"
                className="pointer-events-none absolute right-0 top-6 z-50 hidden w-[230px] rounded border border-maestro-border bg-maestro-card px-2 py-1.5 text-left text-[11px] font-normal text-maestro-text shadow-lg group-hover:block"
              >
                {countBlocked ? LOCK_TIP_COUNTED : LOCK_TIP_READY}
              </span>
            </button>
          </div>
          <div className="max-h-[320px] overflow-y-auto py-1">{renderBody()}</div>
          <div className="border-t border-maestro-border px-2.5 py-1 text-[10px] text-maestro-muted">
            {anyLoading ? "Loading…" : LOADED_NOTE}
          </div>
        </div>
      )}
    </div>
  );
}
