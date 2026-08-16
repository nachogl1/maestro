import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted zustand stores hydrate through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

// The section subscribes to the live test-gate channel on mount (issue
// #90b) — the AuditSection test's listen-capture pattern. useSessionStore
// also binds Tauri event listeners at call time; the mock keeps the import
// off the real event bridge either way.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { formatFireDateTime } from "@/lib/parkTime";
import type {
  SamuraiPreflight,
  SamuraiRunListEntry,
  SamuraiRunOrchestrator,
  SamuraiTestGateProgress,
  SamuraiWorkflowGraph,
} from "@/lib/samurai";
import type { UsageData } from "@/lib/usageParser";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { stopSamuraiGateListener, useSamuraiGateStore } from "@/stores/useSamuraiGateStore";
import { useSamuraiWorkflowStore } from "@/stores/useSamuraiWorkflowStore";
import {
  type SamuraiScheduleEntry,
  type SamuraiSessionInfo,
  useSessionStore,
} from "@/stores/useSessionStore";
import { useWorkflowsViewStore } from "@/stores/useWorkflowsViewStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { LaunchSection } from "../LaunchSection";

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);
const listenMock = vi.mocked(listen);

/** Captured `samurai-test-gate-event` handler, so tests can stream ticks. */
let emitGateEvent: (payload: SamuraiTestGateProgress) => void;

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: "C:\\git\\maestro",
    active: true,
    sessionIds: [],
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

function passPreflight(overrides: Partial<SamuraiPreflight> = {}): SamuraiPreflight {
  return {
    gh_auth: { ok: true, username: "nachogl1", error: null },
    windows_reported: true,
    ...overrides,
  };
}

/** Opus 38% used → 62% left; Fable rides the `limits`-derived list. */
function buildUsage(overrides: Partial<UsageData> = {}): UsageData {
  return {
    sessionPercent: 10,
    sessionResetsAt: null,
    weeklyPercent: 20,
    weeklyResetsAt: null,
    weeklyOpusPercent: 38,
    weeklyOpusResetsAt: null,
    weeklySonnetPercent: 5,
    weeklySonnetResetsAt: null,
    weeklyOauthAppsPercent: null,
    weeklyOauthAppsResetsAt: null,
    spendPercent: null,
    spendResetsAt: null,
    spendUsedDollars: null,
    spendLimitDollars: null,
    modelWindows: [{ label: "Fable", percent: 91, resetsAt: null }],
    errorMessage: null,
    needsAuth: false,
    ...overrides,
  };
}

/** Default orchestrator: nothing known yet — every field absent. */
function orchestrator(overrides: Partial<SamuraiRunOrchestrator> = {}): SamuraiRunOrchestrator {
  return {
    generation: null,
    session_id: null,
    model: null,
    context_window: null,
    context_percent: null,
    ...overrides,
  };
}

/** A pre-#83 config by default: raw ref in `epic`, both lists empty. */
function run(overrides: Partial<SamuraiRunListEntry> = {}): SamuraiRunListEntry {
  return {
    project_path: "C:\\git\\maestro",
    epic: "#38",
    epics: [],
    issues: [],
    launch_text: null,
    repo_pin: "nachogl1/maestro",
    worktree_path: "C:\\data\\worktrees\\maestro-abc\\maestro-38",
    model: null,
    thresholds: null,
    workflow: null,
    status: "ACTIVE",
    created_at: "2026-08-06T10:00:00Z",
    orchestrator: orchestrator(),
    ...overrides,
  };
}

/** A minimal workflow graph, for the editor fallback and edited-graph cases. */
function workflowGraph(): SamuraiWorkflowGraph {
  return {
    nodes: [
      { id: "implement", text: "Implement the issue." },
      { id: "verify", text: "Verify and push." },
    ],
    edges: [{ from: "implement", to: "verify" }],
    start: "implement",
  };
}

/** Routes the invoke mock by command; unknown commands resolve empty. */
function mockInvoke({
  preflight = passPreflight(),
  runs = [] as SamuraiRunListEntry[],
  usage = buildUsage(),
} = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "samurai_preflight":
        return preflight;
      case "samurai_list_runs":
        return runs;
      case "get_claude_usage":
        return usage;
      case "samurai_launch_run":
        // Since issue #83 the backend answers with the readable label, and
        // the branch/worktree carry the combined slug built from it.
        return {
          epic: "epic #38",
          branch: "maestro-epic-38",
          worktree_path: "C:\\data\\worktrees\\maestro-abc\\maestro-epic-38",
          repo_pin: "nachogl1/maestro",
          stale_timer_cancelled: false,
        };
      case "samurai_cleanup_epic":
        return {
          epic: "#38",
          branch: "maestro-38",
          timer_cancelled: true,
          config_archived: true,
          worktree_removed: true,
          worktree_path: "C:\\data\\worktrees\\maestro-abc\\maestro-38",
          branch_deleted: true,
        };
      // The embedded workflow editor's display fallback (issue #91).
      case "samurai_default_workflow":
        return workflowGraph();
      // Issue #129: scheduling answers with the armed entry.
      case "samurai_schedule_launch":
        return timer({
          epic: "issue #38",
          reason: "scheduled_launch",
          fire_at: "2030-01-01T09:30:00.000Z",
        });
      case "samurai_timer_cancel":
        return true;
      // Issue #124: recovery answers with what it started.
      case "samurai_recover_run":
        return {
          epic: "#38",
          generation: 3,
          prior_generation: 2,
          from_handoff: true,
          branch: "maestro-38",
          head: "abc1234",
          timer_cancelled: false,
        };
      default:
        return undefined;
    }
  });
}

/** Calls of one command name, for argument assertions. */
function callsOf(cmd: string) {
  return invokeMock.mock.calls.filter(([name]) => name === cmd);
}

