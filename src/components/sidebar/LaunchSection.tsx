import { ask } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FolderGit2,
  Loader2,
  RefreshCw,
  Rocket,
  TerminalSquare,
  Trash2,
  Workflow,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatResumeAt, useCountdownNow } from "@/lib/parkTime";
import { samePath } from "@/lib/path";
import {
  type SamuraiPreflight,
  type SamuraiRunListEntry,
  type SamuraiRunOrchestrator,
  type SamuraiTestGateProgress,
  samuraiCleanupEpic,
  samuraiLaunchRun,
  samuraiListRuns,
  samuraiPreflight,
  samuraiRecoverRun,
  samuraiScheduleLaunch,
  samuraiTimerCancel,
} from "@/lib/samurai";
import type { UsageData } from "@/lib/usageParser";
import {
  initSamuraiGateListener,
  latestGateForProject,
  useSamuraiGateStore,
} from "@/stores/useSamuraiGateStore";
import { workflowGraphForLaunch } from "@/stores/useSamuraiWorkflowStore";
import {
  SAMURAI_TERMINAL_STATES,
  type SamuraiScheduleEntry,
  type SamuraiSessionInfo,
  type SamuraiSupervisorState,
  useSessionStore,
} from "@/stores/useSessionStore";
import { useUsageStore } from "@/stores/useUsageStore";
import { useWorkflowsViewStore } from "@/stores/useWorkflowsViewStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** Last path segment, for compact project display. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Every `#N` ref in the request text (issue #128), for the detected-refs
 *  summary. Purely informational — the backend re-extracts on its own. */
function detectedRefs(text: string): string[] {
  return text.match(/#\d+/g) ?? [];
}

/**
 * Models the run can be pinned to, plus the allowance window each one draws
 * from. `family` keys the usage lookup, not the CLI: the usage API reports
 * per-model weeklies under human labels ("Week (Opus)"), while `value` is
 * what reaches `claude --model`. Empty `value` = no `--model` flag at all.
 */
const MODEL_OPTIONS: { value: string; label: string; family: string | null }[] = [
  { value: "", label: "Default", family: null },
  { value: "claude-opus-5", label: "Opus 5", family: "opus" },
  { value: "claude-sonnet-5", label: "Sonnet 5", family: "sonnet" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", family: "haiku" },
  { value: "claude-fable-5", label: "Fable 5", family: "fable" },
];

/**
 * Percent of this model's weekly allowance still available, or null when the
 * API reports no window for it (enterprise seats report a spend budget
 * instead, and not every model gets its own window). Null is "unknown", NOT
 * zero — the caller must render the difference, or a model with plenty left
 * reads as exhausted.
 */
function allowanceLeft(usage: UsageData | null, family: string | null): number | null {
  if (!usage || !family) return null;
  const dedicated =
    family === "opus"
      ? usage.weeklyOpusPercent
      : family === "sonnet"
        ? usage.weeklySonnetPercent
        : null;
  // Models without a dedicated top-level window (Fable, Haiku) only ever
  // appear in the `limits`-derived list.
  const used =
    dedicated ??
    usage.modelWindows.find((w) => w.label.toLowerCase().includes(family))?.percent ??
    null;
  if (used === null || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - used)));
}

/** Allowance-left colouring: green plenty, amber tight, red nearly gone. */
function allowanceClass(left: number | null): string {
  if (left === null) return "text-maestro-muted/60";
  if (left <= 10) return "text-maestro-red";
  if (left <= 25) return "text-maestro-orange";
  return "text-maestro-green";
}

/** Compact token-count display: `1_000_000` -> `1M`, `200_000` -> `200K`. */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** Context-fill meter colouring: green plenty of room, amber filling up, red
 *  near the handoff trigger — the inverse of `allowanceClass` (here HIGH is
 *  the concerning direction). */
function contextMeterClass(percent: number): string {
  if (percent >= 80) return "bg-maestro-red";
  if (percent >= 50) return "bg-maestro-orange";
  return "bg-maestro-green";
}

/**
 * One run row's orchestrator details (issue #102): model, generation,
 * session id, and — while the run is still live — a small context-fill
 * meter. A COMPLETED run's context reading is no longer live (its terminal
 * has torn down), so the meter is omitted rather than showing a frozen or
 * absent number under a "live" bar. Missing individual fields (no session
 * registered yet) render as a dash, never a guess.
 */
function OrchestratorDetails({
  orchestrator,
  showLiveContext,
}: {
  orchestrator: SamuraiRunOrchestrator;
  showLiveContext: boolean;
}) {
  const { generation, session_id, model, context_window, context_percent } = orchestrator;
  return (
    <div className="flex items-center gap-1.5 pl-1 text-[10px] text-maestro-muted">
      <span className="min-w-0 flex-1 truncate" title={model ?? undefined}>
        {model ?? "—"}
      </span>
      <span className="shrink-0">Gen {generation ?? "—"}</span>
      <span className="shrink-0" title={session_id != null ? `Session ${session_id}` : undefined}>
        Session {session_id ?? "—"}
      </span>
      {showLiveContext && (
        <span className="flex shrink-0 items-center gap-1 tabular-nums">
          <span className="h-1 w-8 overflow-hidden rounded-full bg-maestro-border/60">
            {context_percent != null && (
              <span
                className={`block h-full ${contextMeterClass(context_percent)}`}
                style={{ width: `${Math.min(100, Math.max(0, context_percent))}%` }}
              />
            )}
          </span>
          <span>
            {context_percent != null ? `${context_percent}%` : "—"}
            {context_window != null ? ` / ${formatContextWindow(context_window)}` : ""}
          </span>
        </span>
      )}
    </div>
  );
}

