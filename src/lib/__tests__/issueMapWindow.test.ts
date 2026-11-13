import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import tauriConfig from "../../../src-tauri/tauri.conf.json";
import {
  ISSUE_MAP_OPEN_EVENT,
  ISSUE_MAP_PROJECTS_EVENT,
  ISSUE_MAP_WINDOW_LABEL,
  issueMapProjects,
  issueMapWindowTitle,
  openIssueMapWindow,
  readIssueMapTarget,
  syncIssueMapProjects,
} from "../issueMapWindow";

// The workspace store hydrates through the Tauri store plugin at import time.
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

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => {
  const WebviewWindow = vi.fn(function (this: { once: unknown }) {
    this.once = vi.fn();
  }) as unknown as { getByLabel: unknown };
  WebviewWindow.getByLabel = vi.fn();
  return { WebviewWindow };
});

const getByLabel = WebviewWindow.getByLabel as unknown as ReturnType<typeof vi.fn>;

describe("readIssueMapTarget", () => {
  it("reads the repo and search of the map window", () => {
    const query = "?view=issue-map&repo=C%3A%5Cgit%5Cmaestro&search=assignee%3A%40me";
    expect(readIssueMapTarget(query)).toEqual({
      repoPath: "C:\\git\\maestro",
      search: "assignee:@me",
    });
  });

  it("reads the open projects and ignores a malformed list", () => {
    const projects = [{ name: "maestro", repoPath: "/repos/maestro" }];
    const query = new URLSearchParams({
      view: "issue-map",
      repo: "/repos/maestro",
      projects: JSON.stringify([...projects, { name: 3 }]),
    });
    expect(readIssueMapTarget(`?${query}`)?.projects).toEqual(projects);
    expect(readIssueMapTarget("?view=issue-map&projects=%7Bbad")?.projects).toBeUndefined();
  });

  it("returns null for the main window", () => {
    expect(readIssueMapTarget("")).toBeNull();
    expect(readIssueMapTarget("?view=other")).toBeNull();
  });
});

describe("issueMapWindowTitle", () => {
  it("names the project folder on Windows and Unix paths", () => {
    expect(issueMapWindowTitle("C:\\git\\maestro")).toBe("Maestro: Issue map - maestro");
    expect(issueMapWindowTitle("/repos/a b/")).toBe("Maestro: Issue map - a b");
  });

  it("falls back to a plain title without a repo", () => {
    expect(issueMapWindowTitle("")).toBe("Maestro: Issue map");
  });
});

describe("openIssueMapWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a separate window whose URL carries the repo and search", async () => {
    getByLabel.mockResolvedValue(null);
    await openIssueMapWindow({ repoPath: "/repos/a b", search: "is:open" });

    expect(WebviewWindow).toHaveBeenCalledTimes(1);
    const [label, options] = vi.mocked(WebviewWindow).mock.calls[0];
    expect(label).toBe(ISSUE_MAP_WINDOW_LABEL);
    const query = (options?.url ?? "").split("?")[1];
    expect(readIssueMapTarget(`?${query}`)).toEqual({ repoPath: "/repos/a b", search: "is:open" });
    expect(options?.title).toBe("Maestro: Issue map - a b");
  });

  it("opens with the main window's WebView2 options, or WebView2 refuses the window", async () => {
    getByLabel.mockResolvedValue(null);
    await openIssueMapWindow({ repoPath: "/repos/a", search: "" });

    const options = vi.mocked(WebviewWindow).mock.calls[0][1];
    const mainArgs = tauriConfig.app.windows[0].additionalBrowserArgs;
    expect(mainArgs).toContain("--disable-features=");
    expect(options).toHaveProperty("additionalBrowserArgs", mainArgs);
  });

  it("carries the open projects in the window URL", async () => {
    getByLabel.mockResolvedValue(null);
    const projects = [{ name: "b", repoPath: "/repos/b" }];
    await openIssueMapWindow({ repoPath: "/repos/a", search: "", projects });

    const options = vi.mocked(WebviewWindow).mock.calls[0][1];
    const query = (options?.url ?? "").split("?")[1];
    expect(readIssueMapTarget(`?${query}`)?.projects).toEqual(projects);
  });

  it("points an already open window at the repo and brings it forward", async () => {
    const existing = {
      unminimize: vi.fn(() => Promise.resolve()),
      setFocus: vi.fn(() => Promise.resolve()),
    };
    getByLabel.mockResolvedValue(existing);
    const target = { repoPath: "/repos/b", search: "" };
    await openIssueMapWindow(target);

    expect(WebviewWindow).not.toHaveBeenCalled();
    expect(emitTo).toHaveBeenCalledWith(ISSUE_MAP_WINDOW_LABEL, ISSUE_MAP_OPEN_EVENT, target);
    expect(existing.unminimize).toHaveBeenCalled();
    expect(existing.setFocus).toHaveBeenCalled();
  });
});

