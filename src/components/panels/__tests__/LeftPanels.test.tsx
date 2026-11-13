import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The persisted feature settings hydrate through the Tauri store plugin.
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
  listen: vi.fn().mockResolvedValue(() => {}),
}));
// What each panel shows is covered by the panel contents tests; here only the layout.
vi.mock("../PanelBody", () => ({
  PanelBody: ({ id }: { id: string }) => <div>{id} body</div>,
}));
vi.mock("../GitPanel", () => ({ GitPanelHeaderExtra: () => null }));

import { useFeatureSettingsStore } from "@/stores/useFeatureSettingsStore";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  type PanelId,
  usePanelStripStore,
} from "@/stores/usePanelStripStore";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import type { GitPanelProps } from "../GitPanel";
import { LeftPanels } from "../LeftPanels";
import { ICON_STRIP_WIDTH, TERMINALS_MIN_WIDTH } from "../panelLayout";

const GIT: GitPanelProps = {
  repoPath: null,
  currentBranch: null,
  repositories: [],
  workspaceType: "single-repo",
  onRepoChange: vi.fn(),
  activeTab: "status",
  onActiveTabChange: vi.fn(),
};

/** Every strip icon, top to bottom, with the panel it opens. */
const STRIP: [string, string][] = [
  ["History", "History panel"],
  ["Git", "Git panel"],
  ["Notes", "Notes panel"],
  ["Work Journal", "Work Journal panel"],
  ["Injector", "Injector panel"],
  ["Launch", "Launch panel"],
  ["Second Brain", "Second Brain panel"],
  ["Workshop", "Workshop panel"],
  ["Infra", "Infra panel"],
  ["Settings", "Settings panel"],
];

