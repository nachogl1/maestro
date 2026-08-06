import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";

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

import { AuditSection } from "../AuditSection";
import type { SamuraiAuditEvent, SamuraiAuditEventPayload } from "@/lib/samurai";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

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
    mockInvoke([
      auditEvent({ event: "SPAWN", generation: 1 }),
      auditEvent({ event: "HANDOFF", generation: 2, details: { kind: "context_threshold" } }),
    ]);
    render(<AuditSection />);

    expect(await screen.findByText("HANDOFF")).toBeInTheDocument();
    const badges = screen
      .getAllByText(/^(SPAWN|HANDOFF)$/)
      .map((el) => el.textContent);
    expect(badges).toEqual(["HANDOFF", "SPAWN"]);
    expect(screen.getByText("gen-2")).toBeInTheDocument();
    expect(screen.getByText("kind=context_threshold")).toBeInTheDocument();
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
