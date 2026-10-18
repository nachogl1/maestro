/**
 * Shows every collapsible section of the `/insights` report open. The report
 * folds some sections behind a click handler, and the Workshop shows it in a
 * frame where no script runs, so without this they could never be opened.
 */
const OPEN_SECTIONS_STYLE =
  "<style>.collapsible-content{display:block}" +
  ".collapsible-arrow{transform:rotate(90deg)}</style>";

/** The report HTML with every collapsible section shown open. */
export function withSectionsOpen(html: string): string {
  const headEnd = html.search(/<\/head>/i);
  if (headEnd === -1) return OPEN_SECTIONS_STYLE + html;
  return html.slice(0, headEnd) + OPEN_SECTIONS_STYLE + html.slice(headEnd);
}

/** Whether a run is due at `now` (epoch ms); a null next run means it never ran. */
export function isDue(nextRunAt: string | null, now: number): boolean {
  return nextRunAt === null || Date.parse(nextRunAt) <= now;
}

/** A run time for the panel, e.g. "Sat, 18 Oct 2026, 09:00", in the user's locale. */
export function formatWorkshopTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
