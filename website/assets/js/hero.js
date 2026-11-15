// Home page hero: a field of ember-red terminal tiles that drift apart, gather into one grid
// behind the samurai drawing, park a few on a shelf and call one back in white, then drift
// apart again, while cherry-blossom petals fall through the scene. It says what Maestro does:
// many AI coding sessions, one conductor.
//
// The page never depends on this file. Without JavaScript or WebGL the hero keeps its CSS
// background; with "reduce motion" set, one still frame of the grid is drawn and nothing moves.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "./vendor/three.min.js";

const MAX_PIXEL_RATIO = 1.75;
const GRID_COLUMNS = 6;
const GRID_ROWS = 5;
const TILE_SIZE = 1.0;
const ROW_SPACING = 0.68;
const DUST_COUNT = 160;
const CYCLE_SECONDS = 16;
const STILL_FRAME_SECONDS = 9.5;
const CAMERA_DISTANCE = 13;
const CAMERA_FOV = 40;
// The scene is kept dim so it reads as embers around the drawing, never over it.
const SCENE_OPACITY = 0.7;
// Petals fall through this height (world units) and start again at the top.
const PETAL_FALL_HEIGHT = 14;

const EMBER = new Color("#7a0a1c");
const RED = new Color("#ff1a3a");
const WHITE = new Color("#ffffff");
const PETAL = new Color("#ff8fab");
const PETAL_LIGHT = new Color("#ffd3de");

