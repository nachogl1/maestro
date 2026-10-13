/**
 * Deterministic per-project accent color.
 *
 * The color is derived purely from the project name, so the same project
 * always gets the same color — across sessions, restarts and machines.
 * Used to color-code every terminal that belongs to a project: its cell border,
 * its label in the tab strips and the parked shelf.
 *
 * The whole hue circle is available, red included. Status is no longer carried
 * by color alone — the three-dot ThinkingIndicator (blue = working, red =
 * needs your input) is what reports what a terminal is doing — so reserving red
 * for status would cost a tenth of the palette for nothing.
 */

/**
 * Ideal minimum separation between two project hues (circular degrees). At the
 * fixed saturation/lightness, hues closer than this are hard to tell apart at a
 * glance. It is a target, not a guarantee: with more than 360/30 = 12 projects
 * open, {@link resolveProjectColors} spreads them as far apart as the circle
 * allows instead of giving two projects the same color.
 */
const HUE_CLASH_DISTANCE = 30;

/**
 * Probe step used to re-seat a clashing hue. 137° ≈ the golden angle, which
 * spreads successive probes evenly around the circle and shares no factor with
 * 360 beyond 1, so repeated probing keeps landing on fresh hues.
 */
const HUE_PROBE_STEP = 137;

/** Bounded so pathological sets (many near-identical names) can't loop long. */
const MAX_PROBES = 24;

/** Wrap an arbitrary offset into [0, 360). */
function wrapHue(offset: number): number {
  return ((offset % 360) + 360) % 360;
}

function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return wrapHue(hash);
}

function hslFor(hue: number): string {
  return `hsl(${hue} 70% 55%)`;
}

/** Circular distance between two hues, in degrees (0..180). */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Distance from `hue` to the nearest already-claimed hue (Infinity if none). */
function nearestClaimed(hue: number, claimed: number[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const taken of claimed) {
    const d = hueDistance(taken, hue);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

/**
 * Maps a project name to a stable HSL color.
 *
 * Hash → hue; saturation/lightness are fixed to values that read well as
 * borders and bold text on the dark theme.
 *
 * Prefer {@link resolveProjectColors} when the full set of open projects is
 * known — it keeps this mapping but re-seats colors that would clash. Two
 * unrelated names can hash to the same hue, so this function alone does not
 * guarantee distinct colors.
 */
export function projectColorFor(name: string): string {
  return hslFor(hueFor(name));
}

/**
 * Assigns a color to every project name, keeping the deterministic
 * name → color rule but guaranteeing that no two *different* names share one.
 *
 * Names are processed in sorted order (independent of tab order), each claiming
 * its hash hue. A hue within {@link HUE_CLASH_DISTANCE} of one already claimed
 * is re-seated by deterministic golden-angle probing. If probing runs out —
 * which it must once the circle is crowded — the name takes the hue furthest
 * from every claimed one, scanning whole degrees in order. That final step is
 * what turns "usually distinct" into "always distinct": the old code gave up
 * after 24 probes and accepted a duplicate hue.
 *
 * Stable for a given set of open projects (no per-render randomness); identical
 * names still intentionally share one color.
 */
export function resolveProjectColors(names: Iterable<string>): Map<string, string> {
  const unique = Array.from(new Set(names)).sort();
  const claimed: number[] = [];
  const colors = new Map<string, string>();

  for (const name of unique) {
    let hue = hueFor(name);
    let probes = 0;
    while (probes < MAX_PROBES && nearestClaimed(hue, claimed) < HUE_CLASH_DISTANCE) {
      hue = wrapHue(hue + HUE_PROBE_STEP);
      probes++;
    }

    // Still clashing: take the emptiest spot on the circle rather than double up.
    if (nearestClaimed(hue, claimed) < HUE_CLASH_DISTANCE) {
      let bestHue = hue;
      let bestGap = -1;
      for (let candidate = 0; candidate < 360; candidate++) {
        const gap = nearestClaimed(candidate, claimed);
        if (gap > bestGap) {
          bestGap = gap;
          bestHue = candidate;
        }
      }
      hue = bestHue;
    }

    claimed.push(hue);
    colors.set(name, hslFor(hue));
  }

  return colors;
}
