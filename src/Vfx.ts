import * as PIXI from 'pixi.js';
import { PLAYER_COLOR, ENEMY_COLOR } from './constants';

// Lightweight, geometry-only visual effects for combat feedback.
// Same module-level singleton shape as AudioManager so call sites stay one
// import deep — Character.ts and Projectile-handling code in Game.ts can just
// `import { spawnSlashArc, spawnHitSpark } from './Vfx'` and fire.
//
// Each Vfx is one PIXI.Graphics that lives in `vfxLayer`, ticks itself for a
// fixed lifetime, then is destroyed.

interface VfxEffect {
  container: PIXI.Container;
  isDone:    boolean;
  update(dt: number): void;
}

let vfxLayer: PIXI.Container | null = null;
const effects: VfxEffect[] = [];

export function initVfx(layer: PIXI.Container): void {
  vfxLayer = layer;
}

export function tickVfx(dt: number): void {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.update(dt);
    if (e.isDone) {
      if (vfxLayer && e.container.parent === vfxLayer) vfxLayer.removeChild(e.container);
      e.container.destroy({ children: true });
      effects.splice(i, 1);
    }
  }
}

/** Destroy every active VFX. Called on Game.reset(). */
export function clearVfx(): void {
  for (const e of effects) {
    if (vfxLayer && e.container.parent === vfxLayer) vfxLayer.removeChild(e.container);
    e.container.destroy({ children: true });
  }
  effects.length = 0;
}

function register(e: VfxEffect): void {
  if (!vfxLayer) return;  // pre-init or post-teardown — silently drop
  vfxLayer.addChild(e.container);
  effects.push(e);
}

// ── SlashArc ────────────────────────────────────────────────────────────────
// A short crescent that sweeps in front of a melee attacker during the swing
// wind-up. Anchored in world space — does not follow the attacker.

const SLASH_DUR    = 0.18;   // seconds
const SLASH_R0     = 48;     // start radius (px) — 2× original
const SLASH_R1     = 76;     // end radius   (px) — 2× original
const SLASH_HALF_A = 0.9;    // sweep half-angle (radians) — total sweep = 2 × this
const SLASH_OFFSET_X = 22;   // arc anchor offset in front of attacker
const SLASH_OFFSET_Y = -28;  // raised toward the chest

class SlashArc implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private g:      PIXI.Graphics;
  private life   = 0;
  private dir:    1 | -1;
  private tint:   number;

  constructor(x: number, y: number, dir: 1 | -1, side: 'player' | 'enemy') {
    this.dir  = dir;
    this.tint = side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    this.container = new PIXI.Container();
    this.container.x = x + dir * SLASH_OFFSET_X;
    this.container.y = y + SLASH_OFFSET_Y;
    this.g = new PIXI.Graphics();
    this.container.addChild(this.g);
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / SLASH_DUR;
    if (t >= 1) { this.isDone = true; return; }

    // Sweep grows from a tiny slice to the full crescent over the lifetime.
    const radius = SLASH_R0 + (SLASH_R1 - SLASH_R0) * t;
    const halfA  = SLASH_HALF_A * t;
    const alpha  = 0.85 * (1 - t);

    // Centred on the +x axis (right), mirrored by container scale for left-facing.
    const a0 = -halfA;
    const a1 = +halfA;

    this.g.clear();
    // Outer white edge
    this.g.lineStyle(6, 0xffffff, alpha);
    this.g.arc(0, 0, radius, a0, a1);
    // Inner side-tint trail
    this.g.lineStyle(3, this.tint, alpha * 0.6);
    this.g.arc(0, 0, radius - 8, a0, a1);
    this.g.lineStyle(0);

    // Container flip for left-facing attackers (so the arc points the same way as the swing).
    this.container.scale.x = this.dir;
  }
}

// ── HitSpark ────────────────────────────────────────────────────────────────
// Radial spark + tiny expanding ring at the impact point. Used by melee
// land and by ranged projectile-on-character hits.

const SPARK_DUR    = 0.12;
const SPARK_RAYS   = 6;
const SPARK_LEN_0  = 6;
const SPARK_LEN_1  = 14;
const RING_R0      = 4;
const RING_R1      = 16;
const SPARK_COLOR  = 0xfff2c0;

class HitSpark implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private g:    PIXI.Graphics;
  private life = 0;

  constructor(x: number, y: number) {
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;
    this.g = new PIXI.Graphics();
    this.container.addChild(this.g);
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / SPARK_DUR;
    if (t >= 1) { this.isDone = true; return; }

    const len    = SPARK_LEN_0 + (SPARK_LEN_1 - SPARK_LEN_0) * t;
    const ringR  = RING_R0    + (RING_R1    - RING_R0)    * t;
    const alpha  = 1 - t;

    this.g.clear();
    // 6 radial spokes
    this.g.lineStyle(1.5, SPARK_COLOR, alpha);
    for (let i = 0; i < SPARK_RAYS; i++) {
      const a  = (i / SPARK_RAYS) * Math.PI * 2;
      const cx = Math.cos(a), sy = Math.sin(a);
      this.g.moveTo(cx * len * 0.4, sy * len * 0.4);
      this.g.lineTo(cx * len,       sy * len);
    }
    // Expanding ring
    this.g.lineStyle(1, SPARK_COLOR, alpha * 0.7);
    this.g.drawCircle(0, 0, ringR);
    this.g.lineStyle(0);
  }
}

// ── Spawn helpers ───────────────────────────────────────────────────────────

export function spawnSlashArc(x: number, y: number, dir: 1 | -1, side: 'player' | 'enemy'): void {
  register(new SlashArc(x, y, dir, side));
}

export function spawnHitSpark(x: number, y: number): void {
  register(new HitSpark(x, y));
}
