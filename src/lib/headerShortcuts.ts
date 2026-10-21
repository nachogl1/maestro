/**
 * Keyboard shortcuts for the controls on a terminal's header. Each one acts
 * on the focused terminal by clicking the matching header control, so the
 * shortcut behaves exactly like the click: closing still asks first, and the
 * pin only works where its button is shown.
 */
export type HeaderAction = "rename" | "close" | "pin" | "flag";

/**
 * The header action a key press asks for, or null. Alt+R rename, Alt+W
 * close, Alt+Shift+P pin, Alt+Shift+F flag. Uses event.code so the bindings
 * are layout-independent, like Alt+P.
 */
export function headerActionForKey(event: KeyboardEvent): HeaderAction | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.shiftKey) {
    if (event.code === "KeyP") return "pin";
    if (event.code === "KeyF") return "flag";
    return null;
  }
  if (event.code === "KeyR") return "rename";
  if (event.code === "KeyW") return "close";
  return null;
}

/**
 * Click the header control for `action` inside the pane `slotId`. Returns
 * false when the pane has no such control (e.g. the pin is not offered).
 */
export function clickHeaderAction(slotId: string, action: HeaderAction): boolean {
  const pane = document.querySelector(`[data-slot-id="${slotId}"]`);
  const control = pane?.querySelector<HTMLElement>(`[data-header-action="${action}"]`);
  if (!control) return false;
  control.click();
  return true;
}
