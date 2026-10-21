import type { Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { loadTerminalRenderer } from "@/lib/xtermRenderer";

describe("loadTerminalRenderer", () => {
  let term: Terminal;

  beforeEach(() => {
    webglInstances.length = 0;
    canvasInstances.length = 0;
    term = { loadAddon: vi.fn() } as unknown as Terminal;
  });

  it("loads WebGL once and never releases it on its own", () => {
    loadTerminalRenderer(term);
    expect(webglInstances).toHaveLength(1);
    expect(term.loadAddon).toHaveBeenCalledWith(webglInstances[0]);
    expect(webglInstances[0].dispose).not.toHaveBeenCalled();
  });

  it("falls back to Canvas2D after a lost context", () => {
    loadTerminalRenderer(term);
    webglInstances[0].loseContext();
    expect(webglInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(canvasInstances).toHaveLength(1);
    expect(webglInstances).toHaveLength(1);
  });

  it("uses Canvas2D when WebGL cannot load", () => {
    vi.mocked(term.loadAddon).mockImplementationOnce(() => {
      throw new Error("no WebGL2");
    });
    loadTerminalRenderer(term);
    expect(canvasInstances).toHaveLength(1);
  });
});
