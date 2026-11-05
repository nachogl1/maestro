import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ISSUE_MAP_PROJECTS_EVENT, type IssueMapProject } from "@/lib/issueMapWindow";
import { IssueMapWindow } from "../IssueMapWindow";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

// The map itself is covered by its own tests; here only the picker's list matters.
vi.mock("../IssueMapModal", () => ({
  IssueMapModal: ({ projects }: { projects: IssueMapProject[] }) => (
    <ul aria-label="Projects">
      {projects.map((p) => (
        <li key={p.repoPath}>{p.name}</li>
      ))}
    </ul>
  ),
}));

describe("IssueMapWindow", () => {
  it("shows a project opened while the map window is open, without reopening it", () => {
    render(
      <IssueMapWindow
        initial={{
          repoPath: "/repos/alpha",
          search: "",
          projects: [{ name: "alpha", repoPath: "/repos/alpha" }],
        }}
      />,
    );
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["alpha"]);

    const projects = [
      { name: "alpha", repoPath: "/repos/alpha" },
      { name: "suite / api", repoPath: "/repos/suite/api" },
    ];
    act(() => listeners.get(ISSUE_MAP_PROJECTS_EVENT)?.({ payload: projects }));

    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "alpha",
      "suite / api",
    ]);
  });
});
