import { arraySwap } from "@dnd-kit/sortable";

/**
 * `ids` with `activeId` and `overId` traded places: a tab dropped onto another
 * swaps with it, and every other id keeps its slot (issue #555). Null when the
 * two are the same or either is missing.
 */
export function swapIds<T>(ids: readonly T[], activeId: T, overId: T): T[] | null {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return null;
  return arraySwap([...ids], from, to);
}
