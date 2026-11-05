import { arrayMove } from "@dnd-kit/sortable";
import { create } from "zustand";

/**
 * The order the user dragged the parked-shelf pills into (issue #495).
 *
 * Kept for the app session only: terminal ids change on every launch, so a
 * saved order would point at nothing after a restart. One list serves every
 * shelf (each project's and the eagle view's shared one); a shelf shows its
 * own pills in the order they appear here.
 */
interface ParkedOrderState {
  /** Session ids in the user's chosen order. Empty until the first drag. */
  order: number[];
  /**
   * Drop `activeId` onto `overId`'s place among `shownIds` (the ids one shelf
   * shows, in the order it shows them). Pills the shelf does not show keep
   * their places in the list. `parkedIds` is every parked id in its natural
   * order, so the first drag in one project's shelf also places the others.
   */
  move: (shownIds: number[], activeId: number, overId: number, parkedIds: number[]) => void;
  /**
   * Follow the parked set: an unparked id is forgotten, and once the user has
   * arranged the pills, a newly parked one joins the end.
   */
  syncParked: (parkedIds: number[]) => void;
}

export const useParkedOrderStore = create<ParkedOrderState>((set) => ({
  order: [],

  move: (shownIds, activeId, overId, parkedIds) =>
    set((state) => {
      const from = shownIds.indexOf(activeId);
      const to = shownIds.indexOf(overId);
      if (from === -1 || to === -1 || from === to) return state;
      const arranged = arrayMove(shownIds, from, to);
      const shown = new Set(shownIds);
      // Every pill in the order the eagle shelf shows it (see sortByParkedOrder),
      // so the shown ids sit in it in the order this shelf shows them; refill
      // exactly those slots so every other shelf's pills stay put.
      const unplaced = [...parkedIds, ...shownIds].filter((id) => !state.order.includes(id));
      const base = [...state.order, ...new Set(unplaced)];
      let next = 0;
      return { order: base.map((id) => (shown.has(id) ? arranged[next++] : id)) };
    }),

  syncParked: (parkedIds) =>
    set((state) => {
      if (state.order.length === 0) return state;
      const kept = state.order.filter((id) => parkedIds.includes(id));
      const newcomers = parkedIds.filter((id) => !kept.includes(id));
      if (newcomers.length === 0 && kept.length === state.order.length) return state;
      return { order: [...kept, ...newcomers] };
    }),
}));

/**
 * `items` in the user's chosen order; ids the order does not hold yet follow
 * in their own order (the sort is stable).
 */
export function sortByParkedOrder<T extends { id: number }>(items: T[], order: number[]): T[] {
  const rank = (id: number): number => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  return [...items].sort((a, b) => rank(a.id) - rank(b.id));
}