/** One supervised session, exactly as the supervisor registers it (issue #84). */
function supervised(overrides: Partial<SamuraiSessionInfo> = {}): SamuraiSessionInfo {
  return {
    project: "C:\\git\\maestro",
    // The supervisor registers under the run's identity string, so this is
    // the same field the run config carries.
    epic: "#38",
    generation: 1,
    state: "WORKING",
    ...overrides,
  };
}

/** The per-run "open the agent" button of a run labelled `epic`. */
const OPEN_LABEL = (epic: string) => `Open the agent for run ${epic}`;

/** One pending resume timer, as the backend broadcasts it (issue #61). */
function timer(overrides: Partial<SamuraiScheduleEntry> = {}): SamuraiScheduleEntry {
  return {
    project_path: "C:\\git\\maestro",
    epic: "#38",
    // 7d 1h 30m out — the shape a 7-day-allowance park really has.
    fire_at: new Date(Date.now() + 7 * 86_400_000 + 90 * 60_000).toISOString(),
    reason: "park",
    ...overrides,
  };
}

describe("LaunchSection (issue #63)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    listenMock.mockReset();
    emitGateEvent = () => {};
    listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
      if (event === "samurai-test-gate-event") {
        emitGateEvent = (payload) => handler({ payload });
      }
      return Promise.resolve(() => {});
    }) as typeof listen);
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    // Untouched workflow editor by default — launches send workflow: null.
    useSamuraiWorkflowStore.setState({ graph: null });
    useSessionStore.setState({ samuraiBySessionId: {}, samuraiSchedule: [] });
    usePendingLaunchStore.setState({ pending: [] });
    // Issue #109: the gate listener + store are module-level (they outlive
    // mounts on purpose) — detach and drain them between tests so each test
    // captures a fresh handler from ITS listen mock.
    stopSamuraiGateListener();
    useSamuraiGateStore.setState({ gates: {} });
    // Issue #91 (full-screen follow-up): the overlay's open state is a
    // module-level store — reset between tests like the others above.
    useWorkflowsViewStore.setState({ isOpen: false });
  });

  /** The free-text launch box (issue #128). */
  const textBox = () => screen.getByLabelText("What do you want to work on today");

  it("renders the form with the active project and a disabled Launch button", async () => {
    render(<LaunchSection />);
    expect(screen.getByText("Launch Run")).toBeInTheDocument();
    // The project is read-only context, shown by name — not an input.
    expect(screen.getByText("maestro")).toBeInTheDocument();
    // Issue #128: one free-text box replaces the epics + issues fields.
    expect(textBox()).toBeInTheDocument();
    expect(screen.queryByLabelText("Epics")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Issues")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Handoff at context %")).toBeInTheDocument();
    // The agent-readiness declaration is gone — it is the model's call now.
    // The only checkbox is the test-gate skip toggle (issue #90b), OFF by
    // default: the gate runs unless the user explicitly opts out.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "Skip test-suite gate" })).not.toBeChecked();
    expect(screen.getByText(/Make sure the issues are agent-ready/)).toBeInTheDocument();
    // Nothing to work yet → Launch stays disabled.
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(await screen.findByText("No active runs. Launch one above.")).toBeInTheDocument();
  });

  it("renders a workflow card with a button that opens the full-screen editor (issue #91)", async () => {
    render(<LaunchSection />);
    await screen.findByText("No active runs. Launch one above.");

    expect(screen.getByText("Workflow")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Open workflow editor" });
    expect(useWorkflowsViewStore.getState().isOpen).toBe(false);

    fireEvent.click(button);

    // The inline editor is gone — LaunchSection only flips the shared
    // open-state store; `WorkflowsView` itself renders elsewhere (App).
    expect(useWorkflowsViewStore.getState().isOpen).toBe(true);
    expect(screen.queryByLabelText("Edit step implement")).not.toBeInTheDocument();
  });

  it("keeps Launch disabled while the request box is blank", async () => {
    render(<LaunchSection />);
    // Let the runs list and the usage poll land first — this test never
    // awaits anything else, and a late resolve would fire outside act().
    await screen.findByText("No active runs. Launch one above.");
    await waitFor(() => expect(callsOf("get_claude_usage").length).toBeGreaterThan(0));

    const button = () => screen.getByRole("button", { name: "Launch" });
    expect(button()).toBeDisabled();

    // Whitespace carries no request — still nothing to run.
    fireEvent.change(textBox(), { target: { value: "   " } });
    expect(button()).toBeDisabled();

    fireEvent.change(textBox(), { target: { value: "#7" } });
    expect(button()).toBeEnabled();
    fireEvent.change(textBox(), { target: { value: "" } });
    expect(button()).toBeDisabled();
  });

  it("runs preflight then launches from the one button, no declaration needed", async () => {
    render(<LaunchSection />);
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    fireEvent.change(textBox(), { target: { value: "work on #38" } });
    expect(screen.getByRole("button", { name: "Launch" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    // Preflight runs as phase 1 of the launch, not as a separate click, and
    // strictly before it — the launch must never start on an unchecked env.
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_preflight")).toHaveLength(1);
    const order = invokeMock.mock.calls.map(([name]) => name);
    expect(order.indexOf("samurai_preflight")).toBeLessThan(order.indexOf("samurai_launch_run"));
    expect(callsOf("samurai_launch_run")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      // Issue #128: the request rides to the backend verbatim.
      text: "work on #38",
      model: null,
      handoffContextPct: null,
      skipTestGate: false,
      // Issue #91: the workflow editor is untouched — null lets the backend
      // fall back to (and snapshot) the default template.
      workflow: null,
    });
    expect(
      await screen.findByText(/Run launched: epic #38 on maestro-epic-38/),
    ).toBeInTheDocument();
  });

  it("sends the edited workflow graph with the launch (issue #91)", async () => {
    // A persisted edit (here: the chain cut after "implement") rides the
    // launch verbatim — the backend snapshots exactly what the editor holds.
    const edited: SamuraiWorkflowGraph = { ...workflowGraph(), edges: [] };
    useSamuraiWorkflowStore.setState({ graph: edited });
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({ workflow: edited });
  });

  // The scheduled path sent no `workflow` at all, so the backend snapshotted
  // the DEFAULT template into the run config and issue #91's edited graph was
  // silently discarded for every scheduled launch.
  it("sends the edited workflow graph with a SCHEDULED launch too (issue #91)", async () => {
    const edited: SamuraiWorkflowGraph = { ...workflowGraph(), edges: [] };
    useSamuraiWorkflowStore.setState({ graph: edited });
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "work #38" } });
    fireEvent.change(screen.getByLabelText("Schedule for later"), {
      target: { value: "2030-01-01T09:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(callsOf("samurai_schedule_launch")).toHaveLength(1));
    expect(callsOf("samurai_schedule_launch")[0][1]).toMatchObject({ workflow: edited });
  });

  it("sends workflow: null with a scheduled launch when the editor is untouched", async () => {
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "work #38" } });
    fireEvent.change(screen.getByLabelText("Schedule for later"), {
      target: { value: "2030-01-01T09:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(callsOf("samurai_schedule_launch")).toHaveLength(1));
    expect(callsOf("samurai_schedule_launch")[0][1]).toMatchObject({ workflow: null });
  });

  it("summarises the refs detected in the request (issue #128)", async () => {
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "finish #77 and #78" } });
    expect(screen.getByText(/2 issue refs detected/)).toBeInTheDocument();

    // Prose only: no phantom refs — the run works from the words alone.
    fireEvent.change(textBox(), { target: { value: "fix 3 bugs in module 7" } });
    expect(screen.queryByText(/refs detected/)).not.toBeInTheDocument();
  });

  it("launches plain prose without any inline validation error (issue #128)", async () => {
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "refactor the audit panel styling" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({
      text: "refactor the audit panel styling",
    });
    expect(screen.queryByText(/is not an issue number/)).not.toBeInTheDocument();
  });

  it("schedules the launch instead when a day+time is picked (issue #129)", async () => {
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "work #38" } });
    fireEvent.change(screen.getByLabelText("Schedule for later"), {
      target: { value: "2030-01-01T09:30" },
    });

    // With a time set, the one button arms the schedule, not a launch.
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(callsOf("samurai_schedule_launch")).toHaveLength(1));
    expect(callsOf("samurai_schedule_launch")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      text: "work #38",
      fireAt: new Date("2030-01-01T09:30").toISOString(),
      model: null,
      handoffContextPct: null,
      skipTestGate: false,
      workflow: null,
    });
    // Nothing launched now, and the form cleared for the next request.
    expect(callsOf("samurai_launch_run")).toHaveLength(0);
    expect(await screen.findByText(/Launch scheduled: issue #38/)).toBeInTheDocument();
    expect(textBox()).toHaveValue("");
    expect(screen.getByLabelText("Schedule for later")).toHaveValue("");
  });

  it("arms the scheduled launch once on a double-click (PR #131 review L4)", async () => {
    // Hold the arm call open so the second click lands while it is in flight.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "samurai_schedule_launch") {
        await gate;
        return timer({
          epic: "issue #38",
          reason: "scheduled_launch",
          fire_at: "2030-01-01T09:30:00.000Z",
        });
      }
      return base?.(cmd, args as never);
    });
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "work #38" } });
    fireEvent.change(screen.getByLabelText("Schedule for later"), {
      target: { value: "2030-01-01T09:30" },
    });

    const button = screen.getByRole("button", { name: "Schedule" });
    fireEvent.click(button);
    // Busy while the backend arms — a second click must be inert.
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    release();

    expect(await screen.findByText(/Launch scheduled: issue #38/)).toBeInTheDocument();
    expect(callsOf("samurai_schedule_launch")).toHaveLength(1);
  });

  it("rejects a past schedule time inline and never calls the backend (issue #129)", async () => {
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "work #38" } });
    fireEvent.change(screen.getByLabelText("Schedule for later"), {
      target: { value: "2020-01-01T09:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    expect(await screen.findByText(/Pick a future day and time/)).toBeInTheDocument();
    expect(callsOf("samurai_schedule_launch")).toHaveLength(0);
    expect(callsOf("samurai_launch_run")).toHaveLength(0);
  });

  it("offers launch-or-discard on a held scheduled launch (issue #129)", async () => {
    // A scheduled launch whose time passed while Maestro was closed: the
    // backend held it at startup instead of auto-firing.
    useSessionStore.setState({
      samuraiSchedule: [
        timer({
          epic: "issue #38",
          reason: "scheduled_launch",
          held: true,
          launch: {
            text: "work #38",
            model: "claude-opus-5",
            handoff_context_pct: 30,
            skip_test_gate: true,
            attempts: 0,
          },
        }),
      ],
    });
    render(<LaunchSection />);
    expect(screen.getByText("issue #38")).toBeInTheDocument();
    expect(screen.getByText(/Overdue — did not launch/)).toBeInTheDocument();

    // Launch now: the stored request launches through the normal path, with
    // the options it was scheduled with.
    fireEvent.click(screen.getByRole("button", { name: "Launch now" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({
      projectPath: "C:\\git\\maestro",
      text: "work #38",
      model: "claude-opus-5",
      handoffContextPct: 30,
      skipTestGate: true,
    });

    // Discard: cancel the timer, launch nothing further.
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(callsOf("samurai_timer_cancel")).toHaveLength(1));
    expect(callsOf("samurai_timer_cancel")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "issue #38",
    });
  });

  it("recovers a crashed run from its row (issue #124)", async () => {
    // An ACTIVE run with no live agent — exactly the crashed shape.
    mockInvoke({ runs: [run()] });
    render(<LaunchSection />);
    await screen.findByText("#38");

    fireEvent.click(screen.getByRole("button", { name: "Recover run #38" }));
    await waitFor(() => expect(callsOf("samurai_recover_run")).toHaveLength(1));
    expect(callsOf("samurai_recover_run")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "#38",
    });
    expect(
      await screen.findByText(/Recovery started: gen-3 for #38 on maestro-38 @ abc1234/),
    ).toBeInTheDocument();
  });

  it("offers no recovery on a completed or live run (issue #124)", async () => {
    // COMPLETED: finished, cleanup is its next step — nothing to recover.
    mockInvoke({ runs: [run({ status: "COMPLETED" })] });
    const view = render(<LaunchSection />);
    await screen.findByText("#38");
    expect(screen.queryByRole("button", { name: "Recover run #38" })).not.toBeInTheDocument();
    view.unmount();

    // A live agent in an open tab: recovery would duplicate it.
    useSessionStore.setState({ samuraiBySessionId: { 7: supervised() } });
    mockInvoke({ runs: [run()] });
    render(<LaunchSection onNavigate={vi.fn()} />);
    const open = await screen.findByRole("button", { name: OPEN_LABEL("#38") });
    expect(open).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Recover run #38" })).not.toBeInTheDocument();
  });

  it("offers recovery when the run's newest session is in a terminal state (PR #131 review H1)", async () => {
    // Issue #122 parks a dead session's tile instead of removing it, so the
    // store still holds its entry — but a DEAD agent is exactly the crashed
    // case Recover (issue #124) exists for.
    useSessionStore.setState({
      samuraiBySessionId: { 3: supervised({ generation: 2, state: "DEAD" }) },
    });
    mockInvoke({ runs: [run()] });
    render(<LaunchSection onNavigate={vi.fn()} />);

    // The parked tile stays openable (issue #122)…
    expect(await screen.findByRole("button", { name: OPEN_LABEL("#38") })).toBeEnabled();
    // …AND the run is recoverable — the two are not mutually exclusive.
    fireEvent.click(screen.getByRole("button", { name: "Recover run #38" }));
    await waitFor(() => expect(callsOf("samurai_recover_run")).toHaveLength(1));
  });

  // `recover_run_inner` takes no lock and fire-and-forgets the generation
  // spawn, so two calls that both pass its "no live session" check stage TWO
  // gen-N+1 orchestrators into the same worktree.
  it("ignores a second Recover click while the first is still in flight", async () => {
    let releaseRecover: (() => void) | undefined;
    mockInvoke({ runs: [run()] });
    const base = invokeMock.getMockImplementation();
    if (!base) throw new Error("expected mockInvoke to install an implementation");
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "samurai_recover_run") {
        await new Promise<void>((resolve) => {
          releaseRecover = resolve;
        });
      }
      return base(cmd, args as never);
    });
    render(<LaunchSection />);
    await screen.findByText("#38");

    const button = screen.getByRole("button", { name: "Recover run #38" });
    // Both clicks inside ONE act: React batches, so the second handler runs
    // against the same render's closure and the button has not disabled yet —
    // the real double-click, which a state-only guard does not catch.
    await act(async () => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(callsOf("samurai_recover_run")).toHaveLength(1));

    // Even after the click handlers settle, the second click stayed dropped.
    await act(async () => {
      releaseRecover?.();
    });
    expect(callsOf("samurai_recover_run")).toHaveLength(1);
  });

  // The backend only refuses a recovery while `parking_engaged()` is true,
  // and that flag clears as soon as the sweep arms its timers — so a click on
  // the refresh icon right above a "PARKED · resumes …" badge cancelled the
  // resume timer and spawned a fresh generation into the exhausted allowance
  // window the park existed to protect.
  it("offers no recovery on a parked run", async () => {
    useSessionStore.setState({ samuraiSchedule: [timer()] });
    mockInvoke({ runs: [run()] });
    render(<LaunchSection />);

    expect(await screen.findByText(/^PARKED · resumes /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recover run #38" })).not.toBeInTheDocument();
  });

  // KILLED is the NORMAL post-handoff state, held until the successor
  // registers — a click there spawns gen N+1 concurrently with the
  // replicator's own gen N+1.
  it("offers no recovery while the run's successor launch is still queued", async () => {
    useSessionStore.setState({
      samuraiBySessionId: { 3: supervised({ generation: 2, state: "KILLED" }) },
    });
    usePendingLaunchStore.setState({
      pending: [
        {
          tabId: "tab-1",
          mode: "Claude",
          resumeSessionId: null,
          workingDirOverride: "C:\\data\\worktrees\\maestro-abc\\maestro-38",
          branch: null,
          samurai: { project: "C:\\git\\maestro", epic: "#38", generation: 3, model: null },
        },
      ],
    });
    mockInvoke({ runs: [run()] });
    render(<LaunchSection onNavigate={vi.fn()} />);

    await screen.findByText("#38");
    expect(screen.queryByRole("button", { name: "Recover run #38" })).not.toBeInTheDocument();
  });

  // …but a KILLED run whose successor never got staged (spawn_dropped,
  // successor_no_start) is genuinely stuck, and Recover is its only way out.
  it("still offers recovery on a KILLED run with no queued successor", async () => {
    useSessionStore.setState({
      samuraiBySessionId: { 3: supervised({ generation: 2, state: "KILLED" }) },
    });
    mockInvoke({ runs: [run()] });
    render(<LaunchSection onNavigate={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Recover run #38" }));
    await waitFor(() => expect(callsOf("samurai_recover_run")).toHaveLength(1));
  });

  it("shows a pending scheduled launch with its fire time (issue #129)", async () => {
    useSessionStore.setState({
      samuraiSchedule: [
        timer({
          epic: "issue #41",
          reason: "scheduled_launch",
          fire_at: "2030-01-01T09:30:00.000Z",
          launch: {
            text: "work #41",
            model: null,
            handoff_context_pct: null,
            skip_test_gate: false,
            attempts: 0,
          },
        }),
      ],
    });
    render(<LaunchSection />);
    expect(screen.getByText("issue #41")).toBeInTheDocument();
    expect(screen.getByText(/Launches at /)).toBeInTheDocument();
    // A plain park resume timer never renders in this block.
    expect(screen.queryByText("#38")).not.toBeInTheDocument();
  });

  it("shows remaining allowance per model and pins the chosen one", async () => {
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38" } });

    // Wait for the usage poll to land before opening the picker.
    await waitFor(() => expect(callsOf("get_claude_usage").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText("Model"));

    const listbox = await screen.findByRole("listbox", { name: "Model" });
    // 38% used → 62% left; Fable 91% used → 9% left; Haiku has no window.
    expect(within(listbox).getByText("62% left")).toBeInTheDocument();
    expect(within(listbox).getByText("9% left")).toBeInTheDocument();
    // Default (no model pinned) and Haiku (no window reported) both show the
    // unknown dash — "no data" must never render as 0% left.
    expect(within(listbox).getAllByText("—")).toHaveLength(2);

    fireEvent.click(within(listbox).getByRole("option", { name: /Opus 5/ }));
    fireEvent.click(screen.getByRole("button", { name: /Launch/ }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({ model: "claude-opus-5" });
  });

  it("passes the per-run handoff % override to the launch (review F4)", async () => {
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38 and #41" } });
    fireEvent.change(screen.getByLabelText("Handoff at context %"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      text: "#38 and #41",
      model: null,
      handoffContextPct: 30,
      skipTestGate: false,
      workflow: null,
    });
    // Every field clears together after a launch.
    await screen.findByText(/Run launched: epic #38/);
    expect(textBox()).toHaveValue("");
    expect(screen.getByLabelText("Handoff at context %")).toHaveValue(null);
  });

  it("sends the skip test-gate toggle with the launch args (issue #90b)", async () => {
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Skip test-suite gate" }));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toMatchObject({ skipTestGate: true });
  });

  it("renders live test-gate progress with elapsed time during a launch (issue #90b)", async () => {
    let resolveLaunch: (result: unknown) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return passPreflight();
        case "samurai_list_runs":
          return [];
        case "get_claude_usage":
          return buildUsage();
        case "samurai_launch_run":
          return new Promise((resolve) => {
            resolveLaunch = resolve;
          });
        default:
          return undefined;
      }
    });
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));

    // A backend tick lands: the button shows the step with elapsed time.
    act(() => {
      emitGateEvent({
        project: "C:\\git\\maestro",
        epic: "#38",
        step: "cargo_test",
        detail: "cargo test: running the workspace suite…",
        elapsed_secs: 12,
      });
    });
    expect(screen.getByText(/cargo test: running the workspace suite… · \d+s/)).toBeInTheDocument();

    // Another project's tick must not repaint this launcher.
    act(() => {
      emitGateEvent({
        project: "C:\\git\\other",
        epic: "#9",
        step: "bootstrap_npm",
        detail: "bootstrap: npm install…",
        elapsed_secs: 3,
      });
    });
    expect(screen.queryByText(/npm install… ·/)).not.toBeInTheDocument();
    expect(screen.getByText(/cargo test: running the workspace suite…/)).toBeInTheDocument();

    // The launch resolves: the progress line clears with the phase.
    await act(async () => {
      resolveLaunch({
        epic: "#38",
        branch: "maestro-38",
        worktree_path: "C:\\data\\worktrees\\maestro-abc\\maestro-38",
        repo_pin: null,
        stale_timer_cancelled: false,
      });
    });
    expect(await screen.findByText(/Run launched: #38/)).toBeInTheDocument();
    expect(screen.queryByText(/cargo test: running/)).not.toBeInTheDocument();
  });

  it("keeps the gate progress line across a panel switch mid-gate (issue #109)", async () => {
    // The launch stays pending the whole test (the gate is mid-run).
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return passPreflight();
        case "samurai_list_runs":
          return [];
        case "get_claude_usage":
          return buildUsage();
        case "samurai_launch_run":
          return new Promise(() => {});
        case "samurai_default_workflow":
          return workflowGraph();
        default:
          return undefined;
      }
    });
    const first = render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));

    act(() => {
      emitGateEvent({
        project: "C:\\git\\maestro",
        epic: "#38",
        step: "cargo_test",
        detail: "cargo test: running the workspace suite…",
        elapsed_secs: 12,
      });
    });
    expect(screen.getByText(/cargo test: running the workspace suite… · \d+s/)).toBeInTheDocument();

    // The user switches sidebar panels: the section unmounts mid-gate. A
    // later backend tick lands while nothing is mounted — the store-level
    // subscription still records it.
    first.unmount();
    act(() => {
      emitGateEvent({
        project: "C:\\git\\maestro",
        epic: "#38",
        step: "cargo_test",
        detail: "cargo test: running the workspace suite…",
        elapsed_secs: 30,
      });
    });

    // Remount: the running step (with elapsed time) is back, read from the
    // store — this used to come back blank (component state died).
    render(<LaunchSection />);
    expect(
      await screen.findByText(/cargo test: running the workspace suite… · \d+s/),
    ).toBeInTheDocument();
    await screen.findByText("No active runs. Launch one above.");
  });

  it("surfaces a gate failure that landed while the panel was unmounted (issue #109)", async () => {
    let rejectLaunch: (err: unknown) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return passPreflight();
        case "samurai_list_runs":
          return [];
        case "get_claude_usage":
          return buildUsage();
        case "samurai_launch_run":
          return new Promise((_, reject) => {
            rejectLaunch = reject;
          });
        case "samurai_default_workflow":
          return workflowGraph();
        default:
          return undefined;
      }
    });
    const first = render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));

    // Panel switched away mid-gate; the red verdict lands while unmounted.
    first.unmount();
    act(() => {
      emitGateEvent({
        project: "C:\\git\\maestro",
        epic: "#38",
        step: "failed",
        detail: "test gate failed: cargo test exited 101",
        elapsed_secs: 40,
      });
    });
    await act(async () => {
      rejectLaunch("launch refused: the test gate is red");
    });

    // Remount: the failure is visible in the panel (it used to live only in
    // the audit log — the rejection's setError died with the old mount).
    render(<LaunchSection />);
    expect(await screen.findByText(/test gate failed: cargo test exited 101/)).toBeInTheDocument();
    await screen.findByText("No active runs. Launch one above.");
  });

  it("stops at failing preflight rows and never reaches the launch", async () => {
    mockInvoke({
      preflight: {
        gh_auth: { ok: false, username: null, error: "gh is not authenticated" },
        windows_reported: false,
      },
    });
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(await screen.findByText(/gh auth failed/)).toBeInTheDocument();
    expect(screen.getByText(/gh is not authenticated/)).toBeInTheDocument();
    expect(screen.getByText(/No governing allowance window/)).toBeInTheDocument();
    expect(screen.getByText(/Preflight failed/)).toBeInTheDocument();
    expect(callsOf("samurai_launch_run")).toHaveLength(0);
    // Still launchable once the user fixes the environment.
    expect(screen.getByRole("button", { name: "Launch" })).toBeEnabled();
  });

  it("lists active runs and cleans one up after the ask() confirm", async () => {
    mockInvoke({ runs: [run()] });
    askMock.mockResolvedValue(true);
    render(<LaunchSection />);

    expect(await screen.findByText("#38")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clean up run #38" }));

    await waitFor(() => expect(callsOf("samurai_cleanup_epic")).toHaveLength(1));
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(String(askMock.mock.calls[0][0])).toContain("cannot be undone");
    expect(callsOf("samurai_cleanup_epic")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "#38",
    });
    expect(
      await screen.findByText(/Cleaned up run #38: removed worktree, branch maestro-38/),
    ).toBeInTheDocument();
  });

  it("shows an immediate spinner and dims the row while the delete is in flight, then removes it on success (issue #99)", async () => {
    let resolveCleanup: (report: unknown) => void = () => {};
    // The list still reports the run until the cleanup actually lands — the
    // mock flips to empty only once the cleanup promise resolves, so a
    // premature refresh (were the component to race one) would not
    // accidentally make this assertion pass.
    let listedRuns: SamuraiRunListEntry[] = [run()];
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return passPreflight();
        case "samurai_list_runs":
          return listedRuns;
        case "get_claude_usage":
          return buildUsage();
        case "samurai_cleanup_epic":
          return new Promise((resolve) => {
            resolveCleanup = resolve;
          });
        case "samurai_default_workflow":
          return workflowGraph();
        default:
          return undefined;
      }
    });
    askMock.mockResolvedValue(true);
    render(<LaunchSection />);

    const trashButton = await screen.findByRole("button", { name: "Clean up run #38" });
    fireEvent.click(trashButton);
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));

    // The cleanup call is still pending (resolveCleanup not called yet), but
    // the button is already disabled and shows the spinner, and the row
    // reads as pending — all before the backend answers.
    await waitFor(() => expect(trashButton).toBeDisabled());
    expect(trashButton.querySelector("svg.animate-spin")).toBeTruthy();
    const rowEl = trashButton.parentElement?.parentElement;
    expect(rowEl).toHaveClass("opacity-60");
    expect(callsOf("samurai_cleanup_epic")).toHaveLength(1);

    await act(async () => {
      listedRuns = [];
      resolveCleanup({
        epic: "#38",
        branch: "maestro-38",
        timer_cancelled: true,
        config_archived: true,
        worktree_removed: true,
        worktree_path: "C:\\data\\worktrees\\maestro-abc\\maestro-38",
        branch_deleted: true,
        spawn_cancelled: false,
      });
    });

    await waitFor(() => expect(screen.queryByText("#38")).not.toBeInTheDocument());
  });

  it("surfaces a rejected delete as an inline row error instead of silently reverting (issue #99)", async () => {
    mockInvoke({ runs: [run()] });
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return passPreflight();
        case "samurai_list_runs":
          return [run()];
        case "get_claude_usage":
          return buildUsage();
        case "samurai_cleanup_epic":
          throw "cleanup refused: worktree has uncommitted changes";
        case "samurai_default_workflow":
          return workflowGraph();
        default:
          return undefined;
      }
    });
    askMock.mockResolvedValue(true);
    render(<LaunchSection />);

    const trashButton = await screen.findByRole("button", { name: "Clean up run #38" });
    fireEvent.click(trashButton);

    // The row survives (the delete failed) and shows the failure in place —
    // not a bare revert to the pre-click row, and not just the form's
    // top-level error line.
    expect(
      await screen.findByText(/cleanup refused: worktree has uncommitted changes/),
    ).toBeInTheDocument();
    expect(screen.getByText("#38")).toBeInTheDocument();
    expect(trashButton).toBeEnabled();
    expect(trashButton.querySelector("svg.animate-spin")).toBeFalsy();
    const rowEl = trashButton.parentElement?.parentElement;
    expect(rowEl).not.toHaveClass("opacity-60");
  });

  it("shows a COMPLETED run as finished-awaiting-cleanup, distinct from live (issue #96)", async () => {
    mockInvoke({ runs: [run(), run({ epic: "#39", status: "COMPLETED" })] });
    render(<LaunchSection />);

    // The live run keeps its ACTIVE badge; the verified-complete one gets
    // the distinct FINISHED badge naming the awaiting-cleanup state.
    expect(await screen.findByText("FINISHED")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("FINISHED").getAttribute("title")).toContain("Awaiting cleanup");
    // Cleanup stays the separate manual step (PRD §5.9) — still offered.
    expect(screen.getByRole("button", { name: "Clean up run #39" })).toBeInTheDocument();
  });

  it("badges a parked run with its dated resume time and countdown (issue #61)", async () => {
    // Before this, a parked run read "ACTIVE / No live agent for this run" —
    // the park itself, and when it ends, appeared nowhere on the row.
    const pending = timer();
    mockInvoke({ runs: [run(), run({ epic: "#39" })] });
    useSessionStore.setState({ samuraiSchedule: [pending] });
    render(<LaunchSection />);

    const badge = await screen.findByText(/^PARKED · resumes /);
    expect(badge.textContent).toContain(formatFireDateTime(pending.fire_at));
    expect(badge.textContent).toMatch(/· in 7d 1h \d+m$/);
    // Only the run that actually has a timer is badged.
    expect(screen.getAllByText(/^PARKED/)).toHaveLength(1);
  });

  it("matches the timer to the run by project path + epic slug", async () => {
    mockInvoke({
      runs: [
        run({ epic: "epic #5 · issues #7, #9" }),
        // Same epic ref, different project — must never borrow the badge.
        run({ project_path: "C:\\git\\other", epic: "epic #5 · issues #7, #9" }),
      ],
    });
    useSessionStore.setState({
      samuraiSchedule: [
        timer({
          // The backend's canonical `\\?\` spelling of the same directory, and
          // the identity string padded/punctuated differently from the config.
          project_path: "\\\\?\\C:\\git\\maestro",
          epic: " epic #5 - issues #7 #9 ",
        }),
      ],
    });
    render(<LaunchSection />);

    expect(await screen.findByText(/^PARKED · resumes /)).toBeInTheDocument();
    expect(screen.getAllByText(/^PARKED/)).toHaveLength(1);
  });

  it("never badges a run PARKED for a scheduled-launch timer with the same slug (PR #131 review M5)", async () => {
    mockInvoke({ runs: [run()] });
    // Issue #129 keeps scheduled launches in the same schedule list as parks;
    // only a park-reason timer may badge the run.
    useSessionStore.setState({
      samuraiSchedule: [
        timer({
          reason: "scheduled_launch",
          fire_at: "2030-01-01T09:30:00.000Z",
          launch: {
            text: "work #38",
            model: null,
            handoff_context_pct: null,
            skip_test_gate: false,
            attempts: 0,
          },
        }),
      ],
    });
    render(<LaunchSection />);

    await screen.findByText("ACTIVE");
    expect(screen.queryByText(/^PARKED/)).not.toBeInTheDocument();
  });

  it("still badges PARKED when the fire time does not parse, and clears on resume", async () => {
    mockInvoke({ runs: [run()] });
    useSessionStore.setState({ samuraiSchedule: [timer({ fire_at: "garbage" })] });
    render(<LaunchSection />);

    // No time to show, but the parked state must never be hidden.
    const badge = await screen.findByText("PARKED");
    expect(badge.getAttribute("title")).toContain("fire time unreadable");

    // The timer fires: the backend broadcasts the full remaining list, and the
    // badge goes with it — no refresh, no stale "parked" on a live run.
    act(() => {
      useSessionStore.setState({ samuraiSchedule: [] });
    });
    expect(screen.queryByText(/^PARKED/)).not.toBeInTheDocument();
  });

  it("shows the orchestrator's live details on a run row (issue #102)", async () => {
    mockInvoke({
      runs: [
        run({
          orchestrator: orchestrator({
            generation: 3,
            session_id: 42,
            model: "claude-opus-4-6[1m]",
            context_window: 1_000_000,
            context_percent: 38.5,
          }),
        }),
      ],
    });
    render(<LaunchSection />);

    expect(await screen.findByText("claude-opus-4-6[1m]")).toBeInTheDocument();
    expect(screen.getByText("Gen 3")).toBeInTheDocument();
    expect(screen.getByText("Session 42")).toBeInTheDocument();
    expect(screen.getByText("38.5% / 1M")).toBeInTheDocument();
  });

  it("renders absent orchestrator fields as dashes, never a guess (issue #102)", async () => {
    // The default run() has no session registered yet: every orchestrator
    // field is null.
    mockInvoke({ runs: [run()] });
    render(<LaunchSection />);

    expect(await screen.findByText("Gen —")).toBeInTheDocument();
    expect(screen.getByText("Session —")).toBeInTheDocument();
    // The model slot and the context slot both render a bare dash.
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("hides the live context % on a COMPLETED run (issue #102)", async () => {
    // Even if the backend still reports a frozen reading for a run whose
    // terminal already tore down, the panel must not present it as live.
    mockInvoke({
      runs: [
        run({
          epic: "#39",
          status: "COMPLETED",
          orchestrator: orchestrator({
            generation: 2,
            session_id: 7,
            model: "claude-opus-4-6",
            context_window: 200_000,
            context_percent: 90,
          }),
        }),
      ],
    });
    render(<LaunchSection />);

    // The identity facts still show for a finished run…
    expect(await screen.findByText("claude-opus-4-6")).toBeInTheDocument();
    expect(screen.getByText("Gen 2")).toBeInTheDocument();
    expect(screen.getByText("Session 7")).toBeInTheDocument();
    // …but the live context reading does not.
    expect(screen.queryByText(/90%/)).not.toBeInTheDocument();
  });

  it("reads an active run as `epic #5 · issues #7, #9`, legacy configs included", async () => {
    mockInvoke({
      runs: [
        // Post-#83: the backend already stored the readable label.
        run({
          epic: "epic #5 · issues #7, #9",
          epics: ["5"],
          issues: ["7", "9"],
          worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-epic-5-issues-7-9",
        }),
        // Pre-#83: a single raw ref and two empty lists — must still render.
        run({ project_path: "C:\\git\\other", epic: "#38" }),
      ],
    });
    render(<LaunchSection />);

    expect(await screen.findByText("epic #5 · issues #7, #9")).toBeInTheDocument();
    expect(screen.getByText("#38")).toBeInTheDocument();
  });

  it("never cleans up when the confirm is declined", async () => {
    mockInvoke({ runs: [run()] });
    askMock.mockResolvedValue(false);
    render(<LaunchSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Clean up run #38" }));
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(callsOf("samurai_cleanup_epic")).toHaveLength(0);
  });

  it("drops a preflight result that lands after a project switch", async () => {
    let resolvePreflight: (result: SamuraiPreflight) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return new Promise<SamuraiPreflight>((resolve) => {
            resolvePreflight = resolve;
          });
        case "samurai_list_runs":
          return [];
        case "get_claude_usage":
          return buildUsage();
        default:
          return undefined;
      }
    });
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    // Switch projects while the probe (gh auth status subprocess) is still out.
    act(() => {
      useWorkspaceStore.setState({
        tabs: [buildTab({ id: "tab-2", name: "other", projectPath: "C:\\git\\other" })],
      });
    });
    expect(await screen.findByText("other")).toBeInTheDocument();

    // The old project's answer lands — it must not launch into the new one.
    await act(async () => {
      resolvePreflight(passPreflight());
    });

    expect(screen.queryByText("gh authenticated as nachogl1")).not.toBeInTheDocument();
    expect(callsOf("samurai_launch_run")).toHaveLength(0);
    // The phase cleared, so the button is usable again for the new project.
    expect(screen.getByRole("button", { name: "Launch" })).toBeEnabled();
  });

  it("shows a backend launch refusal as an error", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return passPreflight();
        case "samurai_list_runs":
          return [];
        case "get_claude_usage":
          return buildUsage();
        case "samurai_launch_run":
          throw "launch refused: this epic already has a live supervised session";
        default:
          return undefined;
      }
    });
    render(<LaunchSection />);
    fireEvent.change(textBox(), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(
      await screen.findByText(/launch refused: this epic already has a live supervised session/),
    ).toBeInTheDocument();
  });

  it("opens the newest live generation of a run's agent (issue #84)", async () => {
    mockInvoke({ runs: [run()] });
    useSessionStore.setState({
      samuraiBySessionId: {
        // gen-1, killed when gen-2 replaced it (issue #55 replication).
        4: supervised({ generation: 1, state: "KILLED" }),
        // gen-2, the one actually working — and registered under the
        // backend's canonical `\\?\` spelling of the same directory.
        7: supervised({ project: "\\\\?\\C:\\git\\maestro", generation: 2 }),
        // A higher generation of the same ref in ANOTHER project: never it.
        9: supervised({ project: "C:\\git\\other", generation: 3 }),
      },
    });
    const onNavigate = vi.fn();
    render(<LaunchSection onNavigate={onNavigate} />);

    const button = await screen.findByRole("button", { name: OPEN_LABEL("#38") });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("tab-1", 7);
  });

  it("disables the open button and says why when no agent is registered", async () => {
    mockInvoke({ runs: [run()] });
    const onNavigate = vi.fn();
    render(<LaunchSection onNavigate={onNavigate} />);

    const button = await screen.findByRole("button", { name: OPEN_LABEL("#38") });
    expect(button).toBeDisabled();
    // The reason hangs off the wrapper — a disabled button never gets hovered.
    expect(screen.getByTitle(/not running in this Maestro session/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("opens (and unparks) a run whose terminal was parked to the footer tray (issue #122)", async () => {
    mockInvoke({ runs: [run()] });
    useSessionStore.setState({
      samuraiBySessionId: { 3: supervised({ generation: 2, state: "PARKED" }) },
    });
    const onNavigate = vi.fn();
    render(<LaunchSection onNavigate={onNavigate} />);

    // PARKED no longer closes the tile (issue #122: it moves to the existing
    // footer parking tray instead), so the open button stays enabled and
    // opening it is the same navigate-to-session path as any live run —
    // TerminalGrid's zoomSession unparks it on the way in.
    const button = await screen.findByRole("button", { name: OPEN_LABEL("#38") });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onNavigate).toHaveBeenCalledWith("tab-1", 3);
    // The unpark half of that promise belongs to `zoomSession`, which App
    // routes onNavigate to — covered in TerminalGrid.samuraiClose.test.tsx
    // ("unparks the session when zoomSession opens a parked tile").
  });

  it("never cross-focuses two projects running the same epic ref", async () => {
    mockInvoke({ runs: [run(), run({ project_path: "C:\\git\\other" })] });
    // Only the second project has a live agent under `#38`.
    useSessionStore.setState({
      samuraiBySessionId: { 12: supervised({ project: "C:\\git\\other" }) },
    });
    useWorkspaceStore.setState({
      tabs: [
        buildTab(),
        buildTab({ id: "tab-2", name: "other", projectPath: "C:\\git\\other", active: false }),
      ],
    });
    const onNavigate = vi.fn();
    render(<LaunchSection onNavigate={onNavigate} />);

    // Rows keep samurai_list_runs order: [0] is maestro, [1] is other.
    const buttons = await screen.findAllByRole("button", { name: OPEN_LABEL("#38") });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();

    fireEvent.click(buttons[1]);
    expect(onNavigate).toHaveBeenCalledWith("tab-2", 12);
  });
});