/** One pass/fail preflight row. */
function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px]">
      {ok ? (
        <CheckCircle2 size={12} className="mt-px shrink-0 text-maestro-green" />
      ) : (
        <XCircle size={12} className="mt-px shrink-0 text-maestro-red" />
      )}
      <span className={ok ? "text-maestro-text" : "text-maestro-red"}>
        {label}
        {detail ? <span className="text-maestro-muted"> — {detail}</span> : null}
      </span>
    </div>
  );
}

/**
 * Model picker. A listbox rather than a native `<select>` so each row can put
 * the model on the left and its remaining allowance on the right — the whole
 * point is choosing a model by what is left to spend on it.
 */
function ModelPicker({
  value,
  onChange,
  usage,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  usage: UsageData | null;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = MODEL_OPTIONS.find((m) => m.value === value) ?? MODEL_OPTIONS[0];
  const selectedLeft = allowanceLeft(usage, selected.family);

  // Close on outside click / Escape. Bound only while open so an unopened
  // picker costs no global listeners (this panel can sit mounted for hours).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id="samurai-launch-model"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-left text-[11px] text-maestro-text transition-colors hover:border-maestro-accent/60 disabled:opacity-40"
      >
        <span className="min-w-0 flex-1 truncate">{selected.label}</span>
        {selectedLeft !== null && (
          <span className={`shrink-0 tabular-nums ${allowanceClass(selectedLeft)}`}>
            {selectedLeft}% left
          </span>
        )}
        <ChevronDown size={11} className="shrink-0 text-maestro-muted" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Model"
          className="absolute z-20 mt-0.5 w-full overflow-hidden rounded border border-maestro-border bg-maestro-bg shadow-lg"
        >
          {MODEL_OPTIONS.map((option) => {
            const left = allowanceLeft(usage, option.family);
            return (
              <button
                key={option.value || "default"}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition-colors hover:bg-maestro-surface ${
                  option.value === value ? "text-maestro-accent" : "text-maestro-text"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className={`shrink-0 tabular-nums text-[10px] ${allowanceClass(left)}`}>
                  {left === null ? "—" : `${left}% left`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Stable per-row identity — project + epic, matching the list `key` (an
 *  epic name alone is not unique across projects). */
function runKey(run: SamuraiRunListEntry): string {
  return `${run.project_path}-${run.epic}`;
}

/**
 * Comparable form of a run identity: lower-cased, every run of non-alphanumeric
 * characters collapsed to a single dash. A run config stores a readable label
 * (`epic #5 · issues #7, #9`) while its resume timer was armed under whatever
 * string the supervisor held, so the two only line up once punctuation, casing
 * and padding are out of the way — the same normalisation the branch slug uses.
 */
function epicSlug(epic: string): string {
  return epic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The one non-park timer reason (issue #129) — see `SamuraiScheduleEntry.reason`. */
const SCHEDULED_LAUNCH_REASON = "scheduled_launch";

/**
 * The pending resume timer for one run, or null when it is not parked.
 * Project paths go through `samePath`, never `===`: the same directory has
 * several spellings on Windows, and matching on the epic alone would badge a
 * run in one project with another project's timer. Scheduled-launch timers
 * (issue #129) share the schedule list but are NOT parks — one whose slug
 * matches a live run must never badge it PARKED.
 */
function findScheduleEntry(
  run: SamuraiRunListEntry,
  schedule: SamuraiScheduleEntry[],
): SamuraiScheduleEntry | null {
  const slug = epicSlug(run.epic);
  return (
    schedule.find(
      (e) =>
        e.reason !== SCHEDULED_LAUNCH_REASON &&
        samePath(e.project_path, run.project_path) &&
        epicSlug(e.epic) === slug,
    ) ?? null
  );
}

/** Where a run's live agent sits, or why it cannot be opened (issue #84).
 *  `state` is the newest matching session's supervisor state: since issue
 *  #122 a terminal-state (KILLED/PARKED/DEAD) session keeps an openable
 *  parked tile, so "open" alone no longer implies a LIVE agent. */
type OpenTarget =
  | { kind: "open"; tabId: string; sessionId: number; state: SamuraiSupervisorState }
  | { kind: "blocked"; reason: string };

/** Hover text of an openable run's button. */
const OPEN_HINT = "Switch to this run's project and focus its live agent's terminal";

/** Nothing is registered under this run at all. */
const NO_SESSION_REASON = "No live agent for this run — it is not running in this Maestro session";

/**
 * Finds the terminal to open for one run.
 *
 * The run's `epic` is its identity AND the string the supervisor registers its
 * session under (issue #83), so the two compare directly — trimmed, because a
 * legacy config and a live registration can differ by padding. Project paths
 * go through `samePath`, never `===`: the same directory has several spellings
 * on Windows, and matching on the ref alone would cross-focus two projects
 * running the same epic number.
 *
 * Every terminal state (KILLED/PARKED/DEAD) now parks its terminal into the
 * footer tray instead of closing it (issue #122), so there is no "closed
 * tile" case to block on any more — the newest generation's terminal always
 * exists somewhere, and opening it (`onNavigate` → `zoomSession`) unparks it
 * if needed, same as clicking its tray chip.
 */
function findOpenTarget(
  run: SamuraiRunListEntry,
  samuraiBySessionId: Record<number, SamuraiSessionInfo>,
  tabs: WorkspaceTab[],
): OpenTarget {
  const matches = Object.entries(samuraiBySessionId)
    .map(([id, info]) => ({ sessionId: Number(id), info }))
    .filter(
      ({ info }) =>
        info.epic.trim() === run.epic.trim() && samePath(info.project, run.project_path),
    )
    // Newest generation first: with several around, that is the one working.
    .sort((a, b) => b.info.generation - a.info.generation);
  if (matches.length === 0) return { kind: "blocked", reason: NO_SESSION_REASON };

  const tab = tabs.find((t) => samePath(t.projectPath, run.project_path));
  if (!tab) {
    return {
      kind: "blocked",
      reason: "No live agent for this run — its project is not open in a tab",
    };
  }
  return {
    kind: "open",
    tabId: tab.id,
    sessionId: matches[0].sessionId,
    state: matches[0].info.state,
  };
}

/** One listed run (live or finished-awaiting-cleanup) with its
 *  open-the-agent and cleanup actions. */
function RunRow({
  run,
  target,
  parked,
  now,
  onOpen,
  onCleanup,
  onRecover,
  pending,
  otherBusy,
  error,
}: {
  run: SamuraiRunListEntry;
  target: OpenTarget;
  /** This run's pending resume timer, or null when it is not parked. */
  parked: SamuraiScheduleEntry | null;
  /** Ticking clock behind the park countdown (see `useCountdownNow`). */
  now: number;
  onOpen: (tabId: string, sessionId: number) => void;
  onCleanup: (run: SamuraiRunListEntry) => void;
  /** Issue #124: explicit crash-recovery relaunch of a non-completed run. */
  onRecover: (run: SamuraiRunListEntry) => void;
  /** Issue #99: this exact row's cleanup is in flight — spinner + dimmed row
   *  until the backend answers, so the click reads as "working" immediately
   *  instead of doing nothing for several seconds. */
  pending: boolean;
  /** A different row's cleanup is in flight — this row waits too, so two
   *  cleanups never race. */
  otherBusy: boolean;
  /** The last cleanup attempt for this row failed — shown in place rather
   *  than silently reverting to the pre-click row (issue #99). */
  error: string | null;
}) {
  const isCompleted = run.status === "COMPLETED";
  const open = target.kind === "open" ? target : null;
  const openHint = target.kind === "open" ? OPEN_HINT : target.reason;
  // Issue #124 × #122: an openable target no longer implies a live agent —
  // a KILLED/PARKED/DEAD session keeps its parked tile openable, and that
  // dead-agent-with-a-tile shape is exactly what Recover exists for.
  const hasLiveAgent = target.kind === "open" && !SAMURAI_TERMINAL_STATES.has(target.state);
  // A parked run has no live agent BY DESIGN (its tile closed; the resume is a
  // fresh spawn), so the row said "ACTIVE / no live agent" and never mentioned
  // the park. The badge below is that missing state — dated, because a park
  // governed by the 7-day window can be days out.
  const resume = parked ? formatResumeAt(parked.fire_at, now) : null;
  return (
    <div
      className={`rounded px-1 py-0.5 hover:bg-maestro-surface ${pending ? "opacity-60" : ""}`}
      title={`worktree: ${run.worktree_path}\nrepo pin: ${run.repo_pin ?? "none"}\ncreated: ${run.created_at}`}
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        {/* Issue #96: a COMPLETED run is verified finished (all issues closed,
            PR open) and only awaits the manual cleanup — visually distinct
            from a live ACTIVE run. */}
        {isCompleted ? (
          <span
            className="shrink-0 rounded bg-maestro-accent/20 px-1 py-px text-[9px] font-bold tracking-wide text-maestro-accent"
            title="Run verified complete — every issue closed, PR open. Awaiting cleanup."
          >
            FINISHED
          </span>
        ) : (
          <span className="shrink-0 rounded bg-maestro-green/20 px-1 py-px text-[9px] font-bold tracking-wide text-maestro-green">
            ACTIVE
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-maestro-text">
          {/* Already the readable label since issue #83 (`epic #5 · issues #7,
              #9`), and a single raw ref (`#38`) for configs written before it —
              rendering the stored string is what keeps both shapes right. */}
          {run.epic}
          <span className="text-maestro-muted"> · {baseName(run.project_path)}</span>
        </span>
        {/* The reason rides the wrapper, not the button: a disabled button takes
            no pointer events, so its own `title` would never surface — and the
            row's worktree tooltip would answer the hover instead. */}
        <span className="flex shrink-0" title={openHint}>
          <button
            type="button"
            onClick={() => open && onOpen(open.tabId, open.sessionId)}
            disabled={open === null}
            className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-accent disabled:opacity-40"
            aria-label={`Open the agent for run ${run.epic}`}
          >
            <TerminalSquare size={12} />
          </button>
        </span>
        {/* Issue #124: recover a crashed run — only offered while the run is
            not finished and has no live agent to duplicate. The backend
            re-verifies both before spawning anything. */}
        {!isCompleted && !hasLiveAgent && (
          <button
            type="button"
            onClick={() => onRecover(run)}
            disabled={pending || otherBusy}
            className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-accent disabled:opacity-40"
            aria-label={`Recover run ${run.epic}`}
            title="The agent died? Verify the worktree's real state (git) and restart the run from its true resume point — the last handoff, or a full reconstruction from git and GitHub."
          >
            <RefreshCw size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => onCleanup(run)}
          disabled={pending || otherBusy}
          className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-red disabled:opacity-40"
          aria-label={`Clean up run ${run.epic}`}
          title="Delete this run's worktree and branch, cancel its timer, archive its run config (asks first)"
        >
          {pending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        </button>
      </div>
      {/* The park badge gets its own line: with the date and the countdown in
          it, it would squeeze the epic label out of the row above. A fire time
          that does not parse still badges the run PARKED, just without a
          resume reading — a broken stamp must never hide the parked state. */}
      {parked && (
        <div className="flex pl-1 pt-0.5">
          <span
            className="min-w-0 rounded bg-maestro-purple/20 px-1 py-px text-[9px] font-bold leading-tight tracking-wide text-maestro-purple"
            title={`Parked — this run has no live agent on purpose. It resumes automatically${
              resume ? ` at ${resume}` : ` (fire time unreadable: ${parked.fire_at})`
            }, as a fresh agent.`}
          >
            {resume ? `PARKED · resumes ${resume}` : "PARKED"}
          </span>
        </div>
      )}
      {/* Issue #102: the orchestrator's live details — a COMPLETED run's
          context reading is no longer live, so the meter is omitted. */}
      <OrchestratorDetails orchestrator={run.orchestrator} showLiveContext={!isCompleted} />
      {error && (
        <p className="mt-0.5 flex items-center gap-1 pl-1 text-[10px] text-maestro-red">
          <XCircle size={10} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={error}>
            {error}
          </span>
        </p>
      )}
    </div>
  );
}

/** Field label, shared by every row in the launch form. */
function FieldLabel({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      title={hint}
      className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-maestro-muted"
    >
      {children}
    </label>
  );
}

/** What the Launch/Schedule button is doing right now (null = idle). */
type LaunchPhase = "preflight" | "spawning" | "scheduling";

const PHASE_LABEL: Record<LaunchPhase, string> = {
  preflight: "Checking gh auth + allowance…",
  spawning: "Creating worktree, spawning gen-1…",
  scheduling: "Scheduling launch…",
};

/** Gate steps that are still running (issue #90b) — the ones worth a live
 *  progress row; `passed`/`failed` resolve through the launch promise. */
const GATE_RUNNING_STEPS: SamuraiTestGateProgress["step"][] = [
  "bootstrap_npm",
  "bootstrap_mcp",
  "cargo_test",
];

/**
 * Samurai run launcher (issue #63, PRD §5.8 + §9): the form that starts an
 * autonomous run — project (the active tab, read-only), the epics and the
 * issues to work (issue #83: two fields, so the orchestrator prompt never
 * calls a list of issues an epic), an optional model pinned by remaining
 * allowance, an optional handoff
 * override — behind ONE Launch button that runs preflight itself and reports
 * the phase it is in. Below it, the active runs (`samurai_list_runs`) with
 * per-run destructive cleanup behind the same ask()-confirm pattern as the
 * audit clear, and (issue #84) a per-run jump to the agent working it.
 *
 * `onNavigate` is the same sidebar→terminal route the Agents section takes
 * (App's `handleAgentNavigate`): select the project tab, then zoom its pane —
 * which unparks the session on the way in.
 */
export function LaunchSection({
  onNavigate,
}: {
  onNavigate?: (tabId: string, sessionId: number) => void;
}) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";
  const samuraiBySessionId = useSessionStore((s) => s.samuraiBySessionId);
  // Every pending resume timer, all projects (issue #61) — the backend sends
  // the full list on every arm/cancel/fire, so a park or a resume repaints the
  // run rows live. Ticks only while something is actually parked.
  const samuraiSchedule = useSessionStore((s) => s.samuraiSchedule);
  const now = useCountdownNow(samuraiSchedule.length > 0);

  const usage = useUsageStore((s) => s.usage);
  const startPolling = useUsageStore((s) => s.startPolling);
  useEffect(() => startPolling(), [startPolling]);

  // Issue #128: the run's work as one free-text request — pasted issue/epic
  // refs (#N), plain prose, or both. Sent to the backend verbatim.
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  // Review F4: optional per-run handoff trigger override. Empty = the
  // global config applies (backend stores thresholds: None).
  const [handoffPct, setHandoffPct] = useState("");
  // Issue #90b: the explicit red-baseline override. Default OFF — the gate
  // runs and a red `cargo test --workspace` blocks the launch.
  const [skipGate, setSkipGate] = useState(false);
  // Issue #129: optional day+time to launch later instead of now. Empty =
  // launch immediately; set = the button arms a one-shot scheduled launch.
  const [scheduleAt, setScheduleAt] = useState("");
  // Issue #109: gate progress + verdict live in a store fed by a module-
  // level subscription, so a sidebar-panel switch mid-gate loses nothing —
  // this remount re-reads the current step (or the failure) below.
  const gates = useSamuraiGateStore((s) => s.gates);
  const clearGates = useSamuraiGateStore((s) => s.clearProject);
  // Issue #91 (full-screen follow-up): the run workflow now opens as a
  // full-screen overlay (`WorkflowsView`, rendered by App) instead of
  // embedding a cramped editor here.
  const openWorkflowsView = useWorkflowsViewStore((s) => s.open);
  // 1 Hz re-render while the gate line is showing (drives the elapsed time).
  const [, setGateTick] = useState(0);
  const [preflight, setPreflight] = useState<SamuraiPreflight | null>(null);
  // The project a running launch belongs to — a result that outlives a tab
  // switch is dropped rather than applied to the newly active project.
  const currentProjectRef = useRef(projectPath);
  const [phase, setPhase] = useState<LaunchPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // null = loading.
  const [runs, setRuns] = useState<SamuraiRunListEntry[] | null>(null);
  // Issue #99: which row's cleanup is in flight (keyed like the list — an
  // epic name alone is not unique across projects), plus the last failed
  // row's error so the row can render it in place.
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await samuraiListRuns());
    } catch (err) {
      setRuns([]);
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  // Preflight results are project-scoped — a stale pass must not leak onto
  // another project's form. Gate state is NOT reset here: it lives in the
  // per-project store, so each project's line follows its own tab.
  useEffect(() => {
    currentProjectRef.current = projectPath;
    setPreflight(null);
    setError(null);
    setNotice(null);
  }, [projectPath]);

  // Issue #90b / #109: live test-gate progress rides a module-level
  // subscription into the store (never detached on unmount, so ticks and
  // the verdict land while this panel is closed). Idempotent per mount.
  useEffect(() => {
    void initSamuraiGateListener();
  }, []);

  // The active project's newest gate entry — progress or verdict.
  const gate = latestGateForProject(gates, projectPath);

  // Tick the elapsed display once a second while a gate step is running.
  const gateRunning = gate !== null && GATE_RUNNING_STEPS.includes(gate.progress.step);
  useEffect(() => {
    if (!gateRunning) return;
    const id = setInterval(() => setGateTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [gateRunning]);

  /** `detail · 12s` — the tick's elapsed reading plus the time since it. */
  const gateLine = gate
    ? `${gate.progress.detail} · ${
        gate.progress.elapsed_secs + Math.floor((Date.now() - gate.at) / 1000)
      }s`
    : "";

  /** The `#N` refs found in the request — informational (issue #128). */
  const refs = useMemo(() => detectedRefs(text), [text]);

  // Enabled as soon as anything is typed — free text needs no ref parsing
  // (issue #128), only a non-blank request.
  const canLaunch = Boolean(projectPath) && text.trim().length > 0 && phase === null;

  // Issue #129: this project's scheduled launches — pending ones count down
  // to their fire, HELD ones (overdue at app start, or retries exhausted)
  // wait for an explicit launch-or-discard.
  const scheduledLaunches = samuraiSchedule.filter(
    (e) => e.reason === SCHEDULED_LAUNCH_REASON && samePath(e.project_path, projectPath),
  );

  /**
   * The validated handoff override: `null` = use the global default,
   * `undefined` = invalid (the form error is already set). Review F4: an
   * unparseable override is a form error, not a null.
   */
  const parseHandoffPct = (): number | null | undefined => {
    const pctText = handoffPct.trim();
    const pct = pctText === "" ? null : Number(pctText);
    if (pct !== null && !Number.isFinite(pct)) {
      setError("Handoff context % must be a number (or empty for the global default)");
      return undefined;
    }
    // Mirror the backend's SamuraiConfig::validate range: 0 would make every
    // `percent >= threshold` test true and arm a permanent handoff loop, so
    // it is rejected here rather than surfacing as a launch failure.
    if (pct !== null && (pct <= 0 || pct > 100)) {
      setError("Handoff context % must be between 1 and 100 (or empty for the global default)");
      return undefined;
    }
    return pct;
  };

  /** Issue #129: arm the one-shot scheduled launch instead of launching. */
  const handleSchedule = async () => {
    const pct = parseHandoffPct();
    if (pct === undefined) return;
    const fireAt = new Date(scheduleAt);
    if (Number.isNaN(fireAt.getTime()) || fireAt.getTime() <= Date.now()) {
      setError("Pick a future day and time for the scheduled launch");
      return;
    }
    setError(null);
    setNotice(null);
    // Busy-guard, same as the launch path: the button disables (canLaunch
    // requires phase === null) while the arm is in flight, so a double-click
    // cannot arm the same launch twice.
    setPhase("scheduling");
    try {
      const entry = await samuraiScheduleLaunch(
        projectPath,
        text,
        fireAt.toISOString(),
        model.trim() || null,
        pct,
        skipGate,
      );
      setNotice(`Launch scheduled: ${entry.epic} at ${new Date(entry.fire_at).toLocaleString()}`);
      setText("");
      setScheduleAt("");
    } catch (err) {
      setError(String(err));
    } finally {
      setPhase(null);
    }
  };

  const handleLaunch = async () => {
    const pct = parseHandoffPct();
    if (pct === undefined) return;

    const target = projectPath;
    setError(null);
    setNotice(null);
    setPreflight(null);
    // A fresh launch must not resurface the previous run's gate line or
    // failure verdict (issue #109 — the store outlives launches).
    clearGates(target);

    // Phase 1 — preflight. The backend re-runs it inside the launch anyway;
    // running it here first is what lets a failure render as pass/fail rows
    // instead of one opaque refusal string.
    setPhase("preflight");
    let checks: SamuraiPreflight;
    try {
      checks = await samuraiPreflight(target);
    } catch (err) {
      if (currentProjectRef.current === target) {
        setError(String(err));
        setPhase(null);
      }
      return;
    }
    // Switched project mid-flight — the answer belongs to the old project.
    if (currentProjectRef.current !== target) {
      setPhase(null);
      return;
    }
    setPreflight(checks);
    if (!checks.gh_auth.ok || !checks.windows_reported) {
      setError("Preflight failed — fix the red checks below, then launch again.");
      setPhase(null);
      return;
    }

    // Phase 2 — the launch proper (worktree → test gate → gen-1 spawn).
    setPhase("spawning");
    try {
      // Issue #91: the edited workflow graph (null = never edited — the
      // backend then compiles its default template), read behind the store's
      // hydration gate so a launch right after app start can't send null
      // while an edit still sits on disk.
      const workflow = await workflowGraphForLaunch();
      const result = await samuraiLaunchRun(
        target,
        text,
        model.trim() || null,
        pct,
        skipGate,
        workflow,
      );
      if (currentProjectRef.current !== target) return;
      setNotice(
        `Run launched: ${result.epic} on ${result.branch} (worktree ${result.worktree_path})${result.stale_timer_cancelled ? " — stale resume timer cancelled" : ""}`,
      );
      setText("");
      setHandoffPct("");
      setPreflight(null);
      // The gate passed and the run is live — its progress line is done.
      // (A REJECTED launch keeps the store entry: the backend's `failed`
      // tick is what a remounted panel re-surfaces — issue #109.)
      clearGates(target);
      await refreshRuns();
    } catch (err) {
      if (currentProjectRef.current === target) setError(String(err));
    } finally {
      setPhase(null);
    }
  };

  /**
   * Issue #129: launch a scheduled entry NOW — the explicit half of the
   * launch-or-discard a held (overdue / given-up) entry waits for. The
   * normal launch path's stale-timer cancel consumes the entry on success.
   */
  const handleLaunchNow = async (entry: SamuraiScheduleEntry) => {
    const spec = entry.launch;
    if (!spec) return;
    setError(null);
    setNotice(null);
    setPhase("spawning");
    try {
      const workflow = await workflowGraphForLaunch();
      const result = await samuraiLaunchRun(
        entry.project_path,
        spec.text,
        spec.model,
        spec.handoff_context_pct,
        spec.skip_test_gate,
        workflow,
      );
      setNotice(`Run launched: ${result.epic} on ${result.branch}`);
      await refreshRuns();
    } catch (err) {
      setError(String(err));
    } finally {
      setPhase(null);
    }
  };

  /** Issue #129: discard a scheduled launch — cancel its timer, launch nothing. */
  const handleDiscard = async (entry: SamuraiScheduleEntry) => {
    setError(null);
    setNotice(null);
    try {
      await samuraiTimerCancel(entry.project_path, entry.epic);
      setNotice(`Scheduled launch discarded: ${entry.epic}`);
    } catch (err) {
      setError(String(err));
    }
  };

  /**
   * Issue #124: explicit crash-recovery relaunch. The backend verifies the
   * real state (ACTIVE run, no live agent, worktree branch + HEAD via git)
   * and spawns the next generation from the true resume point; a refusal
   * surfaces on the row.
   */
  const handleRecover = async (run: SamuraiRunListEntry) => {
    const key = runKey(run);
    setRowError(null);
    setError(null);
    setNotice(null);
    try {
      const result = await samuraiRecoverRun(run.project_path, run.epic);
      setNotice(
        `Recovery started: gen-${result.generation} for ${result.epic} on ${result.branch} @ ${result.head} (${
          result.from_handoff
            ? `resuming from gen-${result.prior_generation}'s handoff`
            : "reconstructing from git and GitHub"
        })`,
      );
      await refreshRuns();
    } catch (err) {
      setRowError({ key, message: String(err) });
    }
  };

  const handleCleanup = async (run: SamuraiRunListEntry) => {
    // Destructive, never silent (PRD §5.9) — same ask() confirm pattern as
    // the audit clear.
    const confirmed = await ask(
      `Clean up run ${run.epic}? This deletes its worktree and samurai branch, cancels its resume timer, and archives its run config. It cannot be undone.`,
      { title: "Clean Up Run", kind: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
    const key = runKey(run);
    // Issue #99: pending lands in the same tick as the confirm, before the
    // backend call even starts — the row shows a spinner immediately rather
    // than sitting inert for the several seconds the delete actually takes.
    setDeletingKey(key);
    setRowError(null);
    setError(null);
    setNotice(null);
    try {
      const report = await samuraiCleanupEpic(run.project_path, run.epic);
      const removed = [
        report.worktree_removed ? "worktree" : null,
        report.branch_deleted ? `branch ${report.branch}` : null,
        report.config_archived ? "run config" : null,
        report.timer_cancelled ? "resume timer" : null,
        report.spawn_cancelled ? "staged gen-1 spawn" : null,
      ].filter(Boolean);
      setNotice(
        removed.length > 0
          ? `Cleaned up run ${report.epic}: removed ${removed.join(", ")}.`
          : `Run ${report.epic} was already clean.`,
      );
      await refreshRuns();
    } catch (err) {
      // Surfaced on the row itself rather than the form's error line —
      // reverting to the pre-click row with no explanation would look like
      // nothing happened (issue #99).
      setRowError({ key, message: String(err) });
    } finally {
      setDeletingKey(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className={cardClass}>
        <SectionHeader icon={Rocket} label="Launch Run" iconColor="text-maestro-accent" />
        <p className="mb-2 text-[11px] text-maestro-muted">
          Start an autonomous Samurai run in its own worktree.
        </p>

        <div className="space-y-2">
          <div>
            <FieldLabel>Project</FieldLabel>
            {/* Read-only on purpose: the run follows the active project tab.
                Rendered as plain text, not a bordered box — an input frame
                around something you cannot type in reads as a broken field. */}
            <div
              className="flex items-center gap-1.5 px-0.5 text-[11px] text-maestro-text"
              title={projectPath || undefined}
            >
              <FolderGit2 size={11} className="shrink-0 text-maestro-muted" />
              <span className="truncate">
                {projectPath ? baseName(projectPath) : "No active project"}
              </span>
            </div>
          </div>

          <div>
            <FieldLabel
              htmlFor="samurai-launch-text"
              hint="Paste GitHub issue or epic refs (#5, #12), describe the work in plain words, or both. Refs get their context read from GitHub (an epic brings its child issues along); plain prose runs on your words alone. Everything typed here is worked by ONE run, in one worktree."
            >
              What do you want to work on today
            </FieldLabel>
            <textarea
              id="samurai-launch-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder="Work #77 and #78 — or describe the work in plain words"
              className="w-full resize-y rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
            />
            <p className="mt-0.5 text-[10px] leading-snug text-maestro-muted">
              {refs.length > 0
                ? `${refs.length} issue ref${refs.length === 1 ? "" : "s"} detected (${refs.join(", ")}) — their GitHub context is read first.`
                : "Issue refs (#N) are read from GitHub; plain prose runs on your words alone."}
            </p>
          </div>

          <div>
            <FieldLabel
              htmlFor="samurai-launch-model"
              hint="Which Claude model the run's agents use. The percentage is how much of that model's weekly allowance is still available."
            >
              Model
            </FieldLabel>
            <ModelPicker
              value={model}
              onChange={setModel}
              usage={usage}
              disabled={phase !== null}
            />
          </div>

          <div>
            <FieldLabel
              htmlFor="samurai-launch-handoff-pct"
              hint="A long-running agent's answers decay as its context fills up. At this percentage the orchestrator writes its state to a handoff file and Maestro starts a fresh agent from it, so the work continues with a clean context. Lower = hands off sooner and more often; higher = fewer handoffs but more decay."
            >
              Handoff at context %
            </FieldLabel>
            <input
              id="samurai-launch-handoff-pct"
              type="number"
              min={1}
              max={100}
              value={handoffPct}
              onChange={(e) => setHandoffPct(e.target.value)}
              placeholder="40 (default)"
              className="w-full rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/60 focus:border-maestro-accent focus:outline-none"
            />
            <p className="mt-0.5 text-[10px] leading-snug text-maestro-muted">
              Hand this run to a fresh agent once the orchestrator's context is this full. Empty
              uses the default, 40%.
            </p>
          </div>

          <div>
            <label
              className="flex items-center gap-1.5 text-[11px] text-maestro-text"
              title="The launch bootstraps the epic worktree (npm install, mcp-server build) and runs `cargo test --workspace` in it first; a red suite blocks the launch. Tick this to skip that gate and launch anyway."
            >
              <input
                type="checkbox"
                checked={skipGate}
                onChange={(e) => setSkipGate(e.target.checked)}
                disabled={phase !== null}
                className="h-3 w-3 accent-maestro-accent"
              />
              Skip test-suite gate
            </label>
            <p className="mt-0.5 text-[10px] leading-snug text-maestro-muted">
              Off (default): the launch runs the worktree's test suite first and blocks on red.
            </p>
          </div>

          <div>
            <FieldLabel
              htmlFor="samurai-launch-schedule-at"
              hint="Pick a day and time to launch this run later instead of now (one-shot). Maestro must be running at that time; a launch whose time passes while Maestro is closed is held on reopen and asks you to launch or discard it."
            >
              Schedule for later
            </FieldLabel>
            <input
              id="samurai-launch-schedule-at"
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="w-full rounded border border-maestro-border/60 bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text focus:border-maestro-accent focus:outline-none"
            />
            <p className="mt-0.5 text-[10px] leading-snug text-maestro-muted">
              Empty launches now. Set, the button below schedules the run for that day and time.
            </p>
          </div>

          <div className="flex items-start gap-1.5 rounded border border-maestro-orange/40 bg-maestro-orange/10 p-1.5 text-[10px] leading-snug text-maestro-text">
            <AlertTriangle size={12} className="mt-px shrink-0 text-maestro-orange" />
            <span>
              Make sure the issues are agent-ready — clear scope and acceptance criteria, no open
              decisions — or the run cannot develop them autonomously. Generation 1 checks each
              issue first and reports any it cannot work.
            </span>
          </div>

          <button
            type="button"
            onClick={scheduleAt ? handleSchedule : handleLaunch}
            disabled={!canLaunch}
            className="w-full rounded bg-maestro-accent/20 px-2 py-1 text-[11px] font-semibold text-maestro-accent transition-colors hover:bg-maestro-accent/30 disabled:opacity-40"
          >
            {phase ? (
              <span className="flex items-center justify-center gap-1.5">
                <Loader2 size={11} className="animate-spin" />
                {/* Issue #90b: while the test gate runs, its live step (with
                    elapsed time, ticking between backend events) replaces
                    the generic spawning label. */}
                {gateRunning && phase === "spawning" ? gateLine : PHASE_LABEL[phase]}
              </span>
            ) : scheduleAt ? (
              "Schedule"
            ) : (
              "Launch"
            )}
          </button>

          {/* Issue #129: this project's scheduled launches. Pending entries
              fire on their own at their time; HELD entries (overdue at app
              start, or unattended retries exhausted) never fire and wait for
              the explicit launch-or-discard below. */}
          {scheduledLaunches.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-maestro-muted">
                Scheduled launches
              </p>
              {scheduledLaunches.map((entry) => (
                <div
                  key={`${entry.project_path}|${entry.epic}`}
                  className="space-y-1 rounded border border-maestro-border/40 bg-maestro-surface/60 p-1.5"
                >
                  <p className="truncate text-[11px] text-maestro-text" title={entry.launch?.text}>
                    {entry.epic}
                  </p>
                  <p className="text-[10px] leading-snug text-maestro-muted">
                    {entry.held
                      ? "Overdue — did not launch. Launch it now, or discard it."
                      : `Launches at ${new Date(entry.fire_at).toLocaleString()}`}
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleLaunchNow(entry)}
                      disabled={phase !== null}
                      className="rounded bg-maestro-accent/20 px-2 py-0.5 text-[10px] font-semibold text-maestro-accent transition-colors hover:bg-maestro-accent/30 disabled:opacity-40"
                    >
                      Launch now
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDiscard(entry)}
                      className="rounded bg-maestro-surface px-2 py-0.5 text-[10px] font-semibold text-maestro-muted transition-colors hover:text-maestro-red"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Issue #109: a remount mid-gate (sidebar panel switch) re-reads
              the running step from the store — the launching mount's phase
              state died with it, so the line renders on its own here. The
              backend's launch registry guards a double launch either way. */}
          {phase === null && gateRunning && (
            <p className="flex items-center gap-1.5 text-[11px] text-maestro-muted">
              <Loader2 size={11} className="shrink-0 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{gateLine}</span>
            </p>
          )}
          {/* Issue #109: a gate FAILURE that landed while this panel was
              unmounted re-surfaces from the store; while mounted, the launch
              rejection already renders the same verdict through `error`. */}
          {gate?.progress.step === "failed" && !error && (
            <p className="flex items-center gap-1 text-[11px] text-maestro-red">
              <XCircle size={11} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={gate.progress.detail}>
                {gate.progress.detail}
              </span>
            </p>
          )}

          {preflight && (
            <div className="space-y-1 rounded border border-maestro-border/40 bg-maestro-surface/60 p-1.5">
              <CheckRow
                ok={preflight.gh_auth.ok}
                label={
                  preflight.gh_auth.ok
                    ? `gh authenticated as ${preflight.gh_auth.username ?? "unknown user"}`
                    : "gh auth failed"
                }
                detail={preflight.gh_auth.ok ? null : preflight.gh_auth.error}
              />
              <CheckRow
                ok={preflight.windows_reported}
                label={
                  preflight.windows_reported
                    ? "Allowance windows reported"
                    : "No governing allowance window"
                }
                detail={
                  preflight.windows_reported
                    ? null
                    : "the usage API reports neither the 5h nor the 7d window — parking cannot govern this run"
                }
              />
            </div>
          )}

          {error && <p className="text-[11px] text-maestro-red">{error}</p>}
          {notice && <p className="text-[11px] text-maestro-green">{notice}</p>}
        </div>
      </div>

      <div className={cardClass}>
        <SectionHeader
          icon={Rocket}
          label="Active Runs"
          iconColor="text-maestro-green"
          badge={
            runs && runs.length > 0 ? (
              <span className="rounded-full bg-maestro-green/20 px-1.5 text-[10px] font-bold text-maestro-green">
                {runs.length}
              </span>
            ) : undefined
          }
          right={
            <button
              type="button"
              onClick={refreshRuns}
              className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-surface hover:text-maestro-text"
              aria-label="Refresh active runs"
              title="Reload the active runs list"
            >
              <RefreshCw size={12} />
            </button>
          }
        />
        {runs === null ? (
          <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-maestro-muted">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : runs.length === 0 ? (
          <p className="px-1 py-2 text-[11px] italic text-maestro-muted">
            No active runs. Launch one above.
          </p>
        ) : (
          <div className="space-y-0.5">
            {runs.map((run) => {
              const key = runKey(run);
              return (
                <RunRow
                  key={key}
                  run={run}
                  // No route out of the sidebar means the button cannot do what
                  // it offers, so it must not offer it — "no silent no-op"
                  // applies to a missing `onNavigate` exactly as it does to a
                  // missing session.
                  target={
                    onNavigate
                      ? findOpenTarget(run, samuraiBySessionId, tabs)
                      : { kind: "blocked", reason: NO_SESSION_REASON }
                  }
                  parked={findScheduleEntry(run, samuraiSchedule)}
                  now={now}
                  onOpen={(tabId, sessionId) => onNavigate?.(tabId, sessionId)}
                  onCleanup={handleCleanup}
                  onRecover={handleRecover}
                  pending={deletingKey === key}
                  otherBusy={deletingKey !== null && deletingKey !== key}
                  error={rowError?.key === key ? rowError.message : null}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Issue #91: the run workflow the briefs compile from — persisted
          across restarts, sent with the launch above. Edited in a
          full-screen overlay now (WorkflowsView) rather than inline. */}
      <div className={cardClass}>
        <SectionHeader icon={Workflow} label="Workflow" iconColor="text-maestro-accent" />
        <p className="mb-2 text-[11px] leading-snug text-maestro-muted">
          The step-by-step process every run follows, compiled into each orchestrator brief.
        </p>
        <button
          type="button"
          onClick={openWorkflowsView}
          className="w-full rounded bg-maestro-accent/20 px-2 py-1 text-[11px] font-semibold text-maestro-accent transition-colors hover:bg-maestro-accent/30"
        >
          Open workflow editor
        </button>
      </div>
    </div>
  );
}
