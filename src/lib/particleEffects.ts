/**
 * Tiny event bus for the short particle animations drawn over the UI
 * (see `ParticleEffectsLayer`). Emitters only name the session and what
 * happened; the layer resolves the on-screen elements and draws the effect.
 *
 * Kept free of DOM and three.js so stores can emit from anywhere (including
 * tests) without pulling in the renderer.
 */

export type ParticleEffectKind =
  /** A terminal was parked: its pane dissolves into the parked-shelf chip. */
  | "park"
  /** A parked terminal was restored: the chip flows back into the pane. */
  | "resume"
  /** The agent started waiting for the user: a flare around the pane. */
  | "attention";

export interface ParticleEffect {
  kind: ParticleEffectKind;
  sessionId: number;
}

type Listener = (effect: ParticleEffect) => void;

const listeners = new Set<Listener>();

/** Fire an effect. A no-op when nothing is listening (e.g. in tests). */
export function emitParticleEffect(effect: ParticleEffect): void {
  for (const listener of listeners) listener(effect);
}

/** Listen for effects. Returns the unsubscribe function. */
export function subscribeParticleEffects(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
