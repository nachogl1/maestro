import { type RefObject, useEffect, useRef } from "react";

/** Options for {@link useDismissable}. */
export interface UseDismissableOptions {
  /**
   * The overlay/menu element. A `mousedown` on the document outside it
   * dismisses. Omit it for overlays that close on Escape only.
   */
  ref?: RefObject<HTMLElement | null>;
  /** Bind the listeners only while true (e.g. a menu that is open). Default true. */
  enabled?: boolean;
  /** Dismiss on the Escape key. Default true. */
  escape?: boolean;
}

/**
 * Shared overlay dismissal: calls `onDismiss` on Escape (document `keydown`)
 * and, when `ref` is given, on a document `mousedown` outside that element.
 *
 * Listeners are bound only while `enabled`, and always call the latest
 * `onDismiss`, so inline callbacks do not re-bind them every render.
 */
export function useDismissable(onDismiss: () => void, options: UseDismissableOptions = {}): void {
  const { ref, enabled = true, escape: closeOnEscape = true } = options;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!enabled || !ref) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismissRef.current();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [enabled, ref]);

  useEffect(() => {
    if (!enabled || !closeOnEscape) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismissRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, closeOnEscape]);
}
