import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { InfraTab } from "../InfraTab";

const invokeMock = vi.mocked(invoke);

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

const OTHER_PATH = "C:\\git\\other-app";

/** Commands issued for `projectPath`, in call order. */
function invokedPaths(cmd: string): string[] {
  return invokeMock.mock.calls
    .filter(([c]) => c === cmd)
    .map(([, args]) => (args as { projectPath: string }).projectPath);
}

describe("InfraTab (one group per open project)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    // Stores write these results straight into arrays, so they must resolve
    // to the right shapes, not undefined.
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "get_mcp_status":
          return { servers: [], connectors: [] };
        case "get_project_plugins":
        case "refresh_project_plugins":
          return { skills: [], plugins: [] };
        default:
          return [];
      }
    });
    useWorkspaceStore.setState({
      tabs: [
        buildTab(),
        buildTab({ id: "tab-2", name: "other-app", projectPath: OTHER_PATH, active: false }),
      ],
    });
  });

  it("names a header button per project and expands only the active one", () => {
    render(<InfraTab />);
    expect(screen.getByRole("button", { name: "maestro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "other-app" })).toBeInTheDocument();
    expect(screen.getAllByText("MCP Servers")).toHaveLength(1);
    expect(screen.getAllByText("Plugins & Skills")).toHaveLength(1);
    expect(screen.getAllByText("Project Context")).toHaveLength(1);
  });

  it("expands a collapsed group on click and collapses the active one", () => {
    render(<InfraTab />);
    fireEvent.click(screen.getByRole("button", { name: "other-app" }));
    expect(screen.getAllByText("MCP Servers")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "maestro" }));
    expect(screen.getAllByText("MCP Servers")).toHaveLength(1);
  });

  it("fetches each expanded project's infra by its own path", async () => {
    render(<InfraTab />);
    fireEvent.click(screen.getByRole("button", { name: "other-app" }));
    await waitFor(() => {
      for (const cmd of ["get_mcp_status", "get_project_plugins", "list_context_docs"]) {
        expect(invokedPaths(cmd), cmd).toEqual(
          expect.arrayContaining(["C:\\git\\maestro", OTHER_PATH]),
        );
      }
    });
  });

  // Two Plugins & Skills sections used to race the same marketplace fetch and
  // re-trigger each other without end; the tab loads it once instead.
  it("loads the marketplace once for the whole tab", async () => {
    render(<InfraTab />);
    fireEvent.click(screen.getByRole("button", { name: "other-app" }));
    await waitFor(() => {
      expect(invokedPaths("get_project_plugins")).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const marketplaceCalls = invokeMock.mock.calls.filter(([c]) => c === "get_marketplace_sources");
    expect(marketplaceCalls).toHaveLength(1);
  });

  it("tells assistive tech whether a group is expanded", () => {
    render(<InfraTab />);
    expect(screen.getByRole("button", { name: "maestro" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "other-app" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  // A collapsed group's choice must not outlive its tab: closing the project
  // and opening it again as the active one starts it expanded, like any
  // other untouched group.
  it("forgets a collapsed group once its project is closed", () => {
    const { rerender } = render(<InfraTab />);
    fireEvent.click(screen.getByRole("button", { name: "maestro" }));
    expect(screen.queryAllByText("MCP Servers")).toHaveLength(0);
    useWorkspaceStore.setState({
      tabs: [buildTab({ id: "tab-2", name: "other-app", projectPath: OTHER_PATH, active: true })],
    });
    rerender(<InfraTab />);
    useWorkspaceStore.setState({
      tabs: [
        buildTab({ id: "tab-2", name: "other-app", projectPath: OTHER_PATH, active: false }),
        buildTab({ id: "tab-3", active: true }),
      ],
    });
    rerender(<InfraTab />);
    expect(screen.getByRole("button", { name: "maestro" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("skips a tab that has no project folder", () => {
    useWorkspaceStore.setState({
      tabs: [buildTab(), buildTab({ id: "tab-9", name: "", projectPath: "", active: false })],
    });
    render(<InfraTab />);
    expect(screen.queryAllByRole("button", { expanded: false })).toHaveLength(0);
    expect(screen.getByRole("button", { name: "maestro" })).toBeInTheDocument();
  });

  it("shows the user-level sections without a header when no project is open", () => {
    useWorkspaceStore.setState({ tabs: [] });
    render(<InfraTab />);
    expect(screen.queryByRole("button", { name: "maestro" })).not.toBeInTheDocument();
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    expect(screen.getByText("Project Context")).toBeInTheDocument();
  });
});
