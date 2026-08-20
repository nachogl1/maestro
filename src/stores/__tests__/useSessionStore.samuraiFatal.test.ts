import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
// The watchdog store persists through the Tauri store plugin; happy-dom has
// no Tauri backend, so stub it out (same as useGitHubWatchdogStore.test.ts).
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

import { listen } from "@tauri-apps/api/event";

import type { SamuraiAuditEvent } from "@/lib/samurai";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import {
  type BackendSessionStatus,
  initSamuraiSupervisorListener,
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

/** Captured `samurai-audit-event` handler, so tests can stream rows in. */
let emitAuditEvent: (event: Partial<SamuraiAuditEvent>, project?: string) => void;

function auditRow(overrides: Partial<SamuraiAuditEvent>): SamuraiAuditEvent {
  return {
    ts: "2026-08-20T10:00:00Z",
    epic: "nido",
    event: "ALERT",
    generation: 2,
    session_id: 1,
    details: {},
    ...overrides,
  };
}

beforeAll(async () => {
  listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
    if (event === "samurai-audit-event") {
      emitAuditEvent = (row, project = "C:/proj") => {
        handler({ payload: { project, event: auditRow(row) } });
      };
    }
    return Promise.resolve(() => {});
  }) as typeof listen);
  await initSamuraiSupervisorListener();
});

describe("run-fatal samurai audit events (issue #174)", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [session(1)],
      parkedSessionIds: [],
      attentionSessionIds: [],
      samuraiBySessionId: {},
      samuraiToasts: [],
    });
    useGitHubWatchdogStore.setState({ notificationsEnabled: true });
  });

  it("replaying the Nido tail ends with toasts and an attention badge on the session", () => {
    // The audit tail that stranded the live Nido run: delivery gave up, then
    // the breaker parked the successor. Retries and INJECT rows are noise;
    // the two run-fatal rows must each surface exactly once.
    emitAuditEvent({ event: "INJECT", details: { phase: "delivered" } });
    emitAuditEvent({ details: { kind: "submit_retry", attempt: 1 } });
    emitAuditEvent({ details: { kind: "submit_retry", attempt: 2 } });
    emitAuditEvent({ details: { kind: "submit_unconfirmed", resends: 2 } });
    emitAuditEvent({ event: "PARK", details: { phase: "parked" } });
    emitAuditEvent({ details: { kind: "circuit_breaker", events: 5 } });

    const state = useSessionStore.getState();
    expect(state.samuraiToasts.map((t) => t.label)).toEqual([
      "Brief delivery unconfirmed — the run may be stranded",
      "Circuit breaker parked the run",
    ]);
    expect(state.samuraiToasts[0]).toMatchObject({
      project: "C:/proj",
      epic: "nido",
      generation: 2,
    });
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it("notifications off suppresses the toast but never the badge", () => {
    useGitHubWatchdogStore.setState({ notificationsEnabled: false });

    emitAuditEvent({ details: { kind: "submit_unconfirmed" } });

    const state = useSessionStore.getState();
    expect(state.samuraiToasts).toEqual([]);
    expect(state.attentionSessionIds).toEqual([1]);
  });

  it("covers the other fatal kinds: no-start, spawn_dropped, exhausted re-delivery, silent death", () => {
    emitAuditEvent({ details: { kind: "successor_no_start", registered: true } });
    emitAuditEvent({ details: { kind: "spawn_dropped" } });
    emitAuditEvent({ details: { kind: "delivery_failed", retype: true } });
    emitAuditEvent({ event: "KILL", details: { kind: "dead", cause: "process_died" } });

    expect(useSessionStore.getState().samuraiToasts.map((t) => t.label)).toEqual([
      "Successor session never started",
      "Successor spawn was dropped",
      "Brief re-delivery failed",
      "Agent process died silently",
    ]);
  });

  it("non-fatal rows never toast or badge", () => {
    emitAuditEvent({ details: { kind: "submit_retry" } });
    emitAuditEvent({ details: { kind: "ack_timeout" } });
    // A plain delivery_failed re-arms and can still recover on the next
    // SessionStarted — only the exhausted (retype: true) one is fatal.
    emitAuditEvent({ details: { kind: "delivery_failed" } });
    emitAuditEvent({ event: "KILL", details: { phase: "killed", cause: "handoff" } });
    emitAuditEvent({ event: "SPAWN" });

    const state = useSessionStore.getState();
    expect(state.samuraiToasts).toEqual([]);
    expect(state.attentionSessionIds).toEqual([]);
  });

  it("the 0-sentinel session id still toasts but flags nothing", () => {
    emitAuditEvent({ session_id: 0, details: { kind: "successor_no_start" } });

    const state = useSessionStore.getState();
    expect(state.samuraiToasts).toHaveLength(1);
    expect(state.attentionSessionIds).toEqual([]);
  });

  it("a session in another project is not badged, and the badge never duplicates", () => {
    emitAuditEvent({ details: { kind: "submit_unconfirmed" } }, "C:/other");
    expect(useSessionStore.getState().attentionSessionIds).toEqual([]);

    emitAuditEvent({ details: { kind: "submit_unconfirmed" } });
    emitAuditEvent({ details: { kind: "circuit_breaker" } });
    expect(useSessionStore.getState().attentionSessionIds).toEqual([1]);
  });

  it("the attention badge clears the way every attention does — on focus", () => {
    emitAuditEvent({ details: { kind: "circuit_breaker" } });
    expect(useSessionStore.getState().attentionSessionIds).toEqual([1]);

    useSessionStore.getState().clearSessionAttention(1);
    expect(useSessionStore.getState().attentionSessionIds).toEqual([]);
  });

  it("the queue is bounded, oldest dropped first, and dismissable", () => {
    for (let i = 0; i < 8; i++) {
      emitAuditEvent({ generation: i, details: { kind: "circuit_breaker" } });
    }
    let state = useSessionStore.getState();
    expect(state.samuraiToasts).toHaveLength(6);
    expect(state.samuraiToasts[0].generation).toBe(2);

    useSessionStore.getState().dismissSamuraiToast(state.samuraiToasts[0].id);
    state = useSessionStore.getState();
    expect(state.samuraiToasts).toHaveLength(5);

    useSessionStore.getState().dismissAllSamuraiToasts();
    expect(useSessionStore.getState().samuraiToasts).toEqual([]);
  });
});
