/**
 * WebGL particle engine behind `ParticleEffectsLayer`.
 *
 * Draws three short effects over the real UI using a full-window canvas with
 * a pixel-space orthographic camera, so DOM rectangles map 1:1 to particle
 * coordinates:
 *
 *  - park:      particles across a terminal pane converge on its shelf chip.
 *  - resume:    particles stream from the shelf chip back into the pane.
 *  - attention: a flare of sparks leaves the pane's border outwards.
 *
 * three.js is imported lazily on the first effect, so it costs nothing at
 * start-up, and the animation loop only runs while particles are alive; the
 * canvas is hidden in between so the compositor has no extra layer to blend.
 */

import type { ParticleEffect } from "./particleEffects";

type Rgb = [number, number, number];

/** Where particles start or end: a point plus the element's box. */
interface Anchor {
  x: number;
  y: number;
  rect: DOMRect;
}

interface SpawnOptions {
  sx: number;
  sy: number;
  cx?: number;
  cy?: number;
  ex?: number;
  ey?: number;
  delay?: number;
  dur?: number;
  mode?: 0 | 1;
  vx?: number;
  vy?: number;
  life?: number;
  size?: number;
  c: Rgb;
  burst?: boolean;
}

const MAX = 3000;
const MODE_FLY = 0;
const MODE_DRIFT = 1;

export const COLORS: Record<"white" | "purple" | "yellow", Rgb> = {
  white: [0.95, 0.95, 1],
  purple: [0.74, 0.55, 1],
  yellow: [0.92, 0.7, 0.03],
};

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** `rgb(r, g, b)` from `getComputedStyle` → 0..1 triple; null when unparseable. */
export function parseCssRgb(value: string): Rgb | null {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!m) return null;
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
}

/** Selector for the pane of a session (set on TerminalView's cell root). */
export function paneSelector(sessionId: number): string {
  return `[data-particle-session-id="${sessionId}"]`;
}

/** Selector for the parked-shelf chip of a session (set by ParkedShelf). */
export function chipSelector(sessionId: number): string {
  return `[data-parked-session-id="${sessionId}"]`;
}

/**
 * Centre and box of an element that is actually on screen, or null. Hidden
 * panes hide two ways (see useTerminalDragDrop): `display:none` stacks report a
 * zero rect, while zoom-obscured tiles are `visibility:hidden` and keep a full
 * rect, so both are rejected — otherwise sparks burst over the zoomed terminal.
 */
export function anchorOf(el: Element | null): Anchor | null {
  if (!el) return null;
  if (getComputedStyle(el).visibility === "hidden") return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
}

/**
 * Resolve an element that React has not committed yet (the shelf chip after a
 * park, the pane after a resume): poll a few frames, then fall back.
 */
function resolveLater(selector: string, fallback: Anchor, maxMs = 300): Promise<Anchor> {
  return new Promise((resolve) => {
    const start = performance.now();
    const poll = (): void => {
      const found = anchorOf(document.querySelector(selector));
      if (found) {
        resolve(found);
      } else if (performance.now() - start > maxMs) {
        resolve(fallback);
      } else {
        requestAnimationFrame(poll);
      }
    };
    poll();
  });
}

/** Project colour of a pane (its `.terminal-cell` border), or null. */
function paneColor(pane: Element | null): Rgb | null {
  const cell = pane?.querySelector(".terminal-cell") ?? pane;
  if (!cell) return null;
  return parseCssRgb(getComputedStyle(cell).borderColor);
}

type Three = typeof import("three");

export interface ParticleEngine {
  /** Capture what the effect needs from the DOM now, then animate. */
  play: (effect: ParticleEffect) => void;
  dispose: () => void;
}

