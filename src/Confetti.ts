import {
  CONFETTI_CANNON_COUNT, CONFETTI_FALL_RATE, CONFETTI_FALL_PREFILL,
  CONFETTI_GRAVITY, CONFETTI_DRAG,
  CONFETTI_CANNON_SPD_MIN, CONFETTI_CANNON_SPD_MAX,
  CONFETTI_CANNON_SPREAD, CONFETTI_CANNON_AIM,
  CONFETTI_FALL_SPD_MIN, CONFETTI_FALL_SPD_MAX, CONFETTI_FALL_DRIFT_MAX,
  CONFETTI_SIZE_MIN, CONFETTI_SIZE_MAX,
  CONFETTI_SPIN_MIN, CONFETTI_SPIN_MAX,
  CONFETTI_FLUTTER_MIN, CONFETTI_FLUTTER_MAX,
} from './constants';

/**
 * Victory confetti — a full-screen fall shown while the player's win screen is up.
 *
 * The rain is continuous: new pieces are seeded at a fixed rate for as long as
 * the burst runs, so the screen stays filled until `stopConfetti()` (Play Again,
 * any restart, or the squad screen reopening). Only the corner cannons are a
 * one-off volley.
 *
 * Deliberately a plain DOM canvas with its own rAF loop rather than a PixiJS
 * layer: at game-over the tick loop is stopped, and the fall should cover the
 * whole browser window, not the CSS-scaled #game-container the world renders
 * into. That makes it independent of camera, zoom, pause state, and `game.reset()`.
 */

/** Festive palette — single definition for every piece drawn. */
const CONFETTI_COLORS = [
  '#ffd166', // gold
  '#ff8fab', // pink
  '#06d6a0', // mint
  '#00b4d8', // cyan (matches the Victory banner)
  '#f94144', // red
  '#c77dff', // violet
  '#fdfcdc', // cream
] as const;

/** Largest frame step the simulation accepts (s) — guards tab-switch jumps. */
const MAX_STEP_S = 1 / 30;

interface Piece {
  x: number;  y: number;
  vx: number; vy: number;
  w: number;  h: number;       // px — short/long edge at zero flutter
  color: string;
  rot: number; spin: number;   // rad, rad/s
  flutter: number;             // rad/s of the width-squash wobble
  phase: number;               // current wobble angle
}

let canvas: HTMLCanvasElement | null = null;
let ctx:    CanvasRenderingContext2D | null = null;
let pieces: Piece[] = [];
let rafId     = 0;
let lastTime  = 0;
let running   = false;
let fallAccum = 0;   // fractional pieces owed by the rain since the last seed

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function ensureCanvas(): HTMLCanvasElement {
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.id = 'confetti-canvas';
  // Fixed to the window and click-through: the Play Again button sits under it.
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; pointer-events:none; z-index:150; display:none;';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  return canvas;
}

/** Match the backing store to the window, in device pixels. */
function sizeCanvas() {
  if (!canvas || !ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width  = Math.round(window.innerWidth  * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function makePiece(x: number, y: number, vx: number, vy: number): Piece {
  const w = rand(CONFETTI_SIZE_MIN, CONFETTI_SIZE_MAX);
  return {
    x, y, vx, vy,
    w,
    h: w * rand(0.45, 1.15),   // mix of squares and ribbons
    color:   CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
    rot:     rand(0, Math.PI * 2),
    spin:    rand(CONFETTI_SPIN_MIN, CONFETTI_SPIN_MAX) * (Math.random() < 0.5 ? -1 : 1),
    flutter: rand(CONFETTI_FLUTTER_MIN, CONFETTI_FLUTTER_MAX),
    phase:   rand(0, Math.PI * 2),
  };
}

/** One bottom-corner cannon firing inward and up. */
function fireCannon(originX: number, originY: number, aimDir: 1 | -1) {
  const aim    = (CONFETTI_CANNON_AIM * Math.PI) / 180;
  const spread = (CONFETTI_CANNON_SPREAD * Math.PI) / 180;
  for (let i = 0; i < CONFETTI_CANNON_COUNT; i++) {
    const angle = aim + rand(-spread, spread);
    const speed = rand(CONFETTI_CANNON_SPD_MIN, CONFETTI_CANNON_SPD_MAX);
    pieces.push(makePiece(
      originX + rand(-20, 20),
      originY + rand(-20, 20),
      Math.cos(angle) * speed * aimDir,
      -Math.sin(angle) * speed,
    ));
  }
}

/** One piece of rain entering from just above the top edge. */
function seedFallingPiece(width: number, y = rand(-80, -10)) {
  pieces.push(makePiece(
    rand(0, width),
    y,
    rand(-CONFETTI_FALL_DRIFT_MAX, CONFETTI_FALL_DRIFT_MAX),
    rand(CONFETTI_FALL_SPD_MIN, CONFETTI_FALL_SPD_MAX),
  ));
}

function step(dt: number, width: number, height: number) {
  // Keep raining for as long as the burst is running — the fall is constant,
  // not a one-off drizzle, so the screen never empties out.
  if (running) {
    fallAccum += CONFETTI_FALL_RATE * dt;
    while (fallAccum >= 1) {
      seedFallingPiece(width);
      fallAccum -= 1;
    }
  }

  const dragFactor = Math.pow(CONFETTI_DRAG, dt);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    p.vy   += CONFETTI_GRAVITY * dt;
    p.vx   *= dragFactor;
    p.x    += p.vx * dt;
    p.y    += p.vy * dt;
    p.rot  += p.spin * dt;
    p.phase += p.flutter * dt;
    // Retire once a piece has fallen clear of the bottom edge; pieces still
    // rising or drifting sideways stay alive so cannon arcs can re-enter.
    if (p.y - p.h > height && p.vy > 0) pieces.splice(i, 1);
  }
}

function draw(width: number, height: number) {
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  for (const p of pieces) {
    // The wobble squashes the piece's width, reading as a flat strip tumbling
    // through its own plane.
    const w = p.w * Math.abs(Math.cos(p.phase));
    if (w < 0.5) continue;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-w / 2, -p.h / 2, w, p.h);
    ctx.restore();
  }
}

function frame(now: number) {
  if (!canvas || !ctx) return;
  const dt = Math.min((now - lastTime) / 1000, MAX_STEP_S);
  lastTime = now;

  const width  = window.innerWidth;
  const height = window.innerHeight;
  step(dt, width, height);
  draw(width, height);

  rafId = requestAnimationFrame(frame);
}

/**
 * Fill the screen with confetti and keep it falling until `stopConfetti()`.
 * Safe to call while a burst is already running — the previous one is cleared first.
 */
export function startConfetti() {
  stopConfetti();
  ensureCanvas();
  if (!canvas || !ctx) return;   // no 2D context (shouldn't happen) — skip silently
  sizeCanvas();
  canvas.style.display = 'block';

  const width  = window.innerWidth;
  const height = window.innerHeight;
  fireCannon(0,     height, 1);
  fireCannon(width, height, -1);
  // Pre-seed the rain across the full height so it reads as already falling
  // rather than taking a screen-height of travel to arrive.
  for (let i = 0; i < CONFETTI_FALL_PREFILL; i++) seedFallingPiece(width, rand(-height, height));
  fallAccum = 0;
  running   = true;

  window.addEventListener('resize', sizeCanvas);
  lastTime = performance.now();
  rafId = requestAnimationFrame(frame);
}

/** Stop the fall and clear the overlay. Idempotent. */
export function stopConfetti() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  window.removeEventListener('resize', sizeCanvas);
  pieces    = [];
  fallAccum = 0;
  if (canvas && ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = 'none';
  }
}
