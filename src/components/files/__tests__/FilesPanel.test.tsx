import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The persisted workspace store hydrates through the Tauri store plugin.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

import { useFocusedTerminalStore } from "@/stores/useFocusedTerminalStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { FilesPanel } from "../FilesPanel";
import type { FileEntry } from "../filesApi";

const invokeMock = vi.mocked(invoke);
const writeTextMock = vi.mocked(writeText);

const PROJECT = "C:\\code\\shop";
const WORKTREE = "C:\\git\\shop-wt\\42-checkout-api";

function entry(dir: string, name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return { name, path: `${dir}\\${name}`, isDir: false, ignored: false, ...extra };
}

/** A made-up folder per path: what `files_list_dir` lists there. */
function listingsFor(root: string): Record<string, FileEntry[]> {
  return {
    [root]: [
      entry(root, "node_modules", { isDir: true, ignored: true }),
      entry(root, "src", { isDir: true }),
      entry(root, ".env", { ignored: true }),
      entry(root, "README.md"),
      entry(root, "logo.png"),
    ],
    [`${root}\\src`]: [entry(`${root}\\src`, "main.ts")],
  };
}

const TEXT: Record<string, string> = { "README.md": "# shop\n\nA small demo online shop.\n" };
const CANT: Record<string, string> = { "logo.png": "This is not a text file." };

function session(id: number, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id,
    mode: "Claude",
    name: null,
    branch: null,
    worktree_path: null,
    project_path: PROJECT,
    status: "Idle",
    ...overrides,
  };
}

function tab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "shop",
    projectPath: PROJECT,
    active: true,
    sessionIds: [],
    sessionsLaunched: true,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

/** Folder listings answer at once, except those held back by `hold`. */
const held = new Map<string, (entries: FileEntry[]) => void>();
const hold = new Set<string>();

function mockBackend() {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = args as { root: string; dir?: string; path?: string };
    if (cmd === "files_list_dir") {
      const entries = listingsFor(a.root)[a.dir ?? ""] ?? [];
      if (hold.has(a.dir ?? "")) {
        return new Promise((resolve) => held.set(a.dir ?? "", resolve));
      }
      return entries;
    }
    if (cmd === "files_read_preview") {
      const name = (a.path ?? "").split("\\").pop() ?? "";
      if (name in TEXT) return TEXT[name];
      throw CANT[name] ?? "It no longer exists.";
    }
    return undefined;
  });
}

function focus(sessionId: number) {
  act(() => useFocusedTerminalStore.setState({ focusedSessionId: sessionId }));
}

function row(name: string): HTMLElement {
  return screen.getByRole("treeitem", { name: new RegExp(`^${name.replace(".", "\\.")}`) });
}