export function createParticleEngine(canvas: HTMLCanvasElement): ParticleEngine {
  let three: Three | null = null;
  let loading: Promise<Three | null> | null = null;
  let disposed = false;

  // Renderer state, created once three.js has loaded.
  let renderer: import("three").WebGLRenderer | null = null;
  let scene: import("three").Scene | null = null;
  let camera: import("three").OrthographicCamera | null = null;
  let geo: import("three").BufferGeometry | null = null;

  // Structure-of-arrays particle pool.
  const P = {
    n: 0,
    alive: new Uint8Array(MAX),
    x: new Float32Array(MAX),
    y: new Float32Array(MAX),
    sx: new Float32Array(MAX),
    sy: new Float32Array(MAX),
    cx: new Float32Array(MAX),
    cy: new Float32Array(MAX),
    ex: new Float32Array(MAX),
    ey: new Float32Array(MAX),
    t0: new Float32Array(MAX),
    dur: new Float32Array(MAX),
    mode: new Uint8Array(MAX),
    vx: new Float32Array(MAX),
    vy: new Float32Array(MAX),
    life: new Float32Array(MAX),
    size: new Float32Array(MAX),
    r: new Float32Array(MAX),
    g: new Float32Array(MAX),
    b: new Float32Array(MAX),
    burst: new Uint8Array(MAX),
  };
  const pos = new Float32Array(MAX * 3);
  const col = new Float32Array(MAX * 3);
  const sz = new Float32Array(MAX);
  const al = new Float32Array(MAX);

  let now = performance.now();
  let last = now;
  let raf = 0;
  let running = false;

  function ensureThree(): Promise<Three | null> {
    if (three) return Promise.resolve(three);
    if (!loading) {
      loading = import("three")
        .then((mod) => {
          if (disposed) return null;
          three = mod;
          setupRenderer(mod);
          return mod;
        })
        .catch((err) => {
          console.error("Particle effects: three.js failed to load:", err);
          return null;
        });
    }
    return loading;
  }

  function setupRenderer(T: Three): void {
    try {
      // No depth buffer: the material never reads or writes depth.
      renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, depth: false });
    } catch (err) {
      console.error("Particle effects: WebGL unavailable:", err);
      renderer = null;
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    scene = new T.Scene();
    camera = new T.OrthographicCamera(0, 1, 0, 1, -10, 10);
    camera.position.z = 5;
    geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    geo.setAttribute("aColor", new T.BufferAttribute(col, 3));
    geo.setAttribute("aSize", new T.BufferAttribute(sz, 1));
    geo.setAttribute("aAlpha", new T.BufferAttribute(al, 1));
    const mat = new T.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: T.AdditiveBlending,
      uniforms: { uPR: { value: renderer.getPixelRatio() } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        varying vec3 vC; varying float vA; uniform float uPR;
        void main() {
          vC = aColor; vA = aAlpha; gl_PointSize = aSize * uPR;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard;
          gl_FragColor = vec4(vC, smoothstep(0.5, 0.05, r) * vA);
        }`,
    });
    scene.add(new T.Points(geo, mat));
    resize();
  }

  function resize(): void {
    if (!renderer || !camera) return;
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.right = window.innerWidth;
    camera.bottom = window.innerHeight;
    camera.updateProjectionMatrix();
  }

  function spawn(o: SpawnOptions): void {
    let i = P.n < MAX ? P.n++ : -1;
    if (i < 0) {
      for (let k = 0; k < MAX; k++) {
        if (!P.alive[k]) {
          i = k;
          break;
        }
      }
      if (i < 0) return;
    }
    P.alive[i] = 1;
    P.sx[i] = P.x[i] = o.sx;
    P.sy[i] = P.y[i] = o.sy;
    P.cx[i] = o.cx ?? o.sx;
    P.cy[i] = o.cy ?? o.sy;
    P.ex[i] = o.ex ?? o.sx;
    P.ey[i] = o.ey ?? o.sy;
    P.t0[i] = now + (o.delay ?? 0);
    P.dur[i] = o.dur ?? 800;
    P.mode[i] = o.mode ?? MODE_FLY;
    P.vx[i] = o.vx ?? 0;
    P.vy[i] = o.vy ?? 0;
    P.life[i] = o.life ?? 500;
    P.size[i] = o.size ?? 4;
    P.r[i] = o.c[0];
    P.g[i] = o.c[1];
    P.b[i] = o.c[2];
    P.burst[i] = o.burst ? 1 : 0;
  }

  function start(): void {
    if (running || !renderer) return;
    running = true;
    canvas.style.display = "block";
    resize();
    window.addEventListener("resize", resize);
    now = last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function stop(): void {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    canvas.style.display = "none";
    // The drawing buffers keep their size while idle: shrinking them and
    // growing them back on every effect coincided with whole-screen white
    // flashes on Windows.
    P.n = 0;
  }

  function tick(t: number): void {
    if (!renderer || !scene || !camera || !geo) return;
    now = t;
    const dt = Math.min(t - last, 50);
    last = t;
    let aliveCount = 0;
    for (let i = 0; i < P.n; i++) {
      if (!P.alive[i]) {
        al[i] = 0;
        continue;
      }
      let a = 1;
      if (P.mode[i] === MODE_FLY) {
        const u = (t - P.t0[i]) / P.dur[i];
        if (u < 0) {
          al[i] = 0;
          aliveCount++;
          continue;
        }
        if (u >= 1) {
          if (P.burst[i]) {
            // Arrived: scatter briefly instead of vanishing.
            P.mode[i] = MODE_DRIFT;
            P.burst[i] = 0;
            P.t0[i] = t;
            P.life[i] = rnd(300, 600);
            const an = Math.random() * Math.PI * 2;
            const sp = rnd(0.8, 3);
            P.vx[i] = Math.cos(an) * sp;
            P.vy[i] = Math.sin(an) * sp;
          } else {
            P.alive[i] = 0;
            al[i] = 0;
            continue;
          }
        } else {
          const e = ease(u);
          const m = 1 - e;
          P.x[i] = m * m * P.sx[i] + 2 * m * e * P.cx[i] + e * e * P.ex[i];
          P.y[i] = m * m * P.sy[i] + 2 * m * e * P.cy[i] + e * e * P.ey[i];
          a = Math.min(1, u * 4) * Math.min(1, (1 - u) * 3 + 0.3);
        }
      }
      if (P.mode[i] === MODE_DRIFT) {
        const u = (t - P.t0[i]) / P.life[i];
        if (u >= 1) {
          P.alive[i] = 0;
          al[i] = 0;
          continue;
        }
        P.x[i] += (P.vx[i] * dt) / 16.7;
        P.y[i] += (P.vy[i] * dt) / 16.7;
        P.vx[i] *= 0.985;
        P.vy[i] *= 0.985;
        a = 1 - u;
      }
      aliveCount++;
      pos[i * 3] = P.x[i];
      pos[i * 3 + 1] = P.y[i];
      pos[i * 3 + 2] = 0;
      col[i * 3] = P.r[i];
      col[i * 3 + 1] = P.g[i];
      col[i * 3 + 2] = P.b[i];
      sz[i] = P.size[i];
      al[i] = a;
    }
    geo.setDrawRange(0, P.n);
    for (const name of ["position", "aColor", "aSize", "aAlpha"]) {
      (geo.getAttribute(name) as import("three").BufferAttribute).needsUpdate = true;
    }
    renderer.render(scene, camera);
    if (aliveCount === 0) {
      stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  // ---- effects -----------------------------------------------------------

  function parkEffect(from: Anchor, to: Anchor, color: Rgb): void {
    const { rect } = from;
    for (let k = 0; k < 360; k++) {
      spawn({
        sx: rect.left + rnd(0, rect.width),
        sy: rect.top + rnd(0, rect.height),
        cx: from.x + rnd(-40, 40),
        cy: from.y + 80,
        ex: to.x + rnd(-10, 10),
        ey: to.y + rnd(-4, 4),
        delay: rnd(0, 300),
        dur: rnd(600, 850),
        size: rnd(1.5, 4),
        c: k % 4 ? color : COLORS.white,
      });
    }
  }

  function resumeEffect(from: Anchor, to: Anchor, color: Rgb): void {
    const { rect } = to;
    for (let k = 0; k < 360; k++) {
      spawn({
        sx: from.x + rnd(-10, 10),
        sy: from.y + rnd(-4, 4),
        cx: to.x + rnd(-60, 60),
        cy: to.y + 110,
        ex: rect.left + rnd(0, rect.width),
        ey: rect.top + rnd(0, rect.height),
        delay: rnd(0, 300),
        dur: rnd(600, 850),
        size: rnd(1.5, 4),
        c: k % 4 ? color : COLORS.white,
      });
    }
  }

  function attentionEffect(at: Anchor): void {
    const { rect: r } = at;
    const per = 2 * (r.width + r.height);
    for (let k = 0; k < 260; k++) {
      // Walk the perimeter clockwise from the top-left corner: top edge,
      // right edge, bottom edge, left edge. (nx, ny) is the outward normal.
      const d = Math.random() * per;
      let x: number;
      let y: number;
      let nx: number;
      let ny: number;
      if (d < r.width) {
        x = r.left + d;
        y = r.top;
        nx = 0;
        ny = -1;
      } else if (d < r.width + r.height) {
        x = r.right;
        y = r.top + (d - r.width);
        nx = 1;
        ny = 0;
      } else if (d < 2 * r.width + r.height) {
        x = r.right - (d - r.width - r.height);
        y = r.bottom;
        nx = 0;
        ny = 1;
      } else {
        x = r.left;
        y = r.bottom - (d - 2 * r.width - r.height);
        nx = -1;
        ny = 0;
      }
      const sp = rnd(0.6, 2.4);
      spawn({
        sx: x,
        sy: y,
        mode: MODE_DRIFT,
        vx: nx * sp + rnd(-0.3, 0.3),
        vy: ny * sp + rnd(-0.3, 0.3),
        life: rnd(500, 900),
        size: rnd(2, 5),
        c: k % 5 ? COLORS.yellow : COLORS.white,
      });
    }
  }

  // ---- entry point ---------------------------------------------------------

  function play(effect: ParticleEffect): void {
    if (disposed) return;
    // Capture rectangles synchronously: the pane (park) or chip (resume) is
    // about to unmount on React's next commit.
    const { sessionId } = effect;
    const pane = document.querySelector(paneSelector(sessionId));
    const chip = document.querySelector(chipSelector(sessionId));
    const color = paneColor(pane) ?? COLORS.purple;
    const paneAnchor = anchorOf(pane);
    const chipAnchor = anchorOf(chip);
    const w = window.innerWidth;
    const h = window.innerHeight;

    let plan: ((T: Three) => Promise<void>) | null = null;
    if (effect.kind === "attention" && paneAnchor) {
      plan = async () => attentionEffect(paneAnchor);
    } else if (effect.kind === "park" && paneAnchor) {
      plan = async () => {
        const fallback: Anchor = { x: w / 2, y: h - 24, rect: new DOMRect(w / 2, h - 24, 0, 0) };
        const to = await resolveLater(chipSelector(sessionId), fallback);
        parkEffect(paneAnchor, to, color);
      };
    } else if (effect.kind === "resume" && chipAnchor) {
      plan = async () => {
        const fallback: Anchor = {
          x: w / 2,
          y: h / 2,
          rect: new DOMRect(w / 4, h / 4, w / 2, h / 2),
        };
        const to = await resolveLater(paneSelector(sessionId), fallback);
        resumeEffect(
          chipAnchor,
          to,
          paneColor(document.querySelector(paneSelector(sessionId))) ?? color,
        );
      };
    }
    if (!plan) return;
    const run = plan;
    void ensureThree().then(async (T) => {
      if (!T || disposed || !renderer) return;
      if (!running) start();
      await run(T);
      if (!running) start();
    });
  }

  function dispose(): void {
    disposed = true;
    stop();
    geo?.dispose();
    renderer?.dispose();
    renderer = null;
  }

  return { play, dispose };
}
