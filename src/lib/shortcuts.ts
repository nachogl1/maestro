import { isMac } from "./platform";

/** Platform primary modifier label: "⌘" on macOS, "Ctrl" elsewhere. */
export function modLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

/** Alt/Option label: "⌥" on macOS, "Alt" elsewhere. */
export function altLabel(): string {
  return isMac() ? "⌥" : "Alt";
}

/** Shift label: "⇧" on macOS, "Shift" elsewhere. */
export function shiftLabel(): string {
  return isMac() ? "⇧" : "Shift";
}

/** Human-readable key combo: "Ctrl+G" on Windows/Linux, "⌘G" on macOS. */
export function comboLabel(...keys: string[]): string {
  return keys.join(isMac() ? "" : "+");
}

/** Tooltip text for a button whose action has a shortcut: "Eagle view (Ctrl+G)". */
export function titleWithShortcut(action: string, ...keys: string[]): string {
  return `${action} (${comboLabel(...keys)})`;
}