/** A window with room for exactly `panels` default-width panels beside the terminals. */
function setWindowRoomFor(panels: number) {
  const width = ICON_STRIP_WIDTH + TERMINALS_MIN_WIDTH + panels * PANEL_DEFAULT_WIDTH;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

function icon(name: string): HTMLElement {
  return within(screen.getByRole("navigation", { name: "Panels" })).getByRole("button", { name });
}

/** Open panels as they sit on screen, left to right. */
function openPanelNames(): string[] {
  return screen.getAllByRole("region").map((r) => r.getAttribute("aria-label") ?? "");
}

function renderPanels(open: PanelId[] = []) {
  usePanelStripStore.setState({ openPanels: open, widths: {}, refusal: null });
  return render(<LeftPanels content={{ git: GIT }} />);
}

describe("LeftPanels: the icon strip on the far left", () => {
  beforeEach(() => {
    localStorage.clear();
    setWindowRoomFor(10);
    useFeatureSettingsStore.setState({ samuraiLaunchEnabled: true, secondBrainEnabled: true });
    useWorkJournalSettingsStore.setState({ enabled: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens and closes each panel from its icon and marks the open icons", () => {
    renderPanels();
    for (const [name, region] of STRIP) {
      fireEvent.click(icon(name));
      expect(icon(name)).toHaveAttribute("aria-pressed", "true");
      expect(within(icon(name)).getByTestId("open-marker")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: region })).toBeInTheDocument();

      fireEvent.click(icon(name));
      expect(icon(name)).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByRole("region", { name: region })).not.toBeInTheDocument();
    }
  });

  it("closes a panel from its own close button", () => {
    renderPanels(["notes"]);
    fireEvent.click(screen.getByRole("button", { name: "Close Notes panel" }));
    expect(screen.queryByRole("region", { name: "Notes panel" })).not.toBeInTheDocument();
    expect(icon("Notes")).toHaveAttribute("aria-pressed", "false");
  });

  it("puts open panels side by side in strip order, whatever order they were opened in", () => {
    renderPanels();
    for (const name of ["Settings", "Notes", "History"]) fireEvent.click(icon(name));
    expect(openPanelNames()).toEqual(["History panel", "Notes panel", "Settings panel"]);
  });

  it("resizes only the dragged panel, held between 240 and 640 px", () => {
    renderPanels(["history", "notes"]);
    const notes = screen.getByRole("region", { name: "Notes panel" });
    const history = screen.getByRole("region", { name: "History panel" });
    const drag = (dx: number) => {
      fireEvent.mouseDown(within(notes).getByRole("separator", { name: "Resize Notes panel" }), {
        clientX: 500,
      });
      fireEvent.mouseMove(document, { clientX: 500 + dx });
      fireEvent.mouseUp(document);
    };

    drag(80);
    expect(notes.style.width).toBe(`${PANEL_DEFAULT_WIDTH + 80}px`);
    expect(history.style.width).toBe(`${PANEL_DEFAULT_WIDTH}px`);
    drag(2000);
    expect(notes.style.width).toBe(`${PANEL_MAX_WIDTH}px`);
    drag(-2000);
    expect(notes.style.width).toBe(`${PANEL_MIN_WIDTH}px`);
    expect(history.style.width).toBe(`${PANEL_DEFAULT_WIDTH}px`);
  });

  it("refuses a panel that would leave the terminals under 520 px: the icon shakes and says why", () => {
    setWindowRoomFor(2);
    renderPanels(["history", "git"]);

    fireEvent.click(icon("Notes"));

    expect(screen.queryByRole("region", { name: "Notes panel" })).not.toBeInTheDocument();
    expect(icon("Notes")).toHaveAttribute("data-shaking", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "No room for Notes. Close a panel or make one narrower.",
    );
  });

  it("does not let a drag squeeze the terminals under 520 px", () => {
    setWindowRoomFor(2);
    renderPanels(["history", "notes"]);
    const notes = screen.getByRole("region", { name: "Notes panel" });
    fireEvent.mouseDown(within(notes).getByRole("separator", { name: "Resize Notes panel" }), {
      clientX: 500,
    });
    fireEvent.mouseMove(document, { clientX: 700 });
    fireEvent.mouseUp(document);
    expect(notes.style.width).toBe(`${PANEL_DEFAULT_WIDTH}px`);
  });

  it("closes the most recently opened panels first when the window gets narrower", () => {
    renderPanels();
    for (const name of ["Settings", "History", "Notes"]) fireEvent.click(icon(name));

    setWindowRoomFor(1);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(openPanelNames()).toEqual(["Settings panel"]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Window got narrower: closed Notes, History.",
    );
  });

  it("closes restored panels that no longer fit this window", () => {
    setWindowRoomFor(1);
    renderPanels(["infra", "git"]);
    expect(openPanelNames()).toEqual(["Infra panel"]);
  });

  it("shows only the icons switched on in Settings → Features, closing a switched-off panel", () => {
    renderPanels(["launch"]);
    act(() => {
      useFeatureSettingsStore.setState({ samuraiLaunchEnabled: false, secondBrainEnabled: false });
      useWorkJournalSettingsStore.setState({ enabled: false });
    });
    const strip = screen.getByRole("navigation", { name: "Panels" });
    for (const name of ["Launch", "Second Brain", "Work Journal"]) {
      expect(within(strip).queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("region", { name: "Launch panel" })).not.toBeInTheDocument();
    expect(usePanelStripStore.getState().openPanels).toEqual([]);
  });

  it("keeps a restored Work Journal panel open while its on/off choice is still loading", () => {
    vi.spyOn(useWorkJournalSettingsStore.persist, "hasHydrated").mockReturnValue(false);
    vi.spyOn(useWorkJournalSettingsStore.persist, "onFinishHydration").mockReturnValue(() => {});
    useWorkJournalSettingsStore.setState({ enabled: null });
    try {
      renderPanels(["workjournal"]);
      expect(usePanelStripStore.getState().openPanels).toEqual(["workjournal"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("shows each icon's shortcut in its tooltip", () => {
    renderPanels();
    expect(icon("History")).toHaveAttribute("title", "History (Alt+1)");
    expect(icon("Infra")).toHaveAttribute("title", "Infra (Alt+2)");
    expect(icon("Settings")).toHaveAttribute("title", "Settings (Alt+3)");
    expect(icon("Injector")).toHaveAttribute("title", "Injector (Alt+4)");
    expect(icon("Git")).toHaveAttribute("title", "Git (Ctrl+2)");
    expect(icon("Notes")).toHaveAttribute("title", "Notes (Ctrl+5)");
    expect(icon("Launch")).toHaveAttribute("title", "Launch");
  });
});