function calls(cmd: string) {
  return invokeMock.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

describe("FilesPanel: the focused terminal's folder", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    writeTextMock.mockClear();
    held.clear();
    hold.clear();
    mockBackend();
    useWorkspaceStore.setState({ tabs: [tab()] });
    useSessionStore.setState({
      sessions: [
        session(1, { name: "api", worktree_path: WORKTREE, branch: "feat/42-checkout-api" }),
        session(2, { name: "ui" }),
      ],
    });
    useFocusedTerminalStore.setState({ focusedSessionId: null });
  });
  afterEach(cleanup);

  it("asks for a terminal when none is open or focused", () => {
    render(<FilesPanel />);
    expect(
      screen.getByText("No terminal open. Start or click a terminal to see its folder."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(calls("files_list_dir")).toEqual([]);
  });

  it("shows a worktree terminal's worktree, a project terminal's project, and follows focus", async () => {
    render(<FilesPanel />);
    focus(1);
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("· shop")).toBeInTheDocument();
    expect(screen.getByText("Worktree")).toBeInTheDocument();
    expect(screen.getByTitle(WORKTREE)).toBeInTheDocument();
    expect(calls("files_list_dir")).toEqual([{ root: WORKTREE, dir: WORKTREE }]);

    focus(2);
    await screen.findByTitle(PROJECT);
    expect(screen.getByText("ui")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(calls("files_list_dir")).toContainEqual({ root: PROJECT, dir: PROJECT });

    // The focused terminal closed: back to asking for one.
    act(() => useSessionStore.setState({ sessions: [] }));
    expect(screen.getByText(/No terminal open/)).toBeInTheDocument();
  });

  it("lists a folder each time it is opened, with Loading… the first time", async () => {
    hold.add(`${PROJECT}\\src`);
    render(<FilesPanel />);
    focus(2);
    await screen.findByText("README.md");
    expect(calls("files_list_dir")).toHaveLength(1);

    fireEvent.click(row("src"));
    expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(calls("files_list_dir")).toContainEqual({ root: PROJECT, dir: `${PROJECT}\\src` });

    await act(async () => held.get(`${PROJECT}\\src`)?.(listingsFor(PROJECT)[`${PROJECT}\\src`]));
    expect(screen.getByText("main.ts")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

    fireEvent.click(row("src"));
    expect(screen.queryByText("main.ts")).not.toBeInTheDocument();

    // Reopened after an agent wrote a file: read again, the old entries
    // staying in place (no Loading…) until the new listing arrives.
    fireEvent.click(row("src"));
    expect(calls("files_list_dir")).toHaveLength(3);
    expect(screen.getByText("main.ts")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    const src = `${PROJECT}\\src`;
    await act(async () => held.get(src)?.([...listingsFor(PROJECT)[src], entry(src, "new.ts")]));
    expect(screen.getByText("new.ts")).toBeInTheDocument();
  });

  it("shows hidden and git-ignored entries, the ignored ones dimmed", async () => {
    render(<FilesPanel />);
    focus(2);
    await screen.findByText("README.md");
    for (const [name, dimmed] of [
      ["node_modules", true],
      [".env", true],
      ["src", false],
      ["README.md", false],
    ] as const) {
      const label = within(row(name)).getByText(name);
      expect(label.className.includes("text-maestro-muted"), name).toBe(dimmed);
    }
  });

  it("previews a text file read-only below the tree and closes it", async () => {
    render(<FilesPanel />);
    focus(2);
    fireEvent.click(await screen.findByText("README.md"));
    const preview = await screen.findByRole("region", { name: "File preview" });
    expect(await within(preview).findByText(/A small demo online shop/)).toBeInTheDocument();
    expect(within(preview).getByText("Read-only")).toBeInTheDocument();
    expect(calls("files_read_preview")).toEqual([{ root: PROJECT, path: `${PROJECT}\\README.md` }]);

    fireEvent.click(within(preview).getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("region", { name: "File preview" })).not.toBeInTheDocument();
  });

  it("says Can't preview with the reason and offers to open the file", async () => {
    render(<FilesPanel />);
    focus(2);
    fireEvent.click(await screen.findByText("logo.png"));
    const preview = await screen.findByRole("region", { name: "File preview" });
    expect(await within(preview).findByText("Can't preview")).toBeInTheDocument();
    expect(within(preview).getByText("This is not a text file.")).toBeInTheDocument();

    fireEvent.click(within(preview).getByText("Open in default app"));
    expect(invokeMock).toHaveBeenCalledWith("files_open_default", {
      root: PROJECT,
      path: `${PROJECT}\\logo.png`,
    });
  });

  it("opens a file on double-click and from its hover button, and copies its full path", async () => {
    render(<FilesPanel />);
    focus(2);
    const readme = `${PROJECT}\\README.md`;
    fireEvent.doubleClick(await screen.findByText("README.md"));
    expect(calls("files_open_default")).toEqual([{ root: PROJECT, path: readme }]);

    fireEvent.click(screen.getByRole("button", { name: "Open README.md in default app" }));
    expect(calls("files_open_default")).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy full path of README.md" }));
    });
    expect(writeTextMock).toHaveBeenCalledWith(readme);
    expect(screen.getByText(`Copied ${readme}`)).toBeInTheDocument();

    // A double-click on a hover button is that button's, never the row's open.
    for (const name of ["Copy full path of README.md", "Open README.md in default app"]) {
      await act(async () => {
        fireEvent.doubleClick(screen.getByRole("button", { name }));
      });
    }
    expect(calls("files_open_default")).toHaveLength(2);
  });

  it("offers Preview, Open and Copy on a file's right-click menu, and Copy and Open on a folder's", async () => {
    render(<FilesPanel />);
    focus(2);
    fireEvent.contextMenu(await screen.findByText("README.md"));
    const fileMenu = screen.getByRole("menu");
    expect(
      within(fileMenu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Previewclick", "Open in default appdouble-click", "Copy full path"]);
    fireEvent.click(within(fileMenu).getByRole("menuitem", { name: /^Preview/ }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "File preview" })).toBeInTheDocument();

    fireEvent.contextMenu(row("src"));
    const folderMenu = screen.getByRole("menu");
    expect(
      within(folderMenu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Copy full path", "Open in default app"]);
    await act(async () => {
      fireEvent.click(within(folderMenu).getByRole("menuitem", { name: "Copy full path" }));
    });
    expect(writeTextMock).toHaveBeenCalledWith(`${PROJECT}\\src`);

    fireEvent.contextMenu(row("src"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Open/ }));
    expect(calls("files_open_default")).toEqual([{ root: PROJECT, path: `${PROJECT}\\src` }]);

    fireEvent.contextMenu(row("src"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("copies the folder path from the box", async () => {
    render(<FilesPanel />);
    focus(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy folder path" }));
    });
    expect(writeTextMock).toHaveBeenCalledWith(WORKTREE);
  });
});
