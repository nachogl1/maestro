import { useEffect, useRef } from "react";
import { emitParticleEffect, subscribeParticleEffects } from "@/lib/particleEffects";
import { createParticleEngine, type ParticleEngine } from "@/lib/particleEngine";
import { useSessionStore } from "@/stores/useSessionStore";

/**
 * Full-window, click-through canvas that draws short particle effects over the
 * terminals: a pane dissolving into its parked-shelf chip, a chip flowing back
 * into its pane, and a flare around a pane whose agent just asked for input.
 *
 * Park/resume effects arrive through the `particleEffects` bus (emitted by the
 * session store). The attention flare is derived here from the store: a session
 * whose status flips to `NeedsInput` while its pane is on screen.
 *
 * Mounted once at the app root. Honours `prefers-reduced-motion` by drawing
 * nothing at all; the canvas stays `display:none` between effects.
 */
export function ParticleEffectsLayer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const engine: ParticleEngine = createParticleEngine(canvas);
    const unsubscribeBus = subscribeParticleEffects((effect) => engine.play(effect));

    const unsubscribeStore = useSessionStore.subscribe((state, prev) => {
      if (state.sessions === prev.sessions) return;
      for (const session of state.sessions) {
        if (session.status !== "NeedsInput") continue;
        const before = prev.sessions.find((s) => s.id === session.id);
        // Only a real transition flares: a brand-new session that starts in
        // NeedsInput (e.g. restored from history) has no pane change to announce.
        if (!before || before.status === "NeedsInput") continue;
        if (state.parkedSessionIds.includes(session.id)) continue;
        emitParticleEffect({ kind: "attention", sessionId: session.id });
      }
    });

    return () => {
      unsubscribeBus();
      unsubscribeStore();
      engine.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="particle-effects-layer"
      className="pointer-events-none fixed inset-0 h-full w-full"
      style={{ display: "none", zIndex: 70 }}
    />
  );
}
