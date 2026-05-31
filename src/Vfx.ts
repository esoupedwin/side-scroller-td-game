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

const SPARK_DUR    = 0.20;
const SPARK_RAYS   = 9;
const SPARK_LEN_0  = 8;
const SPARK_LEN_1  = 30;
const RING_R0      = 5;
const RING_R1      = 30;
const SPARK_COLOR  = 0xfff2c0;
const SPARK_SEED   = Math.PI / 7;  // rotate rays so they don't line up with the grid

class HitSpark implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private g:     PIXI.Graphics;   // additive: flash, rays, ring
  private life = 0;
  private rot:   number;

  constructor(x: number, y: number) {
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;
    this.rot = Math.random() * Math.PI;
    this.g = new PIXI.Graphics();
    // Additive so the impact reads as a bright pop against bodies and sky alike.
    this.g.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.g);
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / SPARK_DUR;
    if (t >= 1) { this.isDone = true; return; }

    const ease   = 1 - (1 - t) * (1 - t);   // ease-out for the expansion
    const len    = SPARK_LEN_0 + (SPARK_LEN_1 - SPARK_LEN_0) * ease;
    const ringR  = RING_R0    + (RING_R1    - RING_R0)    * ease;
    const alpha  = 1 - t;

    this.g.clear();
    // White core pop — bright, very short
    const ct = Math.min(1, this.life / 0.06);
    this.g.beginFill(0xffffff, (1 - ct) * 0.95);
    this.g.drawCircle(0, 0, 7 * (1 - ct) + 3);
    this.g.endFill();

    // Radial spokes — alternating long/short for a starburst feel
    for (let i = 0; i < SPARK_RAYS; i++) {
      const a   = this.rot + SPARK_SEED + (i / SPARK_RAYS) * Math.PI * 2;
      const cx  = Math.cos(a), sy = Math.sin(a);
      const rl  = i % 2 === 0 ? len : len * 0.62;
      this.g.lineStyle(i % 2 === 0 ? 2.4 : 1.4, SPARK_COLOR, alpha);
      this.g.moveTo(cx * rl * 0.25, sy * rl * 0.25);
      this.g.lineTo(cx * rl,        sy * rl);
    }
    // Expanding shock ring
    this.g.lineStyle(Math.max(1, 3 * (1 - t)), 0xffe6a0, alpha * 0.8);
    this.g.drawCircle(0, 0, ringR);
    this.g.lineStyle(0);
  }
}

// ── MuzzleGlow ──────────────────────────────────────────────────────────────
// Soft additively-blended orange disc at the gun tip — simulates the front of
// the shooter being lit up by the flash. Drawn for gun-wielding units only
// (rifleman / sniper / tanker); arrows and rockets have their own visuals.

const GLOW_DUR     = 0.11;     // seconds
const GLOW_R_OUTER = 30;
const GLOW_R_MID   = 19;
const GLOW_R_CORE  = 9;
const GLOW_COLOR_OUTER = 0xffd0a0;  // pale orange
const GLOW_COLOR_MID   = 0xffb070;
const GLOW_COLOR_CORE  = 0xffffff;  // white-hot centre

class MuzzleGlow implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private g:    PIXI.Graphics;
  private life = 0;
  private dir:  1 | -1;

  constructor(x: number, y: number, dir: 1 | -1 = 1) {
    this.dir = dir;
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;
    this.g = new PIXI.Graphics();
    // Additive blend brightens what's behind the disc — the body sprite under
    // the glow reads as lit, the open background only picks up a faint warmth.
    this.g.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.g);
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / GLOW_DUR;
    if (t >= 1) { this.isDone = true; return; }
    const alpha = (1 - t) * 0.9;
    const grow  = 0.7 + 0.3 * (1 - t);  // pops big then settles

    this.g.clear();
    // Soft glow discs
    this.g.beginFill(GLOW_COLOR_OUTER, alpha);       this.g.drawCircle(0, 0, GLOW_R_OUTER * grow); this.g.endFill();
    this.g.beginFill(GLOW_COLOR_MID,   alpha * 0.8); this.g.drawCircle(0, 0, GLOW_R_MID   * grow); this.g.endFill();

    // Forward-biased 4-point flash star — long horizontal spikes (down the
    // barrel), short vertical ones. Reads as a directional muzzle flash.
    const spikeL = GLOW_R_OUTER * 1.8 * (1 - t) + 8;
    const spikeS = GLOW_R_OUTER * 0.6;
    const fwd    = this.dir;
    this.g.beginFill(GLOW_COLOR_MID, alpha);
    this.g.drawPolygon([
      fwd * spikeL, 0,          // forward tip (long, down the barrel)
      0,            -spikeS * 0.5,
      -fwd * spikeS * 0.7, 0,   // short rear spike
      0,            spikeS * 0.5,
    ]);
    this.g.drawPolygon([        // vertical short spikes
      0, -spikeS,
      spikeS * 0.35, 0,
      0, spikeS,
      -spikeS * 0.35, 0,
    ]);
    this.g.endFill();

    // White-hot core on top
    this.g.beginFill(GLOW_COLOR_CORE, alpha * 0.7); this.g.drawCircle(0, 0, GLOW_R_CORE * grow); this.g.endFill();
  }
}

