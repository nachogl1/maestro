/** One day of the changelog shown in Settings → Changelog: every line written that day, newest first. */
export interface ChangelogEntry {
  date: string;
  items: string[];
}

/** `docs/changelog/<YYYY-MM-DD>-<branch>.md`: the day it was written, then the branch name. */
const ENTRY_FILE = /(?:^|\/)(\d{4}-\d{2}-\d{2})-[^/]+\.md$/;

function descending(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

/** The first non-empty line of a changelog file, without a leading list marker. */
function firstLine(raw: string): string {
  const line = raw.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().replace(/^[-*]\s+/, "");
}

/**
 * Groups orion-style changelog files (one line per pull request, named by day and branch) by day, newest
 * first; within a day the files sort by name in reverse, as the folder's README says. Files that do not
 * follow the naming (the README) or hold no text are left out.
 */
export function buildChangelog(files: Record<string, string>): ChangelogEntry[] {
  const byDate = new Map<string, { name: string; line: string }[]>();
  for (const [path, raw] of Object.entries(files)) {
    const match = ENTRY_FILE.exec(path);
    if (!match) continue;
    const line = firstLine(raw);
    if (!line) continue;
    const date = match[1];
    const list = byDate.get(date) ?? [];
    list.push({ name: path.slice(path.lastIndexOf("/") + 1), line });
    byDate.set(date, list);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => descending(a, b))
    .map(([date, list]) => ({
      date,
      items: list.sort((a, b) => descending(a.name, b.name)).map((file) => file.line),
    }));
}

/** Every file under docs/changelog/, read at build time so the app ships its own release notes. */
const CHANGELOG_FILES = import.meta.glob("../../docs/changelog/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Newest first. */
export const CHANGELOG: ChangelogEntry[] = buildChangelog(CHANGELOG_FILES);
