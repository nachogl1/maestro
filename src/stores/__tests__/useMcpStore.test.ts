import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deleteCustomMcpServer: vi.fn(),
  getCustomMcpServers: vi.fn(),
  getMcpStatus: vi.fn(),
  getProjectMcpServers: vi.fn(),
  refreshProjectMcpServers: vi.fn(),
  removeMcpServer: vi.fn(),
  saveCustomMcpServer: vi.fn(),
  setMcpServerEnabled: vi.fn(),
  upsertMcpServer: vi.fn(),
}));

// The lib wraps Tauri invoke; mock it before importing the store module.
vi.mock("@/lib/mcp", () => api);

import type { McpCustomServer, McpServerConfig, McpStatusView } from "@/lib/mcp";
import { useMcpStore } from "../useMcpStore";

const P = "/proj";

function server(name: string): McpServerConfig {
  return { name, type: "stdio", command: "node", args: [], env: {} };
}

function custom(id: string, over: Partial<McpCustomServer> = {}): McpCustomServer {
  return {
    id,
    name: id,
    command: "npx",
    args: ["x"],
    env: { K: "V" },
    isEnabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function status(enabled: boolean): McpStatusView {
  return {
    servers: [
      { name: "a", scope: "project", enabled, pending: true, transport: "stdio", config: {} },
      { name: "a", scope: "user", enabled: true, pending: false, transport: "stdio", config: {} },
    ],
    connectors: [{ name: "a", enabled }],
  };
}

const INITIAL = useMcpStore.getState();

describe("useMcpStore", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    useMcpStore.setState(INITIAL, true);
  });

  it("fetchProjectServers stores the servers per project", async () => {
    api.getProjectMcpServers.mockResolvedValue([server("s1")]);

    const result = await useMcpStore.getState().fetchProjectServers(P);

    expect(result.map((s) => s.name)).toEqual(["s1"]);
    const s = useMcpStore.getState();
    expect(s.projectServers[P].map((x) => x.name)).toEqual(["s1"]);
    expect(s.isLoading[P]).toBe(false);
    expect(s.errors[P]).toBeNull();
  });

  it("fetchProjectServers records the error and returns [] on failure", async () => {
    api.getProjectMcpServers.mockRejectedValue("bad json");

    await expect(useMcpStore.getState().fetchProjectServers(P)).resolves.toEqual([]);

    expect(useMcpStore.getState().errors[P]).toBe("bad json");
    expect(useMcpStore.getState().isLoading[P]).toBe(false);
  });

  it("refreshProjectServers replaces the cached servers", async () => {
    useMcpStore.setState({ projectServers: { [P]: [server("old")] } });
    api.refreshProjectMcpServers.mockResolvedValue([server("new")]);

    await useMcpStore.getState().refreshProjectServers(P);

    expect(useMcpStore.getState().projectServers[P].map((x) => x.name)).toEqual(["new"]);
  });

  it("fetchCustomServers loads and marks them loaded; failure leaves state", async () => {
    api.getCustomMcpServers.mockResolvedValueOnce([custom("c1")]).mockRejectedValueOnce("x");

    await useMcpStore.getState().fetchCustomServers();
    expect(useMcpStore.getState().customServers.map((c) => c.id)).toEqual(["c1"]);
    expect(useMcpStore.getState().customServersLoaded).toBe(true);

    await expect(useMcpStore.getState().fetchCustomServers()).resolves.toEqual([]);
    expect(useMcpStore.getState().customServers.map((c) => c.id)).toEqual(["c1"]);
  });

  it("addCustomServer adds optimistically and reverts on failure", async () => {
    api.saveCustomMcpServer.mockResolvedValueOnce(undefined).mockRejectedValueOnce("disk full");

    await useMcpStore.getState().addCustomServer(custom("c1"));
    expect(useMcpStore.getState().customServers.map((c) => c.id)).toEqual(["c1"]);

    await expect(useMcpStore.getState().addCustomServer(custom("c2"))).rejects.toBe("disk full");
    expect(useMcpStore.getState().customServers.map((c) => c.id)).toEqual(["c1"]);
  });

  it("updateCustomServer replaces by id and reverts on failure", async () => {
    useMcpStore.setState({ customServers: [custom("c1", { name: "before" })] });
    api.saveCustomMcpServer.mockResolvedValueOnce(undefined).mockRejectedValueOnce("x");

    await useMcpStore.getState().updateCustomServer(custom("c1", { name: "after" }));
    expect(useMcpStore.getState().customServers[0].name).toBe("after");

    await expect(
      useMcpStore.getState().updateCustomServer(custom("c1", { name: "failed" })),
    ).rejects.toBe("x");
    expect(useMcpStore.getState().customServers[0].name).toBe("after");
  });

  it("deleteCustomServer removes by id and reverts on failure", async () => {
    useMcpStore.setState({ customServers: [custom("c1"), custom("c2")] });
    api.deleteCustomMcpServer.mockResolvedValueOnce(undefined).mockRejectedValueOnce("x");

    await useMcpStore.getState().deleteCustomServer("c1");
    expect(useMcpStore.getState().customServers.map((c) => c.id)).toEqual(["c2"]);

    await expect(useMcpStore.getState().deleteCustomServer("c2")).rejects.toBe("x");
    expect(useMcpStore.getState().customServers.map((c) => c.id)).toEqual(["c2"]);
  });

  it("getAllServers appends only enabled custom servers as stdio configs", () => {
    useMcpStore.setState({
      projectServers: { [P]: [server("discovered")] },
      customServers: [custom("on"), custom("off", { isEnabled: false })],
    });

    const all = useMcpStore.getState().getAllServers(P);

    expect(all).toEqual([
      server("discovered"),
      { name: "on", type: "stdio", command: "npx", args: ["x"], env: { K: "V" } },
    ]);
    expect(
      useMcpStore
        .getState()
        .getAllServers("/other")
        .map((s) => s.name),
    ).toEqual(["on"]);
  });

  it("fetchMcpStatus stores the view, or records the error and returns null", async () => {
    api.getMcpStatus.mockResolvedValueOnce(status(true)).mockRejectedValueOnce("io");

    await useMcpStore.getState().fetchMcpStatus(P);
    expect(useMcpStore.getState().mcpStatus[P]).toEqual(status(true));

    await expect(useMcpStore.getState().fetchMcpStatus(P)).resolves.toBeNull();
    expect(useMcpStore.getState().errors[P]).toBe("io");
  });

  it("upsertManagedServer writes, clears the error and refetches status", async () => {
    useMcpStore.setState({ errors: { [P]: "old" } });
    api.upsertMcpServer.mockResolvedValue(undefined);
    api.getMcpStatus.mockResolvedValue(status(true));

    await useMcpStore.getState().upsertManagedServer(P, "user", "a", { command: "x" }, false);

    expect(api.upsertMcpServer).toHaveBeenCalledWith(P, "user", "a", { command: "x" }, false);
    expect(useMcpStore.getState().errors[P]).toBeNull();
    expect(api.getMcpStatus).toHaveBeenCalledWith(P);
  });

  it("upsertManagedServer and removeManagedServer rethrow but still refetch", async () => {
    api.upsertMcpServer.mockRejectedValue("exists");
    api.removeMcpServer.mockRejectedValue("missing");
    api.getMcpStatus.mockResolvedValue(status(true));

    await expect(
      useMcpStore.getState().upsertManagedServer(P, "user", "a", {}, false),
    ).rejects.toBe("exists");
    expect(useMcpStore.getState().errors[P]).toBe("exists");

    await expect(useMcpStore.getState().removeManagedServer(P, "local", "a")).rejects.toBe(
      "missing",
    );
    expect(useMcpStore.getState().errors[P]).toBe("missing");
    expect(api.getMcpStatus).toHaveBeenCalledTimes(2);
  });

  it("setManagedServerEnabled flips only the matching scope optimistically", async () => {
    useMcpStore.setState({ mcpStatus: { [P]: status(false) } });
    let seen: McpStatusView | undefined;
    api.setMcpServerEnabled.mockImplementation(async () => {
      seen = useMcpStore.getState().mcpStatus[P];
    });
    api.getMcpStatus.mockResolvedValue(status(true));

    await useMcpStore.getState().setManagedServerEnabled(P, "project", "a", true);

    expect(seen?.servers[0]).toMatchObject({ scope: "project", enabled: true, pending: false });
    expect(seen?.servers[1]).toMatchObject({ scope: "user", enabled: true });
    // Connectors only flip for scope "connector".
    expect(seen?.connectors[0].enabled).toBe(false);
    expect(api.setMcpServerEnabled).toHaveBeenCalledWith(P, "project", "a", true);
  });

  it("setManagedServerEnabled surfaces a write failure without throwing", async () => {
    useMcpStore.setState({ mcpStatus: { [P]: status(false) } });
    api.setMcpServerEnabled.mockRejectedValue("read-only");
    api.getMcpStatus.mockResolvedValue(status(false));

    await useMcpStore.getState().setManagedServerEnabled(P, "connector", "a", true);

    expect(useMcpStore.getState().errors[P]).toBe("read-only");
    // The refetch snaps the optimistic toggle back.
    expect(useMcpStore.getState().mcpStatus[P].connectors[0].enabled).toBe(false);
  });
});
