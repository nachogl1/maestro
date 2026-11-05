import { type LucideIcon, MoreHorizontal } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useDismissable } from "@/hooks/useDismissable";

/** One action in the page menu. */
export interface WorkJournalPageMenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown in red on hover: the action removes something. */
  danger?: boolean;
}

export interface WorkJournalPageMenuProps {
  items: WorkJournalPageMenuItem[];
  /** Classes for the button that opens the menu. */
  buttonClassName: string;
}

const ICON_SIZE = 14;

/** Which end of the menu gets focus when it opens. */
type OpenFocus = "first" | "last";

/** The menu's action buttons that can run now, in order. */
function enabledButtons(buttons: (HTMLButtonElement | null)[]): HTMLButtonElement[] {
  return buttons.filter((el): el is HTMLButtonElement => el !== null && !el.disabled);
}

/**
 * The button and drop-down list of a Work Journal page's less frequent
 * actions. Keyboard: Enter, Space or the down arrow on the button opens it on
 * the first action, the up arrow on the last; inside, the arrows (wrapping),
 * Home and End move between the actions that can run, Enter or Space runs
 * one, Escape closes it, and Tab closes it and moves on. A click outside
 * closes it too. Focus goes back to the button when it closes.
 */
export function WorkJournalPageMenu({ items, buttonClassName }: WorkJournalPageMenuProps) {
  const [openFocus, setOpenFocus] = useState<OpenFocus | null>(null);
  const open = openFocus !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Focus the first or last action that can run once the list is shown.
  useEffect(() => {
    if (!openFocus) return;
    const enabled = enabledButtons(itemRefs.current);
    (openFocus === "first" ? enabled[0] : enabled[enabled.length - 1])?.focus();
  }, [openFocus]);

  // A press anywhere outside the button and the list closes it. Escape is
  // handled below, so focus can go back to the button.
  useDismissable(() => setOpenFocus(null), { ref: rootRef, enabled: open, escape: false });

  const close = (): void => {
    setOpenFocus(null);
    buttonRef.current?.focus();
  };

  const select = (item: WorkJournalPageMenuItem): void => {
    if (item.disabled) return;
    // Close first, so an action that moves focus (a date field) keeps it.
    close();
    item.onSelect();
  };

  const handleButtonKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpenFocus(e.key === "ArrowDown" ? "first" : "last");
    }
  };

  const handleMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const enabled = enabledButtons(itemRefs.current);
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const moveTo = (index: number): void => {
      e.preventDefault();
      enabled[(index + enabled.length) % enabled.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        moveTo(at + 1);
        break;
      case "ArrowUp":
        moveTo(at < 0 ? -1 : at - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(-1);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        // Not prevented: from the button, Tab moves on to the next control.
        close();
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpenFocus(open ? null : "first")}
        onKeyDown={handleButtonKey}
        className={`${buttonClassName} ${open ? "text-maestro-accent" : ""}`}
        aria-label="Page actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Page actions"
      >
        <MoreHorizontal size={ICON_SIZE} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Page actions"
          onKeyDown={handleMenuKey}
          className="absolute left-0 top-full z-20 mt-1 flex min-w-44 flex-col rounded border border-maestro-border bg-maestro-surface py-1 shadow-lg"
        >
          {items.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => select(item)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  select(item);
                }}
                className={`flex items-center gap-2 px-3 py-1 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-card focus:bg-maestro-card focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${item.danger ? "hover:text-maestro-red focus:text-maestro-red" : ""}`}
              >
                <Icon size={ICON_SIZE} className="shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
