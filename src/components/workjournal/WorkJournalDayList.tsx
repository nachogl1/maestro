import type { JSONContent } from "@tiptap/react";
import { isWeekend } from "@/lib/workJournalDates";
import type { WorkJournalPage } from "@/stores/useWorkJournalStore";

/** The body text a weekend page starts with (see `WEEKEND_PAGE_BODY`). */
const WEEKEND_TEXT = "Weekend";

/** The text of every line (paragraph, heading, list item line) of a page body. */
function lineTexts(node: JSONContent, out: string[] = []): string[] {
  const children = node.content ?? [];
  if (children.some((child) => child.type === "text" || child.type === "hardBreak")) {
    out.push(children.map((child) => child.text ?? "").join(""));
    return out;
  }
  if (children.length === 0 && node.type !== "doc") {
    out.push("");
    return out;
  }
  for (const child of children) lineTexts(child, out);
  return out;
}

/** How many non-empty lines a page body has: its entries. */
export function countWorkJournalEntries(body: JSONContent): number {
  return lineTexts(body).filter((line) => line.trim() !== "").length;
}

/**
 * The short status under a day's title: pending suggestions first, then
 * "Weekend" for a weekend page still holding only its placeholder, else the
 * number of entries.
 */
export function workJournalDayStatus(page: WorkJournalPage, pendingSuggestions: number): string {
  if (pendingSuggestions > 0) {
    return pendingSuggestions === 1 ? "1 suggestion" : `${pendingSuggestions} suggestions`;
  }
  const lines = lineTexts(page.body).filter((line) => line.trim() !== "");
  if (isWeekend(page.date) && lines.every((line) => line.trim() === WEEKEND_TEXT)) {
    return WEEKEND_TEXT;
  }
  if (lines.length === 0) return "No entries";
  return lines.length === 1 ? "1 entry" : `${lines.length} entries`;
}

export interface WorkJournalDayListProps {
  pages: Record<string, WorkJournalPage>;
  /** The day shown on the right; its row is highlighted. */
  viewedDate: string | null;
  /** Pending suggestions per date, for the dates whose suggestions are loaded. */
  pendingByDate: Record<string, number>;
  onSelect: (date: string) => void;
}

/**
 * The pop-out window's day list: every page, newest first, with its title
 * and a short status. Weekend pages are dimmed.
 */
export function WorkJournalDayList({
  pages,
  viewedDate,
  pendingByDate,
  onSelect,
}: WorkJournalDayListProps) {
  const dates = Object.keys(pages).sort().reverse();
  return (
    <nav
      aria-label="Days"
      className="w-[200px] shrink-0 overflow-y-auto border-r border-maestro-border"
    >
      {dates.length === 0 && <p className="px-3 py-2 text-xs text-maestro-muted/60">No pages</p>}
      <ul>
        {dates.map((date) => {
          const page = pages[date];
          const current = date === viewedDate;
          return (
            <li key={date}>
              <button
                type="button"
                onClick={() => onSelect(date)}
                aria-current={current ? "date" : undefined}
                data-weekend={isWeekend(date) || undefined}
                className={`block w-full border-b border-maestro-border/60 px-2.5 py-1.5 text-left transition-colors hover:bg-maestro-card ${
                  current ? "border-l-2 border-l-maestro-accent bg-maestro-card" : ""
                } ${isWeekend(date) ? "opacity-50" : ""}`}
              >
                <span className="block truncate text-xs text-maestro-text">{page.title}</span>
                <span className="block text-[11px] text-maestro-muted">
                  {workJournalDayStatus(page, pendingByDate[date] ?? 0)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
