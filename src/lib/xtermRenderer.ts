/**
 * GPU renderer for one xterm.js terminal: WebGL → Canvas2D → DOM fallback.
 *
 * The WebGL context is loaded once and kept while the terminal is hidden
 * (inactive project, parked tile). Releasing it on hide and creating a fresh
 * one on show coincided with whole-screen white flashes on Windows (Intel
 * GPU) on every park, resume and project switch. A lost WebGL context falls back to
 * Canvas2D for good.
 */
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/**
 * Loads the renderer into `term`. Must be called after `term.open()`; the
 * addons go with `term.dispose()`.
 */
export function loadTerminalRenderer(term: Terminal): void {
  const fallBack = (): void => {
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      /* DOM renderer as final fallback */
    }
  };

  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      fallBack();
    });
    term.loadAddon(addon);
  } catch {
    // WebGL not available — use Canvas2D renderer
    fallBack();
  }
}