function buildTab(overrides: Partial<WorkspaceTab> & { name: string }): WorkspaceTab {
  return {
    id: overrides.name,
    projectPath: `/repos/${overrides.name}`,
    active: false,
    sessionIds: [],
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

function repo(path: string, isGitRepo = true): WorkspaceTab["repositories"][number] {
  const name = path.split("/").pop() ?? path;
  return { path, name, isGitRepo, currentBranch: null, remoteUrl: null };
}

describe("issueMapProjects", () => {
  it("lists each git repository of a multi-repository tab, not only the selected one", () => {
    const tab = buildTab({
      name: "suite",
      projectPath: "/repos/suite",
      workspaceType: "multi-repo",
      repositories: [
        repo("/repos/suite", false),
        repo("/repos/suite/api"),
        repo("/repos/suite/web"),
      ],
      selectedRepoPath: "/repos/suite/api",
    });
    expect(issueMapProjects([tab])).toEqual([
      { name: "suite / api", repoPath: "/repos/suite/api" },
      { name: "suite / web", repoPath: "/repos/suite/web" },
    ]);
  });

  it("names a multi-repository root that is itself a repository after the tab", () => {
    const tab = buildTab({
      name: "mono",
      workspaceType: "multi-repo",
      repositories: [repo("/repos/mono"), repo("/repos/mono/tools")],
    });
    expect(issueMapProjects([tab]).map((p) => p.name)).toEqual(["mono", "mono / tools"]);
  });

  it("keeps single-repository tabs and tabs marked 'not git', in tab order", () => {
    const tabs = [
      buildTab({ name: "alpha" }),
      buildTab({ name: "beta", workspaceType: "non-git" }),
      buildTab({ name: "gamma", workspaceType: "multi-repo", repositories: [repo("/x", false)] }),
    ];
    expect(issueMapProjects(tabs)).toEqual([
      { name: "alpha", repoPath: "/repos/alpha" },
      { name: "beta", repoPath: "/repos/beta" },
      { name: "gamma", repoPath: "/repos/gamma" },
    ]);
  });
});

describe("syncIssueMapProjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({ tabs: [buildTab({ name: "alpha" })] });
  });

  it("sends the new project list to the map window when a tab opens or closes", () => {
    const stop = syncIssueMapProjects();
    const beta = buildTab({ name: "beta" });
    useWorkspaceStore.setState({ tabs: [buildTab({ name: "alpha" }), beta] });
    useWorkspaceStore.setState({ tabs: [beta] });
    stop();
    useWorkspaceStore.setState({ tabs: [] });

    expect(vi.mocked(emitTo).mock.calls).toEqual([
      [
        ISSUE_MAP_WINDOW_LABEL,
        ISSUE_MAP_PROJECTS_EVENT,
        [
          { name: "alpha", repoPath: "/repos/alpha" },
          { name: "beta", repoPath: "/repos/beta" },
        ],
      ],
      [
        ISSUE_MAP_WINDOW_LABEL,
        ISSUE_MAP_PROJECTS_EVENT,
        [{ name: "beta", repoPath: "/repos/beta" }],
      ],
    ]);
  });

  it("sends nothing when a tab changes without changing the project list", () => {
    const stop = syncIssueMapProjects();
    useWorkspaceStore.setState({
      tabs: [buildTab({ name: "alpha", active: true, sessionIds: [7] })],
    });
    stop();
    expect(emitTo).not.toHaveBeenCalled();
  });
});
