import { samePath } from "@/lib/path";
import type { OfferedTerminal } from "@/stores/useOpenTerminalsSnapshotStore";

/** The warning line under a terminal that came back without its earlier content. */
export const RECOVERY_WARNING_TEXT =
  "Brought back after Maestro stopped. Its earlier content could not be retrieved.";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Fri 13 Nov, 18:42" in local time — when the list was last saved. */
export function formatStopTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
}

/** Last path segment: the project's name as its tab shows it. */
export function projectNameOf(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** One project's rows in the dialog, each with its place in the full list. */
export interface RecoveryProjectGroup {
  projectPath: string;
  name: string;
  rows: Array<{ index: number; terminal: OfferedTerminal }>;
}

/**
 * The dialog's rows, grouped by project in the order the list has them;
 * Samurai terminals are left out (the dialog only counts them).
 */
export function groupByProject(terminals: OfferedTerminal[]): RecoveryProjectGroup[] {
  const groups: RecoveryProjectGroup[] = [];
  terminals.forEach((terminal, index) => {
    if (terminal.samurai) return;
    let group = groups.find((g) => samePath(g.projectPath, terminal.projectPath));
    if (!group) {
      group = {
        projectPath: terminal.projectPath,
        name: projectNameOf(terminal.projectPath),
        rows: [],
      };
      groups.push(group);
    }
    group.rows.push({ index, terminal });
  });
  return groups;
}

/** The right-hand text of a row: what comes back, or why it cannot. */
export function whatComesBack(terminal: OfferedTerminal): string {
  if (!terminal.folderExists) return "folder no longer exists";
  if (terminal.kind === "Plain") return "reopens empty";
  return terminal.conversationFound && terminal.conversationId
    ? "conversation continues"
    : "conversation not found, opens new";
}

/** The line under the list counting Samurai runs, or null when there are none. */
export function samuraiLine(terminals: OfferedTerminal[]): string | null {
  const count = terminals.filter((t) => t.samurai).length;
  if (count === 0) return null;
  return count === 1
    ? "1 Samurai run is not listed here. Recover it from the Launch panel."
    : `${count} Samurai runs are not listed here. Recover them from the Launch panel.`;
}
