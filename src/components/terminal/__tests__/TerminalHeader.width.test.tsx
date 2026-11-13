import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useSessionStore } from "@/stores/useSessionStore";
import { TerminalHeader } from "../TerminalHeader";

/**
 * happy-dom does no layout, so the header never learns its width on its own.
 * This stub stands in for the browser: `resizeHeaderTo` reports a width for
 * every element the header observes, the way a column resize would.
 */
const observers: StubResizeObserver[] = [];

class StubResizeObserver {
  readonly targets: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.targets.length = 0;
  }
  report(width: number): void {
    const entries = this.targets.map(
      (target) => ({ target, contentRect: { width } }) as unknown as ResizeObserverEntry,
    );
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

function resizeHeaderTo(width: number): void {
  act(() => {
    for (const observer of observers) observer.report(width);
  });
}

const handlers = () => ({
  onKill: vi.fn(),
  onPark: vi.fn(),
  onTogglePin: vi.fn(),
  onToggleZoom: vi.fn(),
  onSetZoomLevel: vi.fn(),
});

function renderHeader(props: Partial<React.ComponentProps<typeof TerminalHeader>> = {}) {
  const fns = handlers();
  render(
    <TerminalHeader
      sessionId={7}
      sessionName="api work"
      branchName="feat/long-branch"
      projectLabel="alpha"
      zoomLevel={125}
      {...fns}
      {...props}
    />,
  );
  return fns;
}

const MENU = "More terminal actions";

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  useSessionStore.setState({ sessions: [], samuraiBySessionId: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TerminalHeader in narrow columns (issue #552)", () => {
  it("folds park, pin, zoom and font size into the ⋯ menu only when narrow", () => {
    const cases = [
      { width: 900, folded: false },
      { width: 480, folded: false },
      { width: 479, folded: true },
      { width: 200, folded: true },
    ];
    for (const { width, folded } of cases) {
      const { unmount } = render(
        <TerminalHeader sessionId={7} zoomLevel={125} {...handlers()} onKill={vi.fn()} />,
      );
      resizeHeaderTo(width);
      const buttons = ["Park session 7", "Pin session 7", "Zoom terminal", "Font zoom: 125%"];
      for (const label of buttons) {
        const shown = screen.queryByRole("button", { name: label }) !== null;
        expect(shown, `${label} at ${width}px`).toBe(!folded);
      }
      expect(screen.queryByRole("button", { name: MENU }) !== null, `menu at ${width}px`).toBe(
        folded,
      );
      expect(screen.getByRole("button", { name: "Kill session 7" })).toBeInTheDocument();
      unmount();
      observers.length = 0;
    }
  });

  it("each menu item does what its button did, with the same shortcut hints", () => {
    const fns = renderHeader();
    resizeHeaderTo(300);

    const open = () => fireEvent.click(screen.getByRole("button", { name: MENU }));
    open();
    const park = screen.getByRole("menuitem", { name: "Park session 7" });
    expect(park.getAttribute("title")).toMatch(/\(Alt\+P\)$/);
    fireEvent.click(park);
    expect(fns.onPark).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();

    open();
    const pin = screen.getByRole("menuitem", { name: "Pin session 7" });
    expect(pin.getAttribute("title")).toMatch(/\(Alt\+Shift\+P\)$/);
    fireEvent.click(pin);
    expect(fns.onTogglePin).toHaveBeenCalledTimes(1);

    open();
    const zoom = screen.getByRole("menuitem", { name: "Zoom terminal" });
    expect(zoom.getAttribute("title")).toBe("Zoom terminal (Ctrl+1)");
    fireEvent.click(zoom);
    expect(fns.onToggleZoom).toHaveBeenCalledTimes(1);

    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Font zoom 150%" }));
    expect(fns.onSetZoomLevel).toHaveBeenCalledWith(150);
    expect(fns.onKill).not.toHaveBeenCalled();
  });

  it("keeps the pin shortcut working while the pin sits in the closed menu", () => {
    const fns = renderHeader();
    resizeHeaderTo(300);
    const pin = document.querySelector<HTMLElement>('[data-header-action="pin"]');
    expect(pin).not.toBeNull();
    pin?.click();
    expect(fns.onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("hides the branch first, then the project name, and keeps the terminal name", () => {
    const cases = [
      { width: 600, branch: true, project: true },
      { width: 400, branch: true, project: true },
      { width: 359, branch: false, project: true },
      { width: 259, branch: false, project: false },
      { width: 120, branch: false, project: false },
    ];
    for (const { width, branch, project } of cases) {
      const { unmount } = render(
        <TerminalHeader
          sessionId={7}
          sessionName="api work"
          branchName="feat/long-branch"
          projectLabel="alpha"
          onKill={vi.fn()}
        />,
      );
      resizeHeaderTo(width);
      expect(screen.queryByText("feat/long-branch") !== null, `branch at ${width}px`).toBe(branch);
      expect(screen.queryByText("alpha") !== null, `project at ${width}px`).toBe(project);
      expect(screen.getByRole("button", { name: "api work" })).toBeInTheDocument();
      unmount();
      observers.length = 0;
    }
  });

  it("shows hidden project and branch in full when hovering the terminal name", () => {
    renderHeader({ onRename: vi.fn() });
    resizeHeaderTo(200);
    const title = screen.getByRole("button", { name: "api work" }).getAttribute("title") ?? "";
    expect(title).toContain("api work");
    expect(title).toContain("Project: alpha");
    expect(title).toContain("feat/long-branch");
    expect(title).toMatch(/Rename terminal — click to edit the name \(Alt\+R\)$/);
  });

  it("shows a terminal name cut with … in full on hover", () => {
    renderHeader({ sessionName: "a very long terminal name", onRename: vi.fn() });
    const name = screen.getByRole("button", { name: "a very long terminal name" });
    expect(name.className).toContain("truncate");
    Object.defineProperty(name, "scrollWidth", { configurable: true, value: 240 });
    Object.defineProperty(name, "clientWidth", { configurable: true, value: 60 });
    resizeHeaderTo(700);
    expect(name.getAttribute("title")).toContain("a very long terminal name");
  });

  it("keeps the AI icon and the Samurai badge visible at every width", () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 7,
          mode: "Claude",
          branch: null,
          status: "Working",
          worktree_path: null,
          project_path: "C:/proj",
        },
      ],
      samuraiBySessionId: {
        7: { project: "C:/proj", epic: "#1", generation: 2, state: "WORKING" },
      },
    });
    for (const width of [900, 400, 300, 200, 120]) {
      const { unmount } = renderHeaderAt(width);
      expect(screen.getByLabelText("Select AI provider"), `AI icon at ${width}px`).toBeVisible();
      expect(screen.getByText("gen-2 · working"), `badge at ${width}px`).toBeVisible();
      unmount();
      observers.length = 0;
    }
  });

  it("follows the header's own width, not the terminal count", () => {
    for (const terminalCount of [2, 6]) {
      const { unmount } = render(
        <TerminalHeader sessionId={7} terminalCount={terminalCount} {...handlers()} />,
      );
      resizeHeaderTo(300);
      expect(screen.getByRole("button", { name: MENU })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Park session 7" })).toBeNull();
      unmount();
      observers.length = 0;

      const wide = render(
        <TerminalHeader sessionId={7} terminalCount={terminalCount} {...handlers()} />,
      );
      resizeHeaderTo(900);
      expect(screen.queryByRole("button", { name: MENU })).toBeNull();
      expect(screen.getByRole("button", { name: "Park session 7" })).toBeInTheDocument();
      wide.unmount();
      observers.length = 0;
    }
  });
});

function renderHeaderAt(width: number) {
  const result = render(<TerminalHeader sessionId={7} {...handlers()} />);
  resizeHeaderTo(width);
  return result;
}
