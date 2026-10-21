import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webglInstances: Array<{ dispose: ReturnType<typeof vi.fn>; loseContext: () => void }> = [];
const canvasInstances: unknown[] = [];

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    dispose = vi.fn();
    private lossHandler: (() => void) | null = null;
    constructor() {
      webglInstances.push(this);
    }
    onContextLoss(handler: () => void): void {
      this.lossHandler = handler;
    }
    loseContext(): void {
      this.lossHandler?.();
    }
  },
}));

vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    constructor() {
      canvasInstances.push(this);
    }
  },
}));

import { attachTerminalRenderer } from "@/lib/xtermRenderer";

let resizeCallback:
  | ((entries: Array<{ contentRect: { width: number; height: number } }>) => void)
  | null = null;

function resizeTo(width: number, height: number): void {
  resizeCallback?.([{ contentRect: { width, height } }]);
}

function makeContainer(width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: width });
  Object.defineProperty(el, "clientHeight", { value: height });
  return el;
}

describe("attachTerminalRenderer", () => {
  let term: Terminal;

  beforeEach(() => {
    webglInstances.length = 0;
    canvasInstances.length = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: typeof resizeCallback) {
          resizeCallback = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    term = { loadAddon: vi.fn() } as unknown as Terminal;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resizeCallback = null;
  });

  it("loads WebGL at once for a visible terminal", () => {
    attachTerminalRenderer(term, makeContainer(800, 600));
    expect(webglInstances).toHaveLength(1);
    expect(term.loadAddon).toHaveBeenCalledWith(webglInstances[0]);
  });

  it("waits for a size before loading WebGL in a hidden terminal", () => {
    attachTerminalRenderer(term, makeContainer(0, 0));
    expect(webglInstances).toHaveLength(0);
    resizeTo(800, 600);
    expect(webglInstances).toHaveLength(1);
  });

  it("releases WebGL while hidden and loads a fresh one when shown again", () => {
    attachTerminalRenderer(term, makeContainer(800, 600));
    resizeTo(0, 0);
    expect(webglInstances[0].dispose).toHaveBeenCalledTimes(1);
    resizeTo(0, 0);
    expect(webglInstances).toHaveLength(1);
    resizeTo(640, 480);
    expect(webglInstances).toHaveLength(2);
    resizeTo(700, 480);
    expect(webglInstances).toHaveLength(2);
  });

  it("falls back to Canvas2D for good after a lost context", () => {
    attachTerminalRenderer(term, makeContainer(800, 600));
    webglInstances[0].loseContext();
    expect(webglInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(canvasInstances).toHaveLength(1);
    resizeTo(0, 0);
    resizeTo(800, 600);
    expect(webglInstances).toHaveLength(1);
  });
});
