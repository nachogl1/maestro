import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { MaestroSettingsModal } from "../MaestroSettingsModal";

const invokeMock = vi.mocked(invoke);

// The Work Journal switch persists through the Tauri store plugin; happy-dom
// has no Tauri backend, so stub it out.
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

/** A stand-in ResizeObserver: happy-dom has no layout, so tests fire resizes by hand. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  /** Report a size change, as the browser would after late content renders. */
  fire() {
    if (this.disconnected) return;
    this.callback([], this as unknown as ResizeObserver);
  }
}

describe("MaestroSettingsModal focusSection", () => {
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy as unknown as Element["scrollIntoView"];
    // The full Work Journal section shows only once the user turned the journal on.
    useWorkJournalSettingsStore.setState({ enabled: true });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "samurai_get_config") throw new Error("not needed here");
      if (cmd === "is_cli_installed") return false;
      if (cmd === "get_app_version") return "0.3.9";
      if (cmd === "load_work_journal") {
        return { layout_version: 1, pages: {}, deleted_dates: [], settings: {} };
      }
      if (cmd === "work_journal_restore_state") return { canUndo: false };
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // biome-ignore lint/suspicious/noExplicitAny: removing the test-only stub
    delete (Element.prototype as any).scrollIntoView;
  });

  /** Scroll calls made on the Work Journal section (the element holding its "Backup folder" row). */
  async function sectionScrolls(): Promise<number> {
    const backup = await screen.findByText("Backup folder");
    return scrollSpy.mock.contexts.filter((el) => (el as Element).contains(backup)).length;
  }

  it("scrolls the Work Journal section into view again when content above it grows", async () => {
    render(<MaestroSettingsModal onClose={() => {}} focusSection="work-journal" />);
    const before = await sectionScrolls();
    expect(before).toBeGreaterThanOrEqual(1);

    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer).toBeDefined();
    act(() => observer?.fire());

    expect(await sectionScrolls()).toBe(before + 1);
  });

  it("stops re-scrolling once the user scrolls on their own", async () => {
    render(<MaestroSettingsModal onClose={() => {}} focusSection="work-journal" />);
    const before = await sectionScrolls();
    const observer = FakeResizeObserver.instances.at(-1);

    fireEvent.wheel(screen.getByText("Backup folder"));
    act(() => observer?.fire());

    expect(await sectionScrolls()).toBe(before);
  });

  it("stops re-scrolling once the layout has had time to settle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MaestroSettingsModal onClose={() => {}} focusSection="work-journal" />);
    const before = await sectionScrolls();
    const observer = FakeResizeObserver.instances.at(-1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => observer?.fire());

    expect(await sectionScrolls()).toBe(before);
  });

  it("does not watch for resizes when no section is asked for", async () => {
    render(<MaestroSettingsModal onClose={() => {}} />);
    await screen.findByText("Backup folder");
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });
});
