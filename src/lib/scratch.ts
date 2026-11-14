import { normalizePath, samePath } from "@/lib/path";

/** Month names as the default scratch name spells them. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The name box's ready default, e.g. `scratch-13-nov-1822` for 13 Nov at 18:22. */
export function defaultScratchName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const month = MONTHS[now.getMonth()];
  return `scratch-${now.getDate()}-${month}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** How old a scratch project is, as the pill's list shows it: `now`, `5 min`, `3 h`, `2 d`. */
export function formatScratchAge(createdAtMs: number, nowMs: number): string {
  const age = Math.max(0, nowMs - createdAtMs);
  if (age < MINUTE_MS) return "now";
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)} min`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)} h`;
  return `${Math.floor(age / DAY_MS)} d`;
}

/**
 * True when `path` is a scratch project: a direct subfolder of the scratch
 * folder. Compared after normalizing (slashes, `\\?\`, letter case), the way
 * project paths are compared everywhere else.
 */
export function isScratchPath(path: string, scratchFolder: string | null): boolean {
  if (!scratchFolder) return false;
  const child = normalizePath(path);
  const cut = child.lastIndexOf("/");
  if (cut <= 0) return false;
  return child.slice(0, cut) === normalizePath(scratchFolder);
}

/**
 * True when `path` is a scratch project Maestro made: a direct subfolder of the
 * scratch folder that the backend listed. The backend lists only folders that
 * carry Maestro's marker file, so a real folder that happens to sit in the
 * scratch folder never counts.
 */
export function isScratchProject(
  path: string,
  scratchFolder: string | null,
  listed: ReadonlyArray<{ path: string }>,
): boolean {
  return isScratchPath(path, scratchFolder) && listed.some((p) => samePath(p.path, path));
}
