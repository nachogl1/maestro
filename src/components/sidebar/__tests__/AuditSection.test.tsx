import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

import type { SamuraiAuditEvent, SamuraiAuditEventPayload } from "@/lib/samurai";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { AuditSection } from "../AuditSection";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const askMock = vi.mocked(ask);

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

function auditEvent(overrides: Partial<SamuraiAuditEvent> = {}): SamuraiAuditEvent {
  return {
    ts: new Date().toISOString(),
    epic: "#36",
    event: "SPAWN",
    generation: 1,
    session_id: 1,
    details: { kind: "registered" },
    ...overrides,
  };
}

/** Captured `samurai-audit-event` handler, so tests can stream rows in. */
let emitAuditEvent: (payload: SamuraiAuditEventPayload) => void;

function mockInvoke(events: SamuraiAuditEvent[] = [], fileSize = 0) {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "samurai_audit_read":
        return { events, file_size_bytes: fileSize };
      case "samurai_audit_clear":
        return undefined;
      default:
        return undefined;
    }
  });
}

describe("AuditSection (issue #46)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
      if (event === "samurai-audit-event") {
        emitAuditEvent = (payload) => handler({ payload });
      }
      return Promise.resolve(() => {});
    }) as typeof listen);
    useWorkspaceStore.setState({ tabs: [buildTab()] });
  });

  it("lists the active project's audit rows newest-first", async () => {
    // Backend returns oldest-first; the view must flip to newest-first.
    // The HANDOFF row's shape (`kind`, no `phase`) isn't one describeAuditEvent
    // recognizes, so it falls back to the raw key=value summary.
    mockInvoke([
      auditEvent({ event: "SPAWN", generation: 1 }),
      auditEvent({ event: "HANDOFF", generation: 2, details: { kind: "context_threshold" } }),
    ]);
    render(<AuditSection />);

    expect(await screen.findByText("HANDOFF")).toBeInTheDocument();
    const badges = screen.getAllByText(/^(SPAWN|HANDOFF)$/).map((el) => el.textContent);
    expect(badges).toEqual(["HANDOFF", "SPAWN"]);
    expect(screen.getByText("gen-2")).toBeInTheDocument();
    expect(screen.getByText("kind=context_threshold")).toBeInTheDocument();
  });

  it("renders a plain-language sentence for a known event shape (issue #123)", async () => {
    // The exact example from issue #123: a soft 5h allowance threshold.
    mockInvoke([
      auditEvent({
        event: "ALERT",
        generation: 0,
        details: {
          kind: "allowance_threshold",
          window: "5h",
          threshold_kind: "soft",
          value: 78,
          threshold: 75,
          resets_at: "2026-08-06T01:20:00Z",
        },
      }),
    ]);
    render(<AuditSection />);

    expect(
      await screen.findByText("5h usage hit 78% — soft wind-down threshold; resets 01:20 UTC"),
    ).toBeInTheDocument();
  });

  it("falls back to the raw summary for an unrecognized ALERT sub-kind", async () => {
    mockInvoke([
      auditEvent({
        event: "ALERT",
        generation: 0,
        details: { kind: "some_future_alert_kind", extra: "value" },
      }),
    ]);
    render(<AuditSection />);

    expect(await screen.findByText("kind=some_future_alert_kind extra=value")).toBeInTheDocument();
  });

  it("clusters events by run, newest run first (issue #123)", async () => {
    mockInvoke([
      // Oldest-first from the backend, interleaved across two runs plus one
      // account-wide (no-epic) row.
      auditEvent({ event: "SPAWN", epic: "#36", generation: 1, ts: "2026-08-06T10:00:00Z" }),
      auditEvent({
        event: "ALERT",
        epic: "",
        generation: 0,
        session_id: 0,
        ts: "2026-08-06T10:05:00Z",
        details: { kind: "allowance_serialize_error" },
      }),
      auditEvent({ event: "SPAWN", epic: "#40", generation: 1, ts: "2026-08-06T11:00:00Z" }),
      auditEvent({
        event: "HANDOFF",
        epic: "#36",
        generation: 1,
        ts: "2026-08-06T12:00:00Z",
        details: { phase: "requested", from: "WORKING" },
      }),
    ]);
    render(<AuditSection />);
    // Two SPAWN rows in this fixture, so wait on a row that renders once.
    await screen.findByText(/Handoff requested/);

    // Newest run first: #36's newest row (12:00) beats #40's (11:00), which
    // beats the account-wide row (10:05).
    const headers = screen.getAllByText(/^(#36|#40|Account-wide)$/).map((el) => el.textContent);
    expect(headers).toEqual(["#36", "#40", "Account-wide"]);

    // #36's two rows land under its own header, newest first.
    expect(screen.getByText(/Handoff requested/)).toBeInTheDocument();
    expect(screen.getAllByText("SPAWN")).toHaveLength(2);
  });

  it("scrolls the event list in a bounded box instead of growing forever", async () => {
    mockInvoke([auditEvent()]);
    const { container } = render(<AuditSection />);
    await screen.findByText("SPAWN");

    const list = container.querySelector('[data-testid="audit-events"]');
    expect(list).not.toBeNull();
    expect(list?.className).toMatch(/overflow-y-auto/);
    expect(list?.className).toMatch(/max-h-/);
  });

  it("shows the empty state when the log has no rows", async () => {
    mockInvoke([]);
    render(<AuditSection />);

    expect(await screen.findByText("No audit events for this project.")).toBeInTheDocument();
  });

  it("live-appends streamed rows for this project and skips other projects", async () => {
    mockInvoke([auditEvent({ event: "SPAWN" })]);
    render(<AuditSection />);
    expect(await screen.findByText("SPAWN")).toBeInTheDocument();

    act(() => {
      emitAuditEvent({
        project: "C:\\git\\maestro",
        event: auditEvent({
          event: "ALERT",
          generation: 0,
          details: { kind: "allowance_threshold" },
        }),
      });
      emitAuditEvent({
        project: "C:\\git\\other",
        event: auditEvent({ event: "PARK" }),
      });
    });

    expect(await screen.findByText("ALERT")).toBeInTheDocument();
    expect(screen.queryByText("PARK")).toBeNull();
    // Newest first: the streamed ALERT lands above the read SPAWN.
    const badges = screen.getAllByText(/^(SPAWN|ALERT)$/).map((el) => el.textContent);
    expect(badges).toEqual(["ALERT", "SPAWN"]);
  });

  it("expands a row into replay details and collapses it again (issue #101)", async () => {
    const excerpt = "Your context window is nearly full. Write the handoff file for epic #36 …";
    mockInvoke([
      auditEvent({
        event: "INJECT",
        generation: 3,
        session_id: 7,
        details: {
          phase: "delivered",
          instruction: "handoff",
          attempt: 1,
          corrective: false,
          gate: "stop_hook",
          excerpt,
          total_chars: 1234,
        },
      }),
    ]);
    render(<AuditSection />);
    expect(await screen.findByText("INJECT")).toBeInTheDocument();
    // Collapsed: a plain-language sentence, never the raw scalars or the
    // excerpt block.
    expect(screen.getByText("Instruction delivered — handoff")).toBeInTheDocument();
    expect(screen.queryByText(excerpt)).toBeNull();

    // Expand: the replay details appear — gate, attempt, and the excerpt
    // with its "first N of M chars" note.
    fireEvent.click(screen.getByText("INJECT"));
    expect(screen.getByText(excerpt)).toBeInTheDocument();
    expect(screen.getByText("gate")).toBeInTheDocument();
    expect(screen.getByText("stop_hook")).toBeInTheDocument();
    expect(screen.getByText("attempt")).toBeInTheDocument();
    expect(
      screen.getByText(`instruction excerpt (first ${[...excerpt].length} of 1234 chars)`),
    ).toBeInTheDocument();
    expect(screen.getByText(/session 7/)).toBeInTheDocument();

    // Collapse: the details disappear again.
    fireEvent.click(screen.getByText("INJECT"));
    expect(screen.queryByText(excerpt)).toBeNull();
  });

  it("renders and expands old-shape rows without the new fields", async () => {
    // Rows written before issue #101: plain details, null details — both
    // must render fine and expand without crashing (fields are optional).
    mockInvoke([
      auditEvent({ event: "HANDOFF", generation: 2, details: { phase: "requested" } }),
      auditEvent({ event: "ALERT", generation: 0, details: null }),
    ]);
    render(<AuditSection />);
    expect(await screen.findByText("HANDOFF")).toBeInTheDocument();
    expect(screen.getByText("Handoff requested")).toBeInTheDocument();

    fireEvent.click(screen.getByText("HANDOFF"));
    expect(screen.getByText("phase")).toBeInTheDocument();
    expect(screen.getByText("requested")).toBeInTheDocument();
    expect(screen.queryByText(/instruction excerpt/)).toBeNull();

    fireEvent.click(screen.getByText("ALERT"));
    // Null details: only the identity line shows.
    expect(screen.getByText(/gen-0 · session 1/)).toBeInTheDocument();
  });

  it("clears the log only after the user confirms", async () => {
    mockInvoke([auditEvent()], 2048);
    askMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<AuditSection />);
    expect(await screen.findByText("SPAWN")).toBeInTheDocument();

    // First click: declined — nothing deleted.
    fireEvent.click(screen.getByRole("button", { name: "Clear audit log" }));
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_audit_clear", expect.anything());
    expect(screen.getByText("SPAWN")).toBeInTheDocument();

    // Second click: confirmed — cleared and emptied.
    fireEvent.click(screen.getByRole("button", { name: "Clear audit log" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_audit_clear", {
        projectPath: "C:\\git\\maestro",
      }),
    );
    expect(await screen.findByText("No audit events for this project.")).toBeInTheDocument();
  });
});
