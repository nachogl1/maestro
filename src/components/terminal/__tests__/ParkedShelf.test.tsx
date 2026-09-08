import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The session store subscribes to Tauri events at listener-init time; the
// global setup already mocks @tauri-apps/api/core, event needs its own stub.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import {
  type BackendSessionStatus,
  type SessionConfig,
  useSessionStore,
} from "@/stores/useSessionStore";
import { ParkedShelf } from "../ParkedShelf";

function session(
  id: number,
  projectPath: string,
  name: string | null = null,
  status: BackendSessionStatus = "Working",
): SessionConfig {
  return {
    id,
    mode: "Claude",
    name,
    branch: null,
    status,
    worktree_path: null,
    project_path: projectPath,
  };
}

describe("ParkedShelf", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      samuraiBySessionId: {},
      samuraiParkAlerts: [],
      runFatalSessionIds: [],
    });
  });

  it("renders nothing when no session is parked", () => {
    useSessionStore.setState({ sessions: [session(1, "C:/proj")] });

    const { container } = render(<ParkedShelf onUnpark={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders a chip per parked session and calls onUnpark on click", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:/proj", "My Agent"), session(2, "C:/proj")],
      parkedSessionIds: [1],
    });
    const onUnpark = vi.fn();

    render(<ParkedShelf onUnpark={onUnpark} />);

    expect(screen.getByText("Parked")).toBeInTheDocument();
    expect(screen.queryByText("Session #2")).not.toBeInTheDocument();
    const chip = screen.getByText("My Agent");
    fireEvent.click(chip);
    expect(onUnpark).toHaveBeenCalledWith(1);
  });

  it("falls back to a Session #id label when the session has no name", () => {
    useSessionStore.setState({
      sessions: [session(3, "C:/proj")],
      parkedSessionIds: [3],
    });

    render(<ParkedShelf onUnpark={vi.fn()} />);

    expect(screen.getByText("Session #3")).toBeInTheDocument();
  });

  it("filters chips to the given projectPath", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:\\git\\alpha", "Alpha"), session(2, "C:\\git\\beta", "Beta")],
      parkedSessionIds: [1, 2],
    });

    render(<ParkedShelf projectPath="C:/git/alpha" onUnpark={vi.fn()} />);

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("shows project labels when showProjectLabels is set", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:\\git\\alpha", "Agent")],
      parkedSessionIds: [1],
    });

    render(<ParkedShelf showProjectLabels onUnpark={vi.fn()} />);

    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("pulses a chip and tints the shelf when a parked agent needs input", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:/proj", "Waiting", "NeedsInput"), session(2, "C:/proj", "Busy")],
      parkedSessionIds: [1, 2],
    });

    render(<ParkedShelf onUnpark={vi.fn()} />);

    const waitingChip = screen.getByText("Waiting").closest("button");
    const busyChip = screen.getByText("Busy").closest("button");
    expect(waitingChip?.className).toContain("parked-chip-attention");
    expect(busyChip?.className).not.toContain("parked-chip-attention");
    expect(screen.getByText("Parked").className).toContain("text-maestro-accent");
  });

  /**
   * Issue #174 regression: a run-fatal park (circuit breaker, unconfirmed
   * handoff, ...) used to look exactly like any other parked terminal — the
   * only warning was an ephemeral toast. `runFatalSessionIds` is what
   * survives `parkSession`'s attention wipe (see useSessionStore.ts); the
   * shelf must actually render it.
   */
  it("marks a run-fatal parked chip with the existing attention treatment", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:/proj", "Dead-run", "Working"), session(2, "C:/proj", "Busy")],
      parkedSessionIds: [1, 2],
      runFatalSessionIds: [1],
    });

    render(<ParkedShelf onUnpark={vi.fn()} />);

    const deadChip = screen.getByText("Dead-run").closest("button");
    const busyChip = screen.getByText("Busy").closest("button");
    expect(deadChip?.className).toContain("parked-chip-attention");
    expect(deadChip?.getAttribute("title")).toBe("Samurai run died — restore terminal");
    expect(busyChip?.className).not.toContain("parked-chip-attention");
    expect(screen.getByText("Parked").className).toContain("text-maestro-accent");
  });

  it("does not mark an ordinary parked chip just because it once had attention", () => {
    // Only the run-fatal marker earns the treatment — an id merely present
    // in the general attention set (e.g. a stale auto-unpark highlight)
    // must not leak into the shelf.
    useSessionStore.setState({
      sessions: [session(1, "C:/proj", "Plain", "Working")],
      parkedSessionIds: [1],
      runFatalSessionIds: [],
    });

    render(<ParkedShelf onUnpark={vi.fn()} />);

    expect(screen.getByText("Plain").closest("button")?.className).not.toContain(
      "parked-chip-attention",
    );
  });

  it("keeps the shelf neutral while parked agents are only working", () => {
    useSessionStore.setState({
      sessions: [session(1, "C:/proj", "Busy")],
      parkedSessionIds: [1],
    });

    render(<ParkedShelf onUnpark={vi.fn()} />);

    expect(screen.getByText("Parked").className).toContain("text-maestro-muted");
  });

  describe("allowance-parked Samurai runs", () => {
    function parkTheRun(sessionId: number, projectPath = "C:/proj") {
      useSessionStore.setState({
        samuraiBySessionId: {
          [sessionId]: { project: projectPath, epic: "#37", generation: 2, state: "PARKED" },
        },
        samuraiParkAlerts: [
          {
            key: `${projectPath}|#37|2026-08-13T09:05:00+00:00`,
            project: projectPath,
            epic: "#37",
            fireAt: "2026-08-13T09:05:00+00:00",
            acknowledged: false,
          },
        ],
      });
    }

    it("shines the chip and tints the shelf until the run is restored", () => {
      useSessionStore.setState({
        sessions: [session(1, "C:/proj", "Samurai-1"), session(2, "C:/proj", "Busy")],
        parkedSessionIds: [1, 2],
      });
      parkTheRun(1);
      const onUnpark = vi.fn();

      render(<ParkedShelf onUnpark={onUnpark} />);

      const chip = screen.getByText("Samurai-1").closest("button");
      expect(chip?.className).toContain("samurai-park-shine");
      expect(chip?.getAttribute("title")).toContain("Parked on token allowance");
      expect(screen.getByText("Busy").closest("button")?.className).not.toContain(
        "samurai-park-shine",
      );
      expect(screen.getByText("Parked").className).toContain("text-maestro-accent");

      // Restoring the run IS the acknowledgement — the shine has done its job.
      if (chip) fireEvent.click(chip);
      expect(onUnpark).toHaveBeenCalledWith(1);
      expect(useSessionStore.getState().samuraiParkAlerts[0].acknowledged).toBe(true);
      expect(screen.getByText("Samurai-1").closest("button")?.className).not.toContain(
        "samurai-park-shine",
      );
    });

    it("does not shine a supervised session that is not parked", () => {
      useSessionStore.setState({
        sessions: [session(1, "C:/proj", "Samurai-1")],
        parkedSessionIds: [1],
      });
      parkTheRun(1);
      useSessionStore.setState({
        samuraiBySessionId: {
          1: { project: "C:/proj", epic: "#37", generation: 2, state: "WORKING" },
        },
      });

      render(<ParkedShelf onUnpark={vi.fn()} />);

      expect(screen.getByText("Samurai-1").closest("button")?.className).not.toContain(
        "samurai-park-shine",
      );
    });

    it("does not shine when the park belongs to another project", () => {
      useSessionStore.setState({
        sessions: [session(1, "C:/proj", "Samurai-1")],
        parkedSessionIds: [1],
      });
      parkTheRun(1, "C:/other");
      useSessionStore.setState({
        samuraiBySessionId: {
          1: { project: "C:/proj", epic: "#37", generation: 2, state: "PARKED" },
        },
      });

      render(<ParkedShelf onUnpark={vi.fn()} />);

      expect(screen.getByText("Samurai-1").closest("button")?.className).not.toContain(
        "samurai-park-shine",
      );
    });
  });
});
