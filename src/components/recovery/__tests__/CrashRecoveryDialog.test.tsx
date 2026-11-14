import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted workspace store hydrates through the Tauri store plugin at
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

import { invoke } from "@tauri-apps/api/core";
import {
  type OfferedTerminal,
  type OpenTerminalsOffer,
  resetOpenTerminalsSnapshotForTests,
} from "@/stores/useOpenTerminalsSnapshotStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { CrashRecoveryDialog } from "../CrashRecoveryDialog";
import { formatStopTime } from "../recovery";

const invokeMock = vi.mocked(invoke);

const SHOP = "C:\\work\\shop-api";
const DOCS = "C:\\work\\docs-site";
const CONVERSATION = "0b5e6a4c-1d2f-4e3a-9b8c-7d6e5f4a3b2c";
/** Fri 13 Nov 2026, 18:42 local time. */
const STOPPED_AT = new Date(2026, 10, 13, 18, 42).getTime();

function tab(id: string, projectPath: string): WorkspaceTab {
  return {
    id,
    name: projectPath.split("\\").pop() ?? projectPath,
    projectPath,
    active: id === "shop",
    sessionIds: [],
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: projectPath,
    worktreeBasePath: null,
  };
}

function terminal(name: string, overrides: Partial<OfferedTerminal> = {}): OfferedTerminal {
  return {
    projectPath: SHOP,
    name,
    kind: "Claude",
    workingDirectory: SHOP,
    branch: null,
    pinned: false,
    parked: false,
    samurai: false,
    conversationId: CONVERSATION,
    folderExists: true,
    conversationFound: true,
    ...overrides,
  };
}

/** The list from the prototype's scene 1 (made-up names). */
const LIST: OpenTerminalsOffer = {
  savedAt: STOPPED_AT,
  afterUpdate: false,
  terminals: [
    terminal("checkout-fix"),
    terminal("payments-review", { parked: true }),
    terminal("dev server", { kind: "Plain", conversationId: null, conversationFound: false }),
    terminal("old-experiment", { folderExists: false }),
    terminal("night-run", { samurai: true }),
    terminal("rewrite-intro", { projectPath: DOCS, workingDirectory: DOCS, parked: true }),
    terminal("search-index", {
      projectPath: DOCS,
      workingDirectory: DOCS,
      conversationFound: false,
    }),
  ],
};

function backend(offer: OpenTerminalsOffer | null): void {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "open_terminals_load") return offer;
    return undefined;
  });
}

function cleared(): number {
  return invokeMock.mock.calls.filter(([c]) => c === "open_terminals_clear").length;
}

async function openDialog(): Promise<HTMLElement> {
  backend(LIST);
  render(<CrashRecoveryDialog />);
  return screen.findByRole("dialog", { name: "Maestro stopped unexpectedly" });
}

function rowNames(dialog: HTMLElement): string[] {
  return within(dialog)
    .getAllByRole("checkbox")
    .map((box) => box.getAttribute("aria-label") ?? "");
}

describe("CrashRecoveryDialog", () => {
  beforeEach(() => {
    resetOpenTerminalsSnapshotForTests();
    invokeMock.mockReset();
    usePendingLaunchStore.setState({ pending: [] });
    useSessionStore.setState({ sessions: [], parkedSessionIds: [], pinnedSessionIds: [] });
    useWorkspaceStore.setState({ tabs: [tab("shop", SHOP), tab("docs", DOCS)] });
  });

  it("shows nothing when no list was left (a first start, or after a normal close)", async () => {
    backend(null);
    render(<CrashRecoveryDialog />);

    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([c]) => c === "open_terminals_save")).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists the open terminals grouped by project in order, all ticked, with the stop time", async () => {
    const dialog = await openDialog();

    expect(
      within(dialog).getByText(`${formatStopTime(STOPPED_AT)} · these terminals were open`),
    ).toBeInTheDocument();
    expect(formatStopTime(STOPPED_AT)).toBe("Fri 13 Nov, 18:42");
    expect(rowNames(dialog)).toEqual([
      "Tick all terminals",
      "checkout-fix",
      "payments-review",
      "dev server",
      "old-experiment",
      "rewrite-intro",
      "search-index",
    ]);
    const groups = within(dialog).getAllByText(/^(shop-api|docs-site)$/);
    expect(groups.map((g) => g.textContent)).toEqual(["shop-api", "docs-site"]);
    expect(within(dialog).getByText("5 of 5 selected")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Bring back 5" })).toBeEnabled();
    for (const name of ["checkout-fix", "dev server", "search-index"]) {
      expect(within(dialog).getByRole("checkbox", { name })).toBeChecked();
    }
    expect(within(dialog).getAllByText("was parked")).toHaveLength(2);
    expect(within(dialog).getAllByText("conversation continues")).toHaveLength(3);
    expect(within(dialog).getByText("reopens empty")).toBeInTheDocument();
    expect(within(dialog).getByText("conversation not found, opens new")).toBeInTheDocument();
  });

  it("greys a terminal whose folder is gone: unticked, cannot be ticked, with its reason", async () => {
    const dialog = await openDialog();
    const gone = within(dialog).getByRole("checkbox", { name: "old-experiment" });

    expect(gone).toBeDisabled();
    expect(gone).not.toBeChecked();
    expect(within(dialog).getByText("folder no longer exists")).toBeInTheDocument();
  });

  it("leaves Samurai terminals out and counts them in one line", async () => {
    const dialog = await openDialog();

    expect(within(dialog).queryByRole("checkbox", { name: "night-run" })).toBeNull();
    expect(
      within(dialog).getByText(
        "1 Samurai run is not listed here. Recover it from the Launch panel.",
      ),
    ).toBeInTheDocument();
  });

  it("counts the ticks on the button and turns it off at zero", async () => {
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "dev server" }));
    expect(within(dialog).getByText("4 of 5 selected")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Bring back 4" })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Tick all terminals" }));
    expect(within(dialog).getByText("5 of 5 selected")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Tick all terminals" }));
    expect(within(dialog).getByText("0 of 5 selected")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Bring back 0" })).toBeDisabled();
  });

  it("brings back exactly the ticked terminals", async () => {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "payments-review" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Bring back 4" }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(4));
    expect(usePendingLaunchStore.getState().pending.map((p) => p.customName)).toEqual([
      "checkout-fix",
      "dev server",
      "rewrite-intro",
      "search-index",
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cleared()).toBe(1);
  });

  it.each([
    [
      "Don't bring back",
      () => fireEvent.click(screen.getByRole("button", { name: "Don't bring back" })),
    ],
    ["the ×", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
    ["Esc", () => fireEvent.keyDown(document, { key: "Escape" })],
  ])("%s removes the list for good and brings nothing back", async (_how, answer) => {
    await openDialog();

    answer();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cleared()).toBe(1);
    expect(usePendingLaunchStore.getState().pending).toEqual([]);
  });
});
