import { ChevronDown, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** One tick box in a filter menu. */
export interface IssueMapFilterOption<T extends string> {
  value: T;
  label: string;
  swatch?: React.ReactNode;
  /** Issues of this option still on the map, and in total. */
  shown: number;
  total: number;
  /** Drawn below a divider, after the other options (e.g. "nobody assigned"). */
  apart?: boolean;
}

interface IssueMapFilterMenuProps<T extends string> {
  /** Family name on the button and the menu, e.g. "Who takes it". */
  name: string;
  options: IssueMapFilterOption<T>[];
  /** Unticked values. */
  off: Set<T>;
  onChange: (off: Set<T>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Adds a box to find an option by name; for long lists such as labels. */
  searchable?: boolean;
  /** Short text under the options. */
  note?: string;
}

/** "all", "none" or "ticked/total", for the menu button. */
function summary(on: number, total: number): string {
  if (on === total) return "all";
  if (on === 0) return "none";
  return `${on}/${total}`;
}

/**
 * A button that opens one filter family's tick boxes: each shows shown/total,
 * "only" ticks just that one, and All / None flip the whole family.
 */
export function IssueMapFilterMenu<T extends string>({
  name,
  options,
  off,
  onChange,
  open,
  onOpenChange,
  searchable = false,
  note,
}: IssueMapFilterMenuProps<T>) {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // A press anywhere outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: PointerEvent) => {
      if (!rootRef.current?.contains(ev.target as Node)) onOpenChange(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    searchRef.current?.focus();
  }, [open]);

  const on = options.filter((o) => !off.has(o.value)).length;
  // Blue while something is unticked, so a narrowed family stands out.
  const active = on < options.length;
  let tone = "border-maestro-border bg-maestro-card hover:border-maestro-muted/60";
  if (active) tone = "border-maestro-blue/55 bg-maestro-blue/10";
  if (open) tone = `border-maestro-blue ${active ? "bg-maestro-blue/10" : "bg-maestro-card"}`;
  const toggle = (value: T): void => {
    const next = new Set(off);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const q = query.trim().toLowerCase();
  const matches = options.filter((o) => !q || o.label.toLowerCase().includes(q));
  const main = matches.filter((o) => !o.apart);
  const apart = matches.filter((o) => o.apart);

  const row = (o: IssueMapFilterOption<T>) => {
    const checked = !off.has(o.value);
    return (
      <label
        key={o.value}
        className="group flex cursor-pointer select-none items-center gap-1.5 rounded px-1.5 py-[3px] hover:bg-maestro-card"
      >
        <input
          type="checkbox"
          className="m-0 shrink-0"
          checked={checked}
          onChange={() => toggle(o.value)}
          aria-label={o.label}
        />
        {o.swatch}
        <span
          className={`min-w-0 flex-1 truncate ${checked ? "text-maestro-text" : "text-maestro-muted"}`}
          title={o.label}
        >
          {o.label}
        </span>
        <button
          type="button"
          aria-label={`Only ${o.label}`}
          onClick={(ev) => {
            ev.preventDefault();
            onChange(new Set(options.map((x) => x.value).filter((v) => v !== o.value)));
          }}
          className="hidden text-[11px] text-maestro-blue hover:underline group-hover:inline"
        >
          only
        </button>
        <span className="text-[11px] tabular-nums text-maestro-muted">
          {o.shown}/{o.total}
        </span>
      </label>
    );
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={`flex h-[26px] items-center gap-1.5 rounded-md border pr-1.5 pl-2 text-[12px] text-maestro-text transition-colors ${tone}`}
      >
        {name}
        <span
          className={`text-[11px] tabular-nums ${
            active ? "font-semibold text-maestro-blue" : "text-maestro-muted"
          }`}
        >
          {summary(on, options.length)}
        </span>
        <ChevronDown
          size={12}
          className={`text-maestro-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${name} filter`}
          className="absolute top-[calc(100%+4px)] left-0 z-50 w-[290px] rounded-lg border border-maestro-border bg-maestro-surface p-1.5 text-[12px] shadow-xl"
        >
          <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1.5">
            <b>{name}</b>
            <span className="text-[11px] text-maestro-muted">
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="text-maestro-blue hover:underline"
              >
                All
              </button>
              {" · "}
              <button
                type="button"
                onClick={() => onChange(new Set(options.map((o) => o.value)))}
                className="text-maestro-blue hover:underline"
              >
                None
              </button>
            </span>
          </div>
          {searchable && (
            <div className="relative mx-0.5 mb-1.5">
              <Search
                size={11}
                className="absolute top-1/2 left-2 -translate-y-1/2 text-maestro-muted/60"
              />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(ev) => setQuery(ev.target.value)}
                placeholder={`Find ${name.toLowerCase()}...`}
                aria-label={`Find ${name.toLowerCase()}`}
                className="w-full rounded-md border border-maestro-border bg-maestro-card py-1 pr-2 pl-6 text-[11px] text-maestro-text placeholder:text-maestro-muted/50 focus:border-maestro-accent focus:outline-none"
              />
            </div>
          )}
          <div className="max-h-[300px] overflow-auto">
            {matches.length === 0 && (
              <div className="p-1.5 text-maestro-muted">Nothing matches "{query}".</div>
            )}
            {main.map(row)}
            {main.length > 0 && apart.length > 0 && (
              <div className="mx-0.5 my-1 h-px bg-maestro-border" />
            )}
            {apart.map(row)}
          </div>
          {note && (
            <>
              <div className="mx-0.5 my-1 h-px bg-maestro-border" />
              <p className="m-0 px-1.5 pt-1 pb-0.5 text-[11px] leading-snug text-maestro-muted">
                {note}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
