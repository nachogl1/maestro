import { describe, expect, it } from "vitest";
import tauriConfig from "../../../src-tauri/tauri.conf.json";
import { blockTouchTextMenu, WEBVIEW_WINDOW_OPTIONS } from "../touchTextMenu";

/** Features listed by `flag` (e.g. `--disable-features`) in a browser-args string. */
function features(args: string, flag: string): string[] {
  return args
    .trim()
    .split(/\s+/)
    .flatMap((token) => {
      const at = token.indexOf("=");
      if (at < 0 || token.slice(0, at) !== flag) return [];
      return token
        .slice(at + 1)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    });
}

const mainWindowArgs: string = tauriConfig.app.windows[0].additionalBrowserArgs ?? "";

describe("WebView2 start-up options", () => {
  it("reads browser features across spaces, commas and = in the args string", () => {
    expect(
      features("  --disable-features=a,b , --x=1   --disable-features=c ", "--disable-features"),
    ).toEqual(["a", "b", "c"]);
    expect(features("--disable-features", "--disable-features")).toEqual([]);
  });

  it("keeps Tauri's default options and turns on Chromium's no-caret menu guard", () => {
    expect(features(mainWindowArgs, "--disable-features")).toEqual(
      expect.arrayContaining(["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"]),
    );
    expect(features(mainWindowArgs, "--enable-features")).toContain("TouchTextEditingRedesign");
  });

  it("gives the windows opened from the page the main window's options", () => {
    expect(WEBVIEW_WINDOW_OPTIONS).toEqual({ additionalBrowserArgs: mainWindowArgs });
  });
});

describe("blockTouchTextMenu", () => {
  const cases: Array<{ pointerType: string; button: number; blocked: boolean }> = [
    { pointerType: "touch", button: 0, blocked: true },
    { pointerType: "pen", button: 0, blocked: true },
    { pointerType: "pen", button: 2, blocked: false },
    { pointerType: "mouse", button: 2, blocked: false },
    { pointerType: "", button: 0, blocked: false },
  ];

  it.each(cases)("a $pointerType context menu (button $button) is blocked: $blocked", (c) => {
    const stop = blockTouchTextMenu(window);
    const event = new PointerEvent("contextmenu", {
      pointerType: c.pointerType,
      button: c.button,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    stop();
    expect(event.defaultPrevented).toBe(c.blocked);
  });
});