// Tiles that turn white ("needs you", like the mask's eyes) and tiles that go to the parked shelf.
const ATTENTION_TILES = [9, 22];
const PARKED_TILES = [4, 15, 22];

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aGlow;
  attribute float aKind;
  uniform float uPixelsPerUnit;
  varying vec3 vColor;
  varying float vGlow;
  varying float vKind;
  varying float vDepthFade;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = aSize * uPixelsPerUnit / -viewPosition.z;
    vColor = aColor;
    vGlow = aGlow;
    vKind = aKind;
    vDepthFade = clamp(1.25 - (-viewPosition.z - 6.0) / 12.0, 0.2, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vGlow;
  varying float vKind;
  varying float vDepthFade;

  float roundedBox(vec2 p, vec2 halfSize, float radius) {
    vec2 q = abs(p) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float alpha;
    vec3 color;
    if (vKind > 0.5) {
      float d = length(p * vec2(1.0, 1.7));
      alpha = smoothstep(0.5, 0.1, d) * 0.8;
      color = vColor;
    } else {
      float d = roundedBox(p, vec2(0.44, 0.28), 0.05);
      float inside = 1.0 - smoothstep(-0.004, 0.004, d);
      float outline = 1.0 - smoothstep(0.0, 0.022, abs(d));
      float halo = exp(-max(d, 0.0) * 26.0) * 0.6 * vGlow * (1.0 - inside);
      float header = inside * step(p.y, -0.18);
      float row = floor((p.y + 0.1) / 0.075);
      float rowLength = 0.15 + 0.45 * fract(sin(row * 12.9898) * 43758.5453);
      float textLine = inside * step(-0.1, p.y) * step(p.y, 0.2)
        * step(abs(fract((p.y + 0.1) / 0.075) - 0.5), 0.18)
        * step(p.x, -0.36 + rowLength);
      float body = outline + inside * 0.08 + header * 0.22 + textLine * 0.28;
      alpha = max(max(outline, inside * 0.35), halo);
      color = vColor * (body + halo);
    }
    alpha *= vDepthFade * uOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

function supportsWebGL2() {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** A repeatable pseudo-random number in [0, 1) so every visit draws the same field. */
function seeded(index, salt) {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function buildTiles() {
  const tiles = [];
  const gridWidth = (GRID_COLUMNS - 1) * TILE_SIZE;
  const gridHeight = (GRID_ROWS - 1) * ROW_SPACING;
  for (let i = 0; i < GRID_COLUMNS * GRID_ROWS; i++) {
    const column = i % GRID_COLUMNS;
    const row = Math.floor(i / GRID_COLUMNS);
    const grid = [column * TILE_SIZE - gridWidth / 2, gridHeight / 2 - row * ROW_SPACING, 0];
    const scatter = [
      (seeded(i, 1) - 0.5) * 22,
      (seeded(i, 2) - 0.5) * 12,
      (seeded(i, 3) - 0.75) * 10,
    ];
    const distanceFromCentre = Math.hypot(grid[0], grid[1]) / Math.hypot(gridWidth, gridHeight);
    tiles.push({
      grid,
      scatter,
      delay: distanceFromCentre * 1.4 + seeded(i, 4) * 0.3,
      phase: seeded(i, 5) * Math.PI * 2,
      base: EMBER.clone().lerp(RED, seeded(i, 6) * 0.7),
    });
  }
  const shelfY = -gridHeight / 2 - ROW_SPACING * 1.35;
  PARKED_TILES.forEach((index, slot) => {
    tiles[index].shelf = [-gridWidth / 2 + slot * 0.62, shelfY, 0.2];
  });
  return tiles;
}

function buildDust() {
  const dust = [];
  for (let i = 0; i < DUST_COUNT; i++) {
    dust.push({
      origin: [(seeded(i, 7) - 0.5) * 26, (seeded(i, 8) - 0.5) * 14, (seeded(i, 9) - 0.8) * 12],
      phase: seeded(i, 10) * Math.PI * 2,
      size: 0.1 + seeded(i, 11) * 0.16,
      speed: 0.25 + seeded(i, 12) * 0.45,
      color: PETAL.clone().lerp(PETAL_LIGHT, seeded(i, 13)),
    });
  }
  return dust;
}

/** How far tile `tile` has gathered into the grid at time `t` of the cycle (0 = scattered). */
function gatherAmount(tile, t) {
  const gather = smoothstep(3 + tile.delay, 4.8 + tile.delay, t);
  const release = smoothstep(12.6 + tile.delay * 0.6, 14.6 + tile.delay * 0.6, t);
  return gather * (1 - release);
}

function writeTile(tile, index, t, out) {
  const k = gatherAmount(tile, t);
  const drift = (1 - k) * 0.6;
  let x = lerp(tile.scatter[0], tile.grid[0], k) + Math.sin(t * 0.5 + tile.phase) * drift;
  let y = lerp(tile.scatter[1], tile.grid[1], k) + Math.cos(t * 0.4 + tile.phase) * drift;
  let z =
    lerp(tile.scatter[2], tile.grid[2], k) + Math.sin(t * 1.2 + tile.grid[0] * 0.6) * 0.08 * k;
  let size = TILE_SIZE;

  if (tile.shelf) {
    const parked = smoothstep(7.2, 8.2, t) * (1 - smoothstep(10.6, 11.6, t)) * k;
    x = lerp(x, tile.shelf[0], parked);
    y = lerp(y, tile.shelf[1], parked);
    z = lerp(z, tile.shelf[2], parked);
    size = lerp(size, TILE_SIZE * 0.55, parked);
  }

  const attention = ATTENTION_TILES.includes(index)
    ? smoothstep(8.8, 9.3, t) * (1 - smoothstep(12, 12.8, t)) * k
    : 0;
  const pulse = attention * (0.75 + 0.25 * Math.sin(t * 6));
  const color = tile.base.clone().lerp(WHITE, attention);

  out.position.set([x, y, z], index * 3);
  out.color.set([color.r, color.g, color.b], index * 3);
  out.size[index] = size;
  out.glow[index] = 0.35 + 0.45 * k + pulse;
}

/** A petal falls at its own speed, sways sideways and starts again at the top. */
function writeDust(mote, index, t, out) {
  const [ox, oy, oz] = mote.origin;
  const half = PETAL_FALL_HEIGHT / 2;
  const fallen = (oy + half - t * mote.speed) % PETAL_FALL_HEIGHT;
  const y = ((fallen + PETAL_FALL_HEIGHT) % PETAL_FALL_HEIGHT) - half;
  out.position.set([ox + Math.sin(t * 0.6 + mote.phase) * 0.7, y, oz], index * 3);
  out.color.set([mote.color.r, mote.color.g, mote.color.b], index * 3);
  out.size[index] = mote.size;
  out.glow[index] = 0;
}

function start(canvas, hero, reducedMotion) {
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 60);
  camera.position.set(0, 0, CAMERA_DISTANCE);

  const tiles = buildTiles();
  const dust = buildDust();
  const count = tiles.length + dust.length;
  const out = {
    position: new Float32Array(count * 3),
    color: new Float32Array(count * 3),
    size: new Float32Array(count),
    glow: new Float32Array(count),
  };
  const kind = new Float32Array(count);
  kind.fill(1, tiles.length);

  const geometry = new BufferGeometry();
  const attributes = {
    position: new BufferAttribute(out.position, 3),
    aColor: new BufferAttribute(out.color, 3),
    aSize: new BufferAttribute(out.size, 1),
    aGlow: new BufferAttribute(out.glow, 1),
  };
  for (const [name, attribute] of Object.entries(attributes)) {
    geometry.setAttribute(name, attribute);
  }
  geometry.setAttribute("aKind", new BufferAttribute(kind, 1));

  const material = new ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: { uPixelsPerUnit: { value: 1 }, uOpacity: { value: SCENE_OPACITY } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const field = new Points(geometry, material);
  field.frustumCulled = false;
  scene.add(field);

  const pointer = { x: 0, y: 0 };

  function resize() {
    const width = hero.clientWidth;
    const height = hero.clientHeight;
    if (width === 0 || height === 0) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const halfFov = (CAMERA_FOV * Math.PI) / 360;
    material.uniforms.uPixelsPerUnit.value = (height * pixelRatio) / (2 * Math.tan(halfFov));
  }

  function draw(seconds) {
    const t = seconds % CYCLE_SECONDS;
    tiles.forEach((tile, index) => {
      writeTile(tile, index, t, out);
    });
    dust.forEach((mote, index) => {
      writeDust(mote, tiles.length + index, seconds, out);
    });
    for (const attribute of Object.values(attributes)) attribute.needsUpdate = true;
    camera.position.x = lerp(camera.position.x, pointer.x * 0.6, 0.05);
    camera.position.y = lerp(camera.position.y, pointer.y * 0.4, 0.05);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }

  resize();
  canvas.classList.add("is-live");

  if (reducedMotion) {
    draw(STILL_FRAME_SECONDS);
    new ResizeObserver(() => {
      resize();
      draw(STILL_FRAME_SECONDS);
    }).observe(hero);
    return;
  }

  let frame = 0;
  let onScreen = true;
  let elapsed = 0;
  let last = 0;

  function tick(now) {
    elapsed += Math.min((now - last) / 1000, 0.1);
    last = now;
    draw(elapsed);
    frame = requestAnimationFrame(tick);
  }

  function updateRunning() {
    const shouldRun = onScreen && !document.hidden;
    if (shouldRun && frame === 0) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    } else if (!shouldRun && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  new ResizeObserver(resize).observe(hero);
  new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    updateRunning();
  }).observe(hero);
  document.addEventListener("visibilitychange", updateRunning);
  hero.addEventListener("pointermove", (event) => {
    const rect = hero.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    pointer.y = -((event.clientY - rect.top) / rect.height - 0.5) * 2;
  });
  updateRunning();
}

const canvas = document.querySelector(".hero-canvas");
const hero = document.querySelector(".hero");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (canvas && hero && supportsWebGL2()) {
  try {
    start(canvas, hero, reducedMotion);
  } catch {
    // No WebGL after all: the hero keeps its CSS background and the page is unchanged.
    canvas.remove();
  }
}
