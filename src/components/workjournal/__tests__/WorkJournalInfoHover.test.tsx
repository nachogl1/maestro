import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkJournalSettingsSection } from "@/components/settings/WorkJournalSettingsSection";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { WorkJournalOptInDialog } from "../WorkJournalOptInDialog";

// The settings persist through the Tauri store plugin; happy-dom has no
// Tauri backend, so stub it out.
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

const invokeMock = vi.mocked(invoke);

/** The agreed text, line by line, exactly as the person must read it. */
const EXPECTED_LINES = [
  "What the Work Journal does",
  "It keeps one page per day. Claude reads your activity and suggests short lines; " +
    "nothing is added until you accept it.",
  "Sources it reads",
  "Claude conversations in Maestro",
  "Terminal sessions in Maestro",
  "Git commits — needs your git name/email set",
  "Pull requests and issues — needs gh signed in",
  "Granola meetings — off until you turn it on in Settings, and Granola connected to Claude",
  "Suggestions are written by the Claude CLI.",
];

const PLACES: Array<{ place: string; ui: () => ReactElement }> = [
  { place: "the first-run question", ui: () => <WorkJournalOptInDialog /> },
  { place: "Settings → Work Journal", ui: () => <WorkJournalSettingsSection /> },
];

function infoIcon(): HTMLElement {
  return screen.getByRole("button", { name: "About the Work Journal" });
}

function expectEveryLine(box: HTMLElement): void {
  for (const line of EXPECTED_LINES) expect(box).toHaveTextContent(line);
  expect(box.querySelectorAll("li")).toHaveLength(5);
}

describe("WorkJournalInfoHover", () => {
  beforeEach(async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "load_work_journal") {
        return { layout_version: 1, pages: {}, deleted_dates: [], settings: {} };
      }
      if (cmd === "work_journal_restore_state") return { canUndo: false };
      return undefined;
    });
    await useWorkJournalSettingsStore.persist.rehydrate();
    useWorkJournalSettingsStore.setState({ enabled: null });
    useUpdateStore.setState({ autoInstallOnLaunch: false });
  });

  it.each(PLACES)("shows the explanation while hovering the (i) on $place", ({ ui }) => {
    render(ui());
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.mouseEnter(infoIcon());
    expectEveryLine(screen.getByRole("tooltip"));

    fireEvent.mouseLeave(infoIcon());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each(PLACES)("shows it on keyboard focus on $place; Escape hides it", ({ ui }) => {
    render(ui());

    fireEvent.focus(infoIcon());
    expectEveryLine(screen.getByRole("tooltip"));

    fireEvent.keyDown(infoIcon(), { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
