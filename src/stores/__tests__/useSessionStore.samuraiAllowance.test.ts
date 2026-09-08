import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
// The watchdog store persists through the Tauri store plugin; happy-dom has
// no Tauri backend, so stub it out (same as useSessionStore.samuraiFatal).
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));
vi.mock("@/lib/osNotification", () => ({
  notifyOs: vi.fn().mockResolvedValue(undefined),
}));

import { listen } from "@tauri-apps/api/event";

import { notifyOs } from "@/lib/osNotification";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import {
  type BackendSessionStatus,
  initSamuraiSupervisorListener,
  SAMURAI_ACCOUNT_PROJECT,
  SAMURAI_ACCOUNT_RUN,
  type SessionConfig,
  useSessionStore,
} from "../useSessionStore";

const listenMock = vi.mocked(listen);

function session(
  id: number,
  status: BackendSessionStatus = "Working",
  projectPath = "C:/proj",
): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: projectPath,
  };
}

/** Captured event handlers, so tests can emit supervisor/allowance events. */
let emitSupervisorEvent: (payload: Record<string, unknown>) => void;
let emitAllowanceEvent: (payload: Record<string, unknown>) => void;

/** The hard 5h crossing the last real run's account log actually recorded. */
function hardCrossing(overrides: Record<string, unknown> = {}) {
  return {
    kind: "allowance_threshold",
    window: "5h",
    threshold_kind: "hard",
    value: 90,
    threshold: 90,
    resets_at: "2026-08-19T14:00:00Z",
    ...overrides,
  };
}

beforeAll(async () => {
  listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
    if (event === "samurai-supervisor-event") {
      emitSupervisorEvent = (payload) => handler({ payload });
    }
    if (event === "samurai-allowance-event") {
      emitAllowanceEvent = (payload) => handler({ payload });
    }
    return Promise.resolve(() => {});
  }) as typeof listen);
  await initSamuraiSupervisorListener();
});

/**
 * An allowance crossing with NOTHING supervised used to produce no surface at
 * all: the attention badge had nowhere to land, so the handler returned
 * early — no toast, no OS notification — and the ALERT rows went to the
 * account-wide pseudo-project's audit log. That is the exact state the last
 * real crossing happened in (the run had already died), so the user learned
 * about a hard park threshold from nothing.
 */
describe("account-wide samurai allowance crossings", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [session(1)],
      attentionSessionIds: [],
      samuraiBySessionId: {},
      samuraiToasts: [],
    });
    useGitHubWatchdogStore.setState({ notificationsEnabled: true });
    vi.mocked(notifyOs).mockClear();
  });

  it("raises a toast and an OS notification when nothing is supervised", () => {
    emitAllowanceEvent(hardCrossing());

    const state = useSessionStore.getState();
    expect(state.attentionSessionIds).toEqual([]);
    expect(state.samuraiToasts).toHaveLength(1);
    expect(state.samuraiToasts[0]).toMatchObject({
      kind: "allowance",
      project: SAMURAI_ACCOUNT_PROJECT,
      epic: SAMURAI_ACCOUNT_RUN,
      generation: 0,
      label: "5h usage hit 90% — hard (park) threshold",
    });
    expect(vi.mocked(notifyOs).mock.calls).toEqual([
      ["Samurai — token allowance", "5h usage hit 90% — hard (park) threshold"],
    ]);
  });

  it("reads a soft crossing as a wind-down, and copes with a window it has no reading for", () => {
    emitAllowanceEvent(hardCrossing({ threshold_kind: "soft", value: 78, threshold: 78 }));
    emitAllowanceEvent({ kind: "allowance_threshold" });

    expect(useSessionStore.getState().samuraiToasts.map((t) => t.label)).toEqual([
      "5h usage hit 78% — soft (wind-down) threshold",
      "Usage crossed a threshold",
    ]);
  });

  it("stays silent for a recovery, a missing window, and an unknown payload", () => {
    emitAllowanceEvent({ kind: "allowance_recovered", window: "5h", value: 60 });
    emitAllowanceEvent({ kind: "no_governing_window" });
    emitAllowanceEvent({});

    const state = useSessionStore.getState();
    expect(state.samuraiToasts).toEqual([]);
    expect(notifyOs).not.toHaveBeenCalled();
  });

  it("badges the live supervised runs instead of announcing account-wide", () => {
    useSessionStore.setState({ sessions: [session(1), session(2)] });
    emitSupervisorEvent({
      session_id: 1,
      project: "C:/proj",
      epic: "#38",
      generation: 1,
      state: "WORKING",
    });

    emitAllowanceEvent(hardCrossing());

    const state = useSessionStore.getState();
    // The crossing is about that run — the existing attention mechanism says
    // so, and the account-wide toast would name no run at all.
    expect(state.attentionSessionIds).toEqual([1]);
    expect(state.samuraiToasts).toEqual([]);
    expect(notifyOs).not.toHaveBeenCalled();
  });

  it("honours the notifications toggle, the way every other samurai surface does", () => {
    useGitHubWatchdogStore.setState({ notificationsEnabled: false });

    emitAllowanceEvent(hardCrossing());

    const state = useSessionStore.getState();
    expect(state.samuraiToasts).toEqual([]);
    expect(notifyOs).not.toHaveBeenCalled();
  });

  it("does not churn the attention array when there is nothing to announce", () => {
    const before = useSessionStore.getState().attentionSessionIds;
    emitAllowanceEvent({ kind: "allowance_recovered" });
    expect(useSessionStore.getState().attentionSessionIds).toBe(before);
  });
});
