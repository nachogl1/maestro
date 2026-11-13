import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@/lib/terminal", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { useScratchStore } from "@/stores/useScratchStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { ScratchSection } from "../ScratchSection";

const mockInvoke = vi.mocked(invoke);
const FOLDER = "/home/someone/Maestro Scratch";
const HOUR_MS = 3_600_000;

let projects = [
  { name: "older", path: `${FOLDER}/older`, createdAtMs: Date.now() - 2 * 24 * HOUR_MS },
  { name: "newer", path: `${FOLDER}/newer`, createdAtMs: Date.now() - 3 * HOUR_MS },
];

function calls(command: string) {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === command);
}

describe("ScratchSection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 13, 18, 22));
    projects = [
      { name: "older", path: `${FOLDER}/older`, createdAtMs: Date.now() - 2 * 24 * HOUR_MS },
      { name: "newer", path: `${FOLDER}/newer`, createdAtMs: Date.now() - 3 * HOUR_MS },
    ];
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === "scratch_list") return { folder: FOLDER, projects };
      if (cmd === "scratch_create") {
        const { name } = args as { name: string };
        if (name === "taken") throw 'A scratch project named "taken" already exists.';
        if (name.includes("/"))
          throw "A name can't contain < > : \" / \\ | ? * or control characters.";
        return `${FOLDER}/${name}`;
      }
      if (cmd === "scratch_delete") {
        const { path } = args as { path: string };
        projects = projects.filter((p) => p.path !== path);
        return undefined;
      }
      if (cmd === "remove_sessions_for_project") return [];
      return undefined;
    });
    useScratchStore.setState({ folderSetting: null, folder: FOLDER, projects: [], error: null });
    useWorkspaceStore.setState({ tabs: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("New scratch project offers a dated default and Enter makes and opens it", async () => {
    const onOpen = vi.fn();
    render(<ScratchSection onOpen={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: "New scratch project" }));
    const box = screen.getByRole("textbox", { name: "Scratch project name" });
    expect(box).toHaveValue("scratch-13-nov-1822");

    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${FOLDER}/scratch-13-nov-1822`));
    expect(calls("scratch_create")).toEqual([
      ["scratch_create", { folder: null, name: "scratch-13-nov-1822" }],
    ]);
  });

  it("a refused name shows its reason in the box and opens nothing", async () => {
    const onOpen = vi.fn();
    render(<ScratchSection onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "New scratch project" }));
    const box = screen.getByRole("textbox", { name: "Scratch project name" });

    for (const [name, reason] of [
      ["taken", 'A scratch project named "taken" already exists.'],
      ["a/b", "A name can't contain"],
    ]) {
      fireEvent.change(box, { target: { value: name } });
      fireEvent.keyDown(box, { key: "Enter" });
      expect((await screen.findByRole("alert")).textContent).toContain(reason);
    }
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Scratch project name" })).toBeTruthy();
  });

  it("Escape in the name box goes back to the row without making anything", async () => {
    render(<ScratchSection onOpen={vi.fn()} />);
    await screen.findByRole("button", { name: "Scratch projects (2)" });
    fireEvent.click(screen.getByRole("button", { name: "New scratch project" }));

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Scratch project name" }), {
      key: "Escape",
    });

    expect(screen.queryByRole("textbox", { name: "Scratch project name" })).toBeNull();
    expect(calls("scratch_create")).toHaveLength(0);
  });

  it("the pill counts the scratch projects and lists each with its age", async () => {
    render(<ScratchSection onOpen={vi.fn()} />);

    const pill = await screen.findByRole("button", { name: "Scratch projects (2)" });
    fireEvent.click(pill);

    const list = screen.getByRole("list", { name: "Scratch projects list" });
    expect(list.textContent).toContain("older");
    expect(list.textContent).toContain("2 d");
    expect(list.textContent).toContain("newer");
    expect(list.textContent).toContain("3 h");
  });

  it("clicking a row adds a terminal to that scratch project", async () => {
    const onOpen = vi.fn();
    render(<ScratchSection onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole("button", { name: "Scratch projects (2)" }));

    fireEvent.click(screen.getByRole("button", { name: /^newer/ }));

    expect(onOpen).toHaveBeenCalledWith(`${FOLDER}/newer`);
  });

  it("the bin deletes after Yes, and No keeps the project", async () => {
    render(<ScratchSection onOpen={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Scratch projects (2)" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete scratch project older" }));
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(calls("scratch_delete")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete scratch project older" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    });

    expect(calls("scratch_delete")).toEqual([
      ["scratch_delete", { folder: null, path: `${FOLDER}/older` }],
    ]);
    expect(await screen.findByRole("button", { name: "Scratch projects (1)" })).toBeTruthy();
  });

  it("deleting an open scratch project closes its tab first", async () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "t1",
          name: "older",
          projectPath: `${FOLDER}/older`,
          active: true,
          sessionIds: [7],
          sessionsLaunched: true,
          workspaceType: "non-git",
          repositories: [],
          selectedRepoPath: null,
          worktreeBasePath: null,
        },
      ],
    });
    render(<ScratchSection onOpen={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Scratch projects (2)" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete scratch project older" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    });

    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
    expect(calls("scratch_delete")).toHaveLength(1);
  });
});
