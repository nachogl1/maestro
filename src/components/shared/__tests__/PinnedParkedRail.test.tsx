import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

// The session store subscribes to Tauri events at listener-init time.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import type { ParkedPin } from "@/lib/parkedPins";
import {
  type SamuraiParkAlert,
  type SessionConfig,
  useSessionStore,
} from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { PinnedParkedRail, resolvePins } from "../PinnedParkedRail";

function session(id: number, projectPath: string, name: string | null = null): SessionConfig {
  return {
    id,
    mode: "Claude",
    name,
    branch: null,
    status: "Working",
    worktree_path: null,
    project_path: projectPath,
  };
}

function alert(project: string, epic: string, acknowledged = false): SamuraiParkAlert {
  return {
    key: `${project}|${epic}|2099-01-01T00:00:00+00:00`,
    project,
    epic,
    fireAt: "2099-01-01T00:00:00+00:00",
    acknowledged,
  };
}

const terminalPin: ParkedPin = { kind: "terminal", project: "C:\\git\\alpha", label: "Scout" };
const samuraiPin: ParkedPin = { kind: "samurai", project: "C:\\git\\alpha", label: "#37" };

describe("resolvePins", () => {
  it("resolves a terminal pin after the session id was reassigned", () => {
    // Same project, same terminal name, brand-new id — the shape of every
    // app restart. A pin keyed on the id would resolve to nothing (or worse,
    // to whichever terminal inherited the number).
    const resolved = resolvePins([terminalPin], [session(912, "C:/git/alpha", "Scout")], []);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].kind).toBe("terminal");
  });

  it("does not resolve a terminal pin to a same-named terminal in another project", () => {
    expect(resolvePins([terminalPin], [session(1, "C:/git/beta", "Scout")], [])).toEqual([]);
  });

  it("resolves a Samurai pin whose epic is punctuated differently", () => {
    // Pin and alert are the same epic written by two producers; `epicSlug`
    // is what lets casing and punctuation differ without breaking the pin.
    const pin: ParkedPin = { kind: "samurai", project: "C:/git/alpha", label: "Epic #37" };
    const resolved = resolvePins([pin], [], [alert("C:/git/alpha", "epic-37")]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].kind).toBe("samurai");
  });

  it("drops a pin with nothing parked to resolve to, keeping the rest", () => {
    const resolved = resolvePins([terminalPin, samuraiPin], [], [alert("C:/git/alpha", "#37")]);

    expect(resolved.map((r) => r.kind)).toEqual(["samurai"]);
  });

  it("preserves pin order", () => {
    const resolved = resolvePins(
      [samuraiPin, terminalPin],
      [session(1, "C:/git/alpha", "Scout")],
      [alert("C:/git/alpha", "#37")],
    );

    expect(resolved.map((r) => r.kind)).toEqual(["samurai", "terminal"]);
  });
});

describe("PinnedParkedRail", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [],
      parkedSessionIds: [],
      samuraiBySessionId: {},
      samuraiParkAlerts: [],
    });
    useWorkspaceStore.setState({ tabs: [], pinnedParked: [], zoomTabOrders: {} });
  });

  it("renders nothing when nothing is pinned", () => {
    const { container } = render(<PinnedParkedRail onNavigate={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when a pin has no live parked item", () => {
    useWorkspaceStore.setState({ pinnedParked: [terminalPin] });
    useSessionStore.setState({ sessions: [session(1, "C:/git/alpha", "Scout")] });

    const { container } = render(<PinnedParkedRail onNavigate={vi.fn()} />);

    expect(container.firstChild).toBeNull();
  });

  it("restores and navigates to a pinned parked terminal", () => {
    useWorkspaceStore.setState({ pinnedParked: [terminalPin] });
    useSessionStore.setState({
      sessions: [session(7, "C:/git/alpha", "Scout")],
      parkedSessionIds: [7],
    });
    const onNavigate = vi.fn();

    render(<PinnedParkedRail onNavigate={onNavigate} />);

    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Scout"));
    expect(onNavigate).toHaveBeenCalledWith("C:/git/alpha", 7);
  });

  it("shows a dated countdown for a pinned Samurai park and navigates to its project", () => {
    useWorkspaceStore.setState({ pinnedParked: [samuraiPin] });
    useSessionStore.setState({ samuraiParkAlerts: [alert("C:/git/alpha", "#37")] });
    const onNavigate = vi.fn();

    render(<PinnedParkedRail onNavigate={onNavigate} />);

    // Never a bare HH:MM — the countdown comes from lib/parkTime.
    expect(screen.getByText(/^in \d+d \d+h \d+m$/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("#37"));
    expect(onNavigate).toHaveBeenCalledWith("C:/git/alpha");
    expect(useSessionStore.getState().samuraiParkAlerts[0].acknowledged).toBe(true);
  });

  it("wears the shared park shine until the park is acknowledged", () => {
    useWorkspaceStore.setState({ pinnedParked: [samuraiPin] });
    useSessionStore.setState({ samuraiParkAlerts: [alert("C:/git/alpha", "#37")] });

    const { rerender } = render(<PinnedParkedRail onNavigate={vi.fn()} />);
    expect(screen.getByText("#37").closest("button")?.className).toContain("samurai-park-shine");

    useSessionStore.setState({ samuraiParkAlerts: [alert("C:/git/alpha", "#37", true)] });
    rerender(<PinnedParkedRail onNavigate={vi.fn()} />);
    expect(screen.getByText("#37").closest("button")?.className).not.toContain(
      "samurai-park-shine",
    );
  });

  it("unpins from the rail itself", () => {
    useWorkspaceStore.setState({ pinnedParked: [terminalPin] });
    useSessionStore.setState({
      sessions: [session(7, "C:/git/alpha", "Scout")],
      parkedSessionIds: [7],
    });

    render(<PinnedParkedRail onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Unpin Scout"));

    expect(useWorkspaceStore.getState().pinnedParked).toEqual([]);
  });
});
