# PRD: Particle effects for park, resume and needs-input

**Status:** implemented (2026-10-15)
**Prototype:** `Downloads/maestro-threejs-prototypes/04-handoff-particles.html` (chosen by the user out of four three.js prototypes)

## Problem

Maestro's state changes are quiet. A terminal parked to the shelf just disappears from the grid, a restored one just reappears, and an agent that stops to ask a question only changes a small coloured dot and a border. In a wall of tiles these moments are easy to miss, and the three rippling status dots that tried to compensate were visual noise the user explicitly wanted gone.

## Goals

1. Make three moments visible from across the room, for under 1.2 s each:
   - **Park**: the pane dissolves into its shelf chip in a stream of particles.
   - **Resume**: the chip streams back into the restored pane.
   - **Needs input**: sparks leave the pane's border outwards (yellow, like the prototype).
2. Remove the three rippling "thinking" dots from terminal tabs, title bars and parked-shelf chips (including the parked state). The single status dot on tabs and the coloured title-bar underline remain the always-on state signal.
3. Zero cost when idle, no layout changes, reduced-motion respected.

## Non-goals

- Handoff (gen 1 → gen 2) animation: the prototype had one, the user did not pick it.
- Ambient backgrounds, 3D status gems, fleet orbit (prototypes 1–3): not chosen.
- Sound, haptics, or any effect on the terminal content itself.

## Design

- `src/lib/particleEffects.ts`: a tiny event bus (`park` | `resume` | `attention`, by session id). The session store emits `park`/`resume` from `parkSession`/`unparkSession`, **before** it changes state so the pane or chip can still be measured.
- `src/lib/particleEngine.ts`: three.js renderer with a pixel-space orthographic camera on a full-window canvas, so DOM rectangles map 1:1 to particle positions. Lazy-imports `three` on the first effect; the render loop runs only while particles are alive and the canvas is `display:none` in between, so the compositor has no extra layer to blend over the terminals. Falls back to a window-centre / bottom-centre target when the destination element has not been committed by React within 300 ms.
- `src/components/shared/ParticleEffectsLayer.tsx`: mounted once in `App`, owns the canvas, subscribes to the bus, and derives the `attention` flare from the session store (status flips to `NeedsInput` while the pane is on screen and not parked). Draws nothing under `prefers-reduced-motion: reduce`.
- Anchors: panes already carry `data-session-id` (TerminalGrid pane wrapper); shelf chips gained `data-parked-session-id`.
- Colours: park/resume use the pane's project colour (read from its `.terminal-cell` border), with white sparks; attention uses yellow + white.

## Risks and mitigations

- **Bundle size**: three.js is its own chunk (~190 KB gzipped, measured by `npm run build`), loaded lazily on the first effect, not at start-up.
- **GPU contention with xterm's WebGL**: one extra context, hidden when idle; verified by tests that the canvas starts hidden and disposes on unmount. A live Tauri check is still owed.
- **Dots removal**: `ThinkingIndicator` still exists for the agent graph; only tabs, title bars and the shelf lost it.

## Verification

- Unit tests: bus, engine helpers, store emit ordering, layer behaviour (hidden canvas, forwarding, one flare per transition, parked/new sessions silent, dispose).
- `npm run test`, `npm run build`, Biome check green before merge.