// ── SpeedStreak ──────────────────────────────────────────────────────────────
// A burst of horizontal lines anchored in world space as the character moves.
// Spawned every ~50 ms while a speed power-up is active; because they stay put
// while the character advances, they accumulate into a visible motion trail.

const STREAK_DUR      = 0.22;   // seconds before fully faded
const STREAK_COUNT    = 4;      // lines per burst
const STREAK_LEN_MIN  = 10;
const STREAK_LEN_MAX  = 36;
const STREAK_COLORS   = [0x00ffff, 0x88eeff, 0xffffff] as const;

class SpeedStreak implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private g:    PIXI.Graphics;
  private life = 0;

  constructor(x: number, feetY: number, charH: number, dir: 1 | -1) {
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = feetY;

    this.g = new PIXI.Graphics();
    for (let i = 0; i < STREAK_COUNT; i++) {
      const yOff  = -(charH * (0.12 + Math.random() * 0.76));
      const len   = STREAK_LEN_MIN + Math.random() * (STREAK_LEN_MAX - STREAK_LEN_MIN);
      const color = STREAK_COLORS[Math.floor(Math.random() * STREAK_COLORS.length)];
      const thick = 0.8 + Math.random() * 1.4;
      this.g.lineStyle(thick, color, 0.9);
      // Lines trail opposite to movement direction so they fly behind the runner.
      this.g.moveTo(0, yOff);
      this.g.lineTo(-dir * len, yOff);
    }
    this.g.lineStyle(0);
    this.container.addChild(this.g);
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / STREAK_DUR;
    if (t >= 1) { this.isDone = true; return; }
    this.g.alpha = 1 - t;
  }
}

// ── Explosion ────────────────────────────────────────────────────────────────
// Full cinematic blast, scaled by the splash radius so grenades and rockets read
// at the right size. Layers, back-to-front:
//   • smoke    — grey puffs revealed behind the fireball as it fades; rise slowly
//   • fireball — OPAQUE red→orange→yellow ball (normal blend, so warm colours read
//                true over the bright sky instead of washing out)
//   • glow     — additive white-hot core + shockwave ring (bright highlights only)
//   • sparks   — gravity-driven embers flung outward as bright streaks (additive)

const EXP_DUR        = 0.7;    // overall lifetime (smoke is the longest layer)
const EXP_SPARKS     = 16;
const EXP_SPARK_GRAV = 1100;   // px/s² pulling embers back down
const EXP_SPARK_TAIL = 0.045;  // seconds of velocity drawn as the streak tail

interface Ember { x: number; y: number; vx: number; vy: number; }

