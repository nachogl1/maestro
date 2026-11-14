import { beforeEach, describe, expect, it } from "vitest";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  sanitizePanelStrip,
  usePanelStripStore,
} from "../usePanelStripStore";

const ROOM_FOR_THREE = PANEL_DEFAULT_WIDTH * 3;

function store() {
  return usePanelStripStore.getState();
}

describe("usePanelStripStore", () => {
  beforeEach(() => {
    localStorage.clear();
    usePanelStripStore.setState({ openPanels: [], widths: {}, refusal: null });
  });

  it("starts with the History panel open, as the sidebar did", () => {
    expect(usePanelStripStore.getInitialState().openPanels).toEqual(["history"]);
  });

  it("toggles a panel open and closed", () => {
    expect(store().togglePanel("notes", ROOM_FOR_THREE)).toBe("opened");
    expect(store().openPanels).toEqual(["notes"]);
    expect(store().togglePanel("notes", ROOM_FOR_THREE)).toBe("closed");
    expect(store().openPanels).toEqual([]);
  });

  it("refuses a panel that would not fit, and records each refusal", () => {
    store().togglePanel("history", ROOM_FOR_THREE);
    store().togglePanel("git", ROOM_FOR_THREE);
    store().togglePanel("notes", ROOM_FOR_THREE);

    expect(store().togglePanel("infra", ROOM_FOR_THREE)).toBe("refused");
    expect(store().openPanels).toEqual(["history", "git", "notes"]);
    expect(store().refusal).toEqual({ id: "infra", seq: 1 });
    store().openPanel("infra", ROOM_FOR_THREE);
    expect(store().refusal).toEqual({ id: "infra", seq: 2 });
  });

  it("openPanel leaves an open panel open", () => {
    store().openPanel("git", ROOM_FOR_THREE);
    expect(store().openPanel("git", ROOM_FOR_THREE)).toBe("opened");
    expect(store().openPanels).toEqual(["git"]);
  });

  it("closes the most recently opened panels first until the rest fit", () => {
    for (const id of ["settings", "history", "notes"] as const) store().togglePanel(id, 2000);

    expect(store().closeToFit(PANEL_DEFAULT_WIDTH)).toEqual(["notes", "history"]);
    expect(store().openPanels).toEqual(["settings"]);
    expect(store().closeToFit(PANEL_DEFAULT_WIDTH)).toEqual([]);
  });

  it("holds each panel's width between 240 and 640 px, separately", () => {
    store().setPanelWidth("notes", 100);
    store().setPanelWidth("git", 5000);
    store().setPanelWidth("history", 401.6);
    expect(store().widths).toEqual({ notes: PANEL_MIN_WIDTH, git: PANEL_MAX_WIDTH, history: 402 });
  });

  it("brings the open panels and widths back after a restart", async () => {
    store().togglePanel("git", ROOM_FOR_THREE);
    store().togglePanel("notes", ROOM_FOR_THREE);
    store().setPanelWidth("notes", 500);

    // A restart: the in-memory state is gone, only what was saved remains.
    const saved = localStorage.getItem("maestro-panel-strip");
    usePanelStripStore.setState({ openPanels: [], widths: {} });
    localStorage.setItem("maestro-panel-strip", saved ?? "");
    await usePanelStripStore.persist.rehydrate();

    expect(store().openPanels).toEqual(["git", "notes"]);
    expect(store().widths).toEqual({ notes: 500 });
  });
});

describe("sanitizePanelStrip (saved state is untrusted)", () => {
  it.each([
    ["nothing", null, { openPanels: [], widths: {} }],
    ["a non-object", "garbage", { openPanels: [], widths: {} }],
    ["a non-list of panels", { openPanels: "git", widths: [] }, { openPanels: [], widths: {} }],
    [
      "null, duplicate and unknown ids",
      { openPanels: ["git", null, "git", "sidebar", 3, "notes"] },
      { openPanels: ["git", "notes"], widths: {} },
    ],
    [
      "the removed Launch panel",
      { openPanels: ["launch", "git"], widths: { launch: 400, git: 300 } },
      { openPanels: ["git"], widths: { git: 300 } },
    ],
    [
      "bad and out-of-range widths",
      {
        openPanels: [],
        widths: { git: "wide", notes: null, history: 90, infra: Number.NaN, x: 300 },
      },
      { openPanels: [], widths: { history: PANEL_MIN_WIDTH } },
    ],
  ])("keeps only what is valid from %s", (_label, saved, expected) => {
    expect(sanitizePanelStrip(saved)).toEqual(expected);
  });
});
