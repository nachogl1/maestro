import { useEffect, useRef } from "react";

/** One choice of the right-click menu, with the gesture that does the same. */
export interface FileMenuItem {
  label: string;
  hint?: string;
  run: () => void;
}

interface FileContextMenuProps {
  x: number;
  y: number;
  items: FileMenuItem[];
  onClose: () => void;
}

/** The right-click menu of a tree entry; a click elsewhere or Escape closes it. */
export function FileContextMenu({ x, y, items, onClose }: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[170px] rounded-md border border-maestro-border bg-maestro-surface p-1 shadow-lg"
      style={{ left: x, top: y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.run();
          }}
          className="flex w-full items-center rounded-sm px-2 py-1 text-left text-[11px] text-maestro-text hover:bg-maestro-border/80"
        >
          <span className="flex-1">{item.label}</span>
          {item.hint && <span className="pl-3 text-maestro-muted">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
