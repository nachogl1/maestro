/**
 * Shared display formatters: relative ages ("3m ago") and byte sizes ("4 KB").
 *
 * Call sites disagree on small details (casing, rounding, units), and each one's
 * visible text is deliberate, so those details are options here rather than
 * being unified away.
 */

export interface AgeOptions {
  /** `floor` truncates each unit (default); `nearest` rounds it. */
  rounding?: "floor" | "nearest";
  /** Past a week, read in weeks / months / years ("2w ago", "3mo ago", "1y ago"). */
  longUnits?: boolean;
  /** "Just now" instead of "just now". */
  capitalize?: boolean;
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" for an elapsed time in ms. */
export function formatAgeMs(diffMs: number, options: AgeOptions = {}): string {
  const { rounding = "floor", longUnits = false, capitalize = false } = options;
  const round = rounding === "nearest" ? Math.round : Math.floor;
  const minutes = round(diffMs / 60_000);
  if (minutes < 1) return capitalize ? "Just now" : "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = round(hours / 24);
  if (longUnits) {
    const years = Math.floor(days / 365);
    if (years > 0) return `${years}y ago`;
    const months = Math.floor(days / 30);
    if (months > 0) return `${months}mo ago`;
    const weeks = Math.floor(days / 7);
    if (weeks > 0) return `${weeks}w ago`;
  }
  return `${days}d ago`;
}

/** Age of an epoch-ms timestamp; "never" when there is none. */
export function formatTimeAgo(timestamp: number | null, options: AgeOptions = {}): string {
  if (!timestamp) return options.capitalize ? "Never" : "never";
  return formatAgeMs(Date.now() - timestamp, options);
}

/** Age of an ISO / RFC 3339 time; empty when missing or unparsable. */
export function formatIsoAge(iso: string | null, options: AgeOptions = {}): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  return formatAgeMs(Date.now() - then, options);
}

export interface BytesOptions {
  /**
   * `B` (default): "800 B" below 1 KB. `KB`: never below "1 KB" for anything
   * non-empty, and "0 KB" reserved for genuinely zero bytes.
   */
  minUnit?: "B" | "KB";
  /** `MB` (default): "1.2 MB" from 1 MiB up. `KB`: stay in KB. */
  maxUnit?: "KB" | "MB";
}

/** "6.2 MB" / "12 KB" / "800 B", bounded by the given units. */
export function formatBytes(bytes: number, options: BytesOptions = {}): string {
  const { minUnit = "B", maxUnit = "MB" } = options;
  if (maxUnit === "MB" && bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (minUnit === "KB") {
    if (bytes <= 0) return "0 KB";
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** GiB as a bare number ("12" / "7.5") — the caller appends the unit. */
export function formatGiB(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? gb.toFixed(0) : gb.toFixed(1);
}
