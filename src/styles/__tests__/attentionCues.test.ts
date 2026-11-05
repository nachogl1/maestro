import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../globals.css"), "utf8");

/** The body of the first rule whose selector line is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf("\n}", start));
}

/** The strongest accent glow (alpha of `--maestro-accent` in a box-shadow) in a CSS block. */
function strongestAccentGlow(block: string): number {
  const alphas = [...block.matchAll(/--maestro-accent\) \/ ([\d.]+)\)/g)].map((m) => Number(m[1]));
  return Math.max(...alphas);
}

/** Every selector list inside `@media (prefers-reduced-motion: reduce)` and the Linux overrides. */
function noAnimationSelectors(): string {
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join("\n");
  const linux = [...css.matchAll(/((?:\.platform-linux [^{]+,?\s*)+)\{\s*animation: none;/g)]
    .map((m) => m[1])
    .join("\n");
  return `${reduced}\n${linux}`;
}

describe("attention cues in globals.css (issue #496)", () => {
  it("glows the needs-input terminal and its parked chip brighter than before", () => {
    // Before issue #496 the strongest needs-input glow was 0.5, the chip's 0.55.
    expect(strongestAccentGlow(ruleBody(".terminal-cell-needs-input"))).toBeGreaterThanOrEqual(0.8);
    expect(strongestAccentGlow(ruleBody("@keyframes parked-attention"))).toBeGreaterThanOrEqual(
      0.8,
    );
  });

  it("blinks the attention tabs, with the rhythm left to the shared-clock inline style", () => {
    const rule = ruleBody(".attention-blink.attention-blink");
    expect(rule).toContain("animation-name: attention-blink;");
    expect(rule).toContain("animation-iteration-count: infinite;");
    // Duration and delay come from useAttentionBlink, so CSS must not fix them.
    expect(rule).not.toMatch(/animation-(duration|delay)|animation:/);
    expect(css).toContain("@keyframes attention-blink");
  });

  it("keeps the no-animation rule for reduced motion and Linux", () => {
    const selectors = noAnimationSelectors();
    expect(selectors).toContain(".attention-blink.attention-blink");
    expect(selectors).toContain(".platform-linux .attention-blink.attention-blink");
  });
});
