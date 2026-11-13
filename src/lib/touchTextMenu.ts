import { app } from "../../src-tauri/tauri.conf.json";

/**
 * The touch-text "Paste ⋯" box is Chromium's touch selection quick menu
 * (`TouchSelectionMenuViews`), a native popup the web engine draws outside the
 * page. A touch long press on a text box asks for it; when no caret is on
 * screen it lands at the window's top-left corner and nothing closes it.
 *
 * Its WebView2 start-up options live once, on the main window in
 * `src-tauri/tauri.conf.json`: Tauri's default `--disable-features` list
 * (setting the options replaces it) plus `TouchTextEditingRedesign`, which
 * makes Chromium refuse a quick menu when there is no caret or selection.
 * Windows opened from the page must pass the very same options: WebView2
 * refuses a second window whose options differ from the first.
 */
export const WEBVIEW_WINDOW_OPTIONS: { additionalBrowserArgs: string } = {
  additionalBrowserArgs: app.windows[0].additionalBrowserArgs,
};

/** Pointer types whose long press asks Chromium for the touch-text menu. */
const TOUCH_POINTER_TYPES = new Set(["touch", "pen"]);

/** `MouseEvent.button` of a right click (a pen's barrel button sends it too). */
const RIGHT_BUTTON = 2;

/**
 * Cancels the context menu a touch or pen long press asks for, so Chromium
 * never opens its touch-text menu. Right clicks and the keyboard menu key keep
 * their menus. Returns the function that stops blocking.
 */
export function blockTouchTextMenu(target: Window): () => void {
  const onContextMenu = (event: Event): void => {
    const { pointerType, button } = event as PointerEvent;
    if (TOUCH_POINTER_TYPES.has(pointerType) && button !== RIGHT_BUTTON) {
      event.preventDefault();
    }
  };
  target.addEventListener("contextmenu", onContextMenu, true);
  return () => target.removeEventListener("contextmenu", onContextMenu, true);
}
