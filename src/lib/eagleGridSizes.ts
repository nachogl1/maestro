/**
 * Track sizes for the eagle view grid. Each column (and each row) has a
 * weight; the grid gives it that many `fr` of the free space. Dragging the gap
 * between two tracks moves weight from one to the other, so the rest of the
 * grid keeps its size.
 */

/** Smallest share of a dragged pair either track can shrink to (same as split panes). */
export const MIN_PAIR_SHARE = 0.15;

/** `count` equal weights. */
export function equalWeights(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, () => 1);
}

/**
 * The weights to lay out `count` tracks with: the stored ones while they still
 * match the track count, otherwise equal sizes (a column or row was added or
 * removed, so the old sizes no longer map onto the grid).
 */
export function resolveWeights(stored: readonly number[], count: number): number[] {
  if (stored.length === count && stored.every((w) => Number.isFinite(w) && w > 0)) {
    return [...stored];
  }
  return equalWeights(count);
}

/** CSS track list for the weights, e.g. `minmax(0, 1fr) minmax(0, 2fr)`. */
export function trackTemplate(weights: readonly number[]): string {
  return weights.map((w) => `minmax(0, ${w}fr)`).join(" ");
}

/**
 * Moves the boundary after track `index` by `deltaPx`, given the pixel space
 * the tracks share (`availablePx`, gaps excluded). Only tracks `index` and
 * `index + 1` change; the pair's total stays the same, and neither track
 * drops below `MIN_PAIR_SHARE` of it.
 */
export function dragBoundary(
  weights: readonly number[],
  index: number,
  deltaPx: number,
  availablePx: number,
): number[] {
  if (index < 0 || index + 1 >= weights.length || availablePx <= 0) return [...weights];
  const total = weights.reduce((sum, w) => sum + w, 0);
  const pair = weights[index] + weights[index + 1];
  const min = pair * MIN_PAIR_SHARE;
  const delta = (deltaPx * total) / availablePx;
  const first = Math.min(pair - min, Math.max(min, weights[index] + delta));
  const next = [...weights];
  next[index] = first;
  next[index + 1] = pair - first;
  return next;
}

/**
 * Pixel offset of the middle of the gap after each track but the last,
 * measured from the start of the first track.
 */
export function boundaryOffsets(
  weights: readonly number[],
  availablePx: number,
  gapPx: number,
): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return [];
  const offsets: number[] = [];
  let pos = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    pos += (weights[i] / total) * availablePx;
    offsets.push(pos + i * gapPx + gapPx / 2);
  }
  return offsets;
}
