import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { usePrivacySettingsStore } from "@/stores/usePrivacySettingsStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { PrivacyConsentDialog } from "../PrivacyConsentDialog";

const invokeMock = vi.mocked(invoke);
const QUESTION = "Let Claude read your conversations?";

function question() {
  return screen.queryByRole("dialog", { name: QUESTION });
}

function answer() {
  const { workshop, historySummaries } = usePrivacySettingsStore.getState();
  return { workshop, historySummaries };
}

describe("PrivacyConsentDialog", () => {
  beforeEach(async () => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    await usePrivacySettingsStore.persist.rehydrate();
    await useWorkJournalSettingsStore.persist.rehydrate();
    usePrivacySettingsStore.setState({ workshop: null, historySummaries: null });
    // The automatic-updates and Work Journal questions were already answered.
    useUpdateStore.setState({ autoInstallOnLaunch: false });
    useWorkJournalSettingsStore.setState({ enabled: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks once nothing is recorded, with both switches off and nothing sent", () => {
    render(<PrivacyConsentDialog />);
    expect(question()).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Workshop" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "History summaries" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      screen.getByText(
        "Two features send the text of your Claude conversations to Claude, through your own " +
          "Claude CLI and your Claude allowance. Both stay off unless you switch them on.",
      ),
    ).toBeInTheDocument();
    expect(usePrivacySettingsStore.getState().confirmed).toEqual({
      workshop: false,
      historySummaries: false,
    });
  });

  it.each([
    [
      "the automatic-updates question",
      () => useUpdateStore.setState({ autoInstallOnLaunch: null }),
    ],
    ["the Work Journal question", () => useWorkJournalSettingsStore.setState({ enabled: null })],
  ])("waits for %s, so first-run questions never stack", (_case, unanswer) => {
    unanswer();
    render(<PrivacyConsentDialog />);
    expect(question()).toBeNull();
  });

  it("stays hidden until the saved choice has been read", () => {
    vi.spyOn(usePrivacySettingsStore.persist, "hasHydrated").mockReturnValue(false);
    vi.spyOn(usePrivacySettingsStore.persist, "onFinishHydration").mockReturnValue(() => {});
    render(<PrivacyConsentDialog />);
    expect(question()).toBeNull();
  });

  it("stays hidden once the user has answered", () => {
    usePrivacySettingsStore.setState({ workshop: false, historySummaries: true });
    render(<PrivacyConsentDialog />);
    expect(question()).toBeNull();
  });

  it("Save keeps what the switches say and closes the question", () => {
    render(<PrivacyConsentDialog />);
    fireEvent.click(screen.getByRole("switch", { name: "History summaries" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(answer()).toEqual({ workshop: false, historySummaries: true });
    expect(invokeMock).toHaveBeenCalledWith("set_privacy_consent", {
      workshop: false,
      historySummaries: true,
    });
    expect(question()).toBeNull();
  });

  it.each([
    ["Keep both off", () => fireEvent.click(screen.getByRole("button", { name: "Keep both off" }))],
    ["the close button", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
  ])("%s saves both as off, whatever the switches say", (_case, dismiss) => {
    render(<PrivacyConsentDialog />);
    fireEvent.click(screen.getByRole("switch", { name: "Workshop" }));
    dismiss();

    expect(answer()).toEqual({ workshop: false, historySummaries: false });
    expect(question()).toBeNull();
  });

  it("ignores a click outside the question", () => {
    render(<PrivacyConsentDialog />);
    fireEvent.mouseDown(document.body);
    expect(question()).toBeInTheDocument();
    expect(answer()).toEqual({ workshop: null, historySummaries: null });
  });
});
