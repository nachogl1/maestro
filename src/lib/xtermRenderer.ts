/**
 * GPU renderer for one xterm.js terminal, held only while it is visible.
 *
 * Every WebGL context keeps its own canvas buffers and glyph textures in the
 * GPU process, and terminals of inactive projects or parked tiles stay mounted
 * with `display:none`. So the WebGL addon is released when the container
 * shrinks to 0×0 and loaded again when it gets a size back; xterm keeps the
 * buffer and redraws on the next frame. A lost WebGL context falls back to
 * Canvas2D for good, as before.
 */
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/**
 * Loads the renderer into `term` (WebGL → Canvas2D → DOM fallback) and swaps
 * WebGL out while `container` is hidden. Must be called after `term.open()`.
 * @returns Stops watching the container; the addons go with `term.dispose()`.
 */
export function attachTerminalRenderer(term: Terminal, container: HTMLElement): () => void {
  let webgl: WebglAddon | null = null;
  let fellBack = false;

  const fallBack = (): void => {
    fellBack = true;
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      /* DOM renderer as final fallback */
    }
  };

  const loadWebgl = (): void => {
    if (webgl || fellBack) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        if (webgl !== addon) return;
        webgl = null;
        addon.dispose();
        fallBack();
      });
      term.loadAddon(addon);
      webgl = addon;
    } catch {
      // WebGL not available — use Canvas2D renderer
      fallBack();
    }
  };

  const releaseWebgl = (): void => {
    const addon = webgl;
    webgl = null;
    addon?.dispose();
  };

  const isHidden = (width: number, height: number): boolean => width === 0 || height === 0;

  if (!isHidden(container.clientWidth, container.clientHeight)) loadWebgl();

  const observer = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.contentRect;
    if (!box) return;
    if (isHidden(box.width, box.height)) releaseWebgl();
    else loadWebgl();
  });
  observer.observe(container);
  return () => observer.disconnect();
}