class Explosion implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private smokeG: PIXI.Graphics;
  private fireG:  PIXI.Graphics;
  private glowG:  PIXI.Graphics;
  private sparkG: PIXI.Graphics;
  private life = 0;
  private r:     number;
  private embers: Ember[]                          = [];
  private puffs:  { x: number; y: number; r: number }[] = [];

  constructor(x: number, y: number, radius: number) {
    this.r = radius;
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;

    this.smokeG = new PIXI.Graphics();                                              // normal
    this.fireG  = new PIXI.Graphics();                                              // normal (opaque fire)
    this.glowG  = new PIXI.Graphics(); this.glowG.blendMode  = PIXI.BLEND_MODES.ADD;
    this.sparkG = new PIXI.Graphics(); this.sparkG.blendMode = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.smokeG, this.fireG, this.glowG, this.sparkG);

    for (let i = 0; i < EXP_SPARKS; i++) {
      const a  = Math.random() * Math.PI * 2;
      const sp = (0.7 + Math.random() * 1.1) * radius * 5;  // px/s
      this.embers.push({ x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - radius });
    }
    for (let i = 0; i < 4; i++) {
      this.puffs.push({
        x: (Math.random() - 0.5) * radius,
        y: (Math.random() - 0.5) * radius * 0.6,
        r: radius * (0.3 + Math.random() * 0.35),
      });
    }
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / EXP_DUR;
    if (t >= 1) { this.isDone = true; return; }
    const R = this.r;

    // ── Fireball (opaque, normal blend, front-loaded) ──
    this.fireG.clear();
    const ft = this.life / 0.34;
    if (ft < 1) {
      const fa = (1 - ft) * (1 - ft);             // hold bright then drop off fast
      const shellR = R * (0.35 + 0.8 * ft);
      this.fireG.beginFill(0xd02808, Math.min(1, fa + 0.15)); this.fireG.drawCircle(0, 0, shellR);        this.fireG.endFill();
      this.fireG.beginFill(0xff7a18, Math.min(1, fa + 0.2));  this.fireG.drawCircle(0, 0, shellR * 0.7);  this.fireG.endFill();
      this.fireG.beginFill(0xffd23a, Math.min(1, fa + 0.25)); this.fireG.drawCircle(0, 0, shellR * 0.42); this.fireG.endFill();
    }

    // ── Hot core + shockwave (additive highlights) ──
    this.glowG.clear();
    const ct = this.life / 0.09;
    if (ct < 1) {
      this.glowG.beginFill(0xffffff, (1 - ct) * 0.95);
      this.glowG.drawCircle(0, 0, R * 0.55 * (0.6 + ct));
      this.glowG.endFill();
    }
    const st = this.life / 0.36;
    if (st < 1) {
      const ringR = R * (0.5 + 1.7 * st);
      this.glowG.lineStyle(Math.max(1, 6 * (1 - st)), 0xfff0c0, (1 - st) * 0.85);
      this.glowG.drawCircle(0, 0, ringR);
      this.glowG.lineStyle(0);
    }

    // ── Embers (additive streaks) ──
    this.sparkG.clear();
    const sa = Math.max(0, 1 - this.life / 0.55);
    if (sa > 0) {
      for (const e of this.embers) {
        e.vy += EXP_SPARK_GRAV * dt;
        e.x  += e.vx * dt;
        e.y  += e.vy * dt;
        this.sparkG.lineStyle(2, 0xffd66b, sa);
        this.sparkG.moveTo(e.x - e.vx * EXP_SPARK_TAIL, e.y - e.vy * EXP_SPARK_TAIL);
        this.sparkG.lineTo(e.x, e.y);
        this.sparkG.lineStyle(0);
        this.sparkG.beginFill(0xffe9a0, sa);
        this.sparkG.drawCircle(e.x, e.y, 1.8);
        this.sparkG.endFill();
      }
    }

    // ── Smoke (normal blend) — ramps in as the fireball dies, then rises/fades.
    // Sits behind the opaque fireball, so it only becomes visible once the fire
    // thins out (no muddy grey over the initial flash).
    this.smokeG.clear();
    const ramp = Math.min(1, this.life / 0.25);          // fade in over first 0.25s
    const ma   = 0.42 * ramp * (1 - t) * (1 - t);
    if (ma > 0.01) {
      const grow = 0.8 + t * 1.1;
      for (const p of this.puffs) {
        this.smokeG.beginFill(0x3a3a3a, ma);
        this.smokeG.drawCircle(p.x, p.y - t * R * 0.6, p.r * grow);
        this.smokeG.endFill();
      }
    }
  }
}

// ── Spawn helpers ───────────────────────────────────────────────────────────

export function spawnSlashArc(x: number, y: number, dir: 1 | -1, side: 'player' | 'enemy'): void {
  register(new SlashArc(x, y, dir, side));
}

export function spawnExplosion(x: number, y: number, radius: number): void {
  register(new Explosion(x, y, radius));
}

export function spawnHitSpark(x: number, y: number): void {
  register(new HitSpark(x, y));
}

export function spawnMuzzleGlow(x: number, y: number, dir: 1 | -1 = 1): void {
  register(new MuzzleGlow(x, y, dir));
}

export function spawnSpeedStreak(x: number, feetY: number, charH: number, dir: 1 | -1): void {
  register(new SpeedStreak(x, feetY, charH, dir));
}
