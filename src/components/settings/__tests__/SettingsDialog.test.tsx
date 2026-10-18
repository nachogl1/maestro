import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted stores hydrate through the Tauri store plugin and the terminal
// settings store listens for zoom events; happy-dom has no Tauri backend.
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

import { useTerminalSettingsStore } from "@/stores/useTerminalSettingsStore";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { SettingsDialog } from "../SettingsDialog";

const invokeMock = vi.mocked(invoke);

const SECTION_LABELS = [
  "Appearance",
  "Features",
  "Notifications",
  "Updates",
  "Terminal",
  "AI command lines",
  "Samurai",
  "Work Journal",
  "Keyboard shortcuts",
  "Changelog",
];

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Settings sections" });
}

function openSection(label: string) {
  fireEvent.click(within(nav()).getByRole("button", { name: label }));
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    useTerminalSettingsStore.setState({
      isInitialized: true,
      isLoading: false,
      availableFonts: [],
    });
    // The full Work Journal section shows only once the user turned the journal on.
    useWorkJournalSettingsStore.setState({ enabled: true });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "samurai_get_config") return null;
      if (cmd === "is_cli_installed") return false;
      if (cmd === "get_app_version") return "0.3.9";
      if (cmd === "load_work_journal") {
        return { layout_version: 1, pages: {}, deleted_dates: [], settings: {} };
      }
      if (cmd === "work_journal_restore_state") return { canUndo: false };
      return null;
    });
  });

  it("lists every settings section in one menu", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    for (const label of SECTION_LABELS) {
      expect(within(nav()).getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("opens on Appearance and marks it as the current section", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    expect(within(nav()).getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("radio", { name: "Dark" })).toBeInTheDocument();
  });

  it("shows the chosen section and only that one", () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    openSection("Terminal");
    expect(
      within(screen.getByRole("region", { name: "Terminal" })).getByText("Font Family"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Dark" })).not.toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("holds the settings that used to live in the sidebar and in separate dialogs", async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    openSection("Features");
    expect(screen.getByRole("switch", { name: "Show Samurai launch" })).toBeInTheDocument();
    openSection("Notifications");
    expect(screen.getByText("Show notifications")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Toggle notifications" })).toBeInTheDocument();
    expect(screen.getByLabelText("Context alert threshold")).toBeInTheDocument();
    openSection("AI command lines");
    expect(screen.getByText("Custom Flags")).toBeInTheDocument();
    openSection("Updates");
    expect(screen.getByText("Auto-check")).toBeInTheDocument();
    openSection("Samurai");
    expect(screen.getByText("Samurai Thresholds")).toBeInTheDocument();
    openSection("Keyboard shortcuts");
    expect(screen.getByText("Left Sidebar")).toBeInTheDocument();
    openSection("Changelog");
    expect(screen.getAllByText(/^\d{4}-\d{2}-\d{2}$/).length).toBeGreaterThan(0);
    openSection("Work Journal");
    expect(await screen.findByText("Backup folder")).toBeInTheDocument();
  });

  it("can open straight at a given section", async () => {
    render(<SettingsDialog onClose={vi.fn()} initialSection="work-journal" />);
    expect(await screen.findByText("Backup folder")).toBeInTheDocument();
    expect(within(nav()).getByRole("button", { name: "Work Journal" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("switches the theme from the Appearance section", () => {
    const onToggleTheme = vi.fn();
    render(<SettingsDialog onClose={vi.fn()} theme="dark" onToggleTheme={onToggleTheme} />);
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onToggleTheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  it("renders at the top level of the document, above the terminal area", () => {
    const { container } = render(
      <div data-testid="host">
        <SettingsDialog onClose={vi.fn()} />
      </div>,
    );
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(container.querySelector('[data-testid="host"]')?.contains(dialog)).toBe(false);
    const backdrop = dialog.closest(".fixed");
    expect(backdrop?.parentElement).toBe(document.body);
    expect(backdrop?.className).toContain("z-[100]");
  });

  it("closes from the close button", () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
