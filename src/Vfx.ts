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
// Separate layer for afterimages so they can render BEHIND characters (vfxLayer
// sits in front of the unit layer). Added before the unit layer in Game.build().
let afterImageLayer: PIXI.Container | null = null;
const effects: VfxEffect[] = [];

export function initVfx(layer: PIXI.Container): void {
  vfxLayer = layer;
}

/** Layer for afterimages — must be added behind the unit layer in the world. */
export function initAfterImageLayer(layer: PIXI.Container): void {
  afterImageLayer = layer;
}

export function tickVfx(dt: number): void {
  // Single forward pass with read-index/write-index compaction. Each .splice()
  // on a long effects array (after volleys: speed-streaks at 50ms cadence
  // plus explosion sparks) shifts the entire tail — multiple splices in one
  // frame are O(n×k). This is O(n) regardless of how many die.
  let w = 0;
  for (let r = 0; r < effects.length; r++) {
    const e = effects[r];
    e.update(dt);
    if (e.isDone) {
      e.container.parent?.removeChild(e.container);
      e.container.destroy({ children: true });
    } else {
      if (r !== w) effects[w] = e;
      w++;
    }
  }
  effects.length = w;
}

/** Destroy every active VFX. Called on Game.reset(). */
export function clearVfx(): void {
  for (const e of effects) {
    e.container.parent?.removeChild(e.container);
    e.container.destroy({ children: true });
  }
  effects.length = 0;
}

function register(e: VfxEffect, layer: PIXI.Container | null = vfxLayer): void {
  if (!layer) return;  // pre-init or post-teardown — silently drop
  layer.addChild(e.container);
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

// ── BlockFlash ──────────────────────────────────────────────────────────────
// A vertical shield crescent that pops in front of a character when its block
// ability absorbs an incoming hit — bright rim + steel-blue inner arc with a
// few radial glints, expanding slightly and fading out fast.

const BLOCK_DUR      = 0.28;  // seconds
const BLOCK_R0       = 18;    // start radius (px)
const BLOCK_R1       = 27;    // end radius (px)
const BLOCK_HALF_A   = 1.15;  // arc half-angle — a tall guard covering the body front
const BLOCK_OFFSET_X = 14;    // held slightly in front of the character
const BLOCK_TINT     = 0x9fc4e8;  // steel blue — matches the "Blocked" label

class BlockFlash implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private g:    PIXI.Graphics;
  private life = 0;
  private dir:  1 | -1;

  constructor(x: number, y: number, dir: 1 | -1) {
    this.dir = dir;
    this.container = new PIXI.Container();
    this.container.x = x + dir * BLOCK_OFFSET_X;
    this.container.y = y;
    this.g = new PIXI.Graphics();
    this.container.addChild(this.g);
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / BLOCK_DUR;
    if (t >= 1) { this.isDone = true; return; }

    const r     = BLOCK_R0 + (BLOCK_R1 - BLOCK_R0) * t;
    const alpha = 0.9 * (1 - t);

    this.g.clear();
    // Bright rim + steel inner arc (centred on the +x axis, flipped via scale).
    this.g.lineStyle(5, 0xffffff, alpha);
    this.g.arc(0, 0, r, -BLOCK_HALF_A, BLOCK_HALF_A);
    this.g.lineStyle(3, BLOCK_TINT, alpha * 0.85);
    this.g.arc(0, 0, r - 6, -BLOCK_HALF_A * 0.9, BLOCK_HALF_A * 0.9);
    // Deflection glints spraying off the guard.
    this.g.lineStyle(2, 0xffffff, alpha * 0.7);
    for (const a of [-0.7, 0, 0.7]) {
      const gx = Math.cos(a), gy = Math.sin(a);
      this.g.moveTo(gx * (r + 2), gy * (r + 2));
      this.g.lineTo(gx * (r + 8 + 8 * t), gy * (r + 8 + 8 * t));
    }
    this.g.lineStyle(0);

    this.container.scale.x = this.dir;
  }
}

// ── AggroWave ───────────────────────────────────────────────────────────────
// Violent shockwave pulse emitted by characters under the Aggression tribe
// power-up: a jagged red-hot ring that bursts outward and fades, with a softer
// inner ring trailing it. Spawned repeatedly (Character.tickAggressionWaves)
// for the buff's duration, so the unit reads as radiating fury.

const AGGRO_DUR   = 0.45;   // seconds per pulse
const AGGRO_R0    = 12;     // start radius (px)
const AGGRO_R1    = 46;     // end radius (px)
const AGGRO_SEGS  = 12;     // jagged ring segments
const AGGRO_HOT   = 0xff4d2e;  // outer blazing ring
const AGGRO_EMBER = 0xffb066;  // inner ember trail

class AggroWave implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private g:    PIXI.Graphics;
  private life = 0;
  // Per-instance phase so simultaneous waves from one character don't overlap
  // their spikes perfectly (deterministic — derived from spawn position).
  private readonly phase: number;

  constructor(x: number, y: number) {
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;
    this.phase = (x * 7 + y * 13) % (Math.PI * 2);
    this.g = new PIXI.Graphics();
    this.container.addChild(this.g);
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / AGGRO_DUR;
    if (t >= 1) { this.isDone = true; return; }

    // Fast burst outward (ease-out), fading as it expands.
    const ease  = 1 - (1 - t) * (1 - t);
    const r     = AGGRO_R0 + (AGGRO_R1 - AGGRO_R0) * ease;
    const alpha = 0.85 * (1 - t);

    // Jagged ring: alternating spike/dip radii around the circle.
    this.g.clear();
    this.g.lineStyle(4, AGGRO_HOT, alpha);
    const pts: number[] = [];
    for (let i = 0; i < AGGRO_SEGS; i++) {
      const a  = (i / AGGRO_SEGS) * Math.PI * 2 + this.phase;
      const rr = r + (i % 2 === 0 ? 4 : -4);
      pts.push(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    this.g.drawPolygon(pts);
    // Softer ember ring trailing inside the shockwave.
    this.g.lineStyle(2, AGGRO_EMBER, alpha * 0.7);
    this.g.drawCircle(0, 0, Math.max(4, r - 9));
    this.g.lineStyle(0);
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
  // Drawn once at full size; update() only scales and fades three layers. The
  // old clear()+redraw of spokes and arcs every frame was one of the top
  // Graphics-geometry-rebuild sources in a busy fight (~20 rebuilds/s alone).
  // Scaling means spoke and ring strokes start thin and reach nominal width at
  // full size rather than starting at full width — invisible at 200 ms.
  private core: PIXI.Graphics;
  private rays: PIXI.Graphics;
  private ring: PIXI.Graphics;
  private life = 0;

  constructor(x: number, y: number) {
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;
    const rot = Math.random() * Math.PI;
    // Additive so the impact reads as a bright pop against bodies and sky alike.
    this.core = new PIXI.Graphics(); this.core.blendMode = PIXI.BLEND_MODES.ADD;
    this.core.beginFill(0xffffff, 0.95).drawCircle(0, 0, 1).endFill();   // unit disc, scaled per frame
    this.rays = new PIXI.Graphics(); this.rays.blendMode = PIXI.BLEND_MODES.ADD;
    // Radial spokes — alternating long/short for a starburst feel, at full length.
    for (let i = 0; i < SPARK_RAYS; i++) {
      const a  = rot + SPARK_SEED + (i / SPARK_RAYS) * Math.PI * 2;
      const cx = Math.cos(a), sy = Math.sin(a);
      const rl = i % 2 === 0 ? SPARK_LEN_1 : SPARK_LEN_1 * 0.62;
      this.rays.lineStyle(i % 2 === 0 ? 2.4 : 1.4, SPARK_COLOR, 1);
      this.rays.moveTo(cx * rl * 0.25, sy * rl * 0.25);
      this.rays.lineTo(cx * rl,        sy * rl);
    }
    this.rays.lineStyle(0);
    this.ring = new PIXI.Graphics(); this.ring.blendMode = PIXI.BLEND_MODES.ADD;
    this.ring.lineStyle(2, 0xffe6a0, 0.8).drawCircle(0, 0, RING_R1).lineStyle(0);
    this.container.addChild(this.core, this.rays, this.ring);
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / SPARK_DUR;
    if (t >= 1) { this.isDone = true; return; }

    const ease   = 1 - (1 - t) * (1 - t);   // ease-out for the expansion
    const len    = SPARK_LEN_0 + (SPARK_LEN_1 - SPARK_LEN_0) * ease;
    const ringR  = RING_R0    + (RING_R1    - RING_R0)    * ease;
    const alpha  = 1 - t;

    // White core pop — bright, very short
    const ct = Math.min(1, this.life / 0.06);
    this.core.visible = ct < 1;
    if (ct < 1) { this.core.alpha = 1 - ct; this.core.scale.set(7 * (1 - ct) + 3); }

    this.rays.scale.set(len / SPARK_LEN_1);
    this.rays.alpha = alpha;
    // Expanding shock ring
    this.ring.scale.set(ringR / RING_R1);
    this.ring.alpha = alpha;
  }
}

// ── DeathBurst ──────────────────────────────────────────────────────────────
// The Mega Man death: the body vanishes on the killing blow and the character
// bursts into a ring of pellets that fly straight out and keep going. Two
// concentric rings as in Mega Man 3 onward — an outer ring at full speed and a
// half-speed inner ring offset by half a step, which reads as a sphere blowing
// apart rather than a flat circle. Deliberately unphysical: no gravity, no
// drag, constant speed, and the pellets hold full brightness until they wink
// out near the end of the burst.

const DEATH_DUR        = 0.62;   // seconds — pellets travel this long, then vanish
const DEATH_RAYS       = 8;      // pellets per ring (the classic 8 compass directions)
const DEATH_SPD_OUTER  = 235;    // px/s — ~145 px of travel, about two body heights
const DEATH_SPD_INNER  = 128;    // px/s — trails behind the outer ring
const DEATH_R_OUTER    = 11;     // pellet radius (px) — about a quarter of a body height
const DEATH_R_INNER    = 8;
const DEATH_FADE_FROM  = 0.72;   // fraction of life before alpha starts dropping
const DEATH_FLASH_DUR  = 0.09;   // the one-frame white pop where the body was
const DEATH_FLASH_R    = 26;

class DeathBurst implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  // Each pellet is a once-drawn Graphics moved per frame — the burst used to
  // rebuild all 32 discs every tick for 0.6 s per death.
  private flash:   PIXI.Graphics;
  private pellets: PIXI.Container;
  private nodes:   { g: PIXI.Graphics; dx: number; dy: number }[] = [];   // velocity (px/s) per pellet
  private life = 0;

  constructor(x: number, y: number, side: 'player' | 'enemy') {
    const tint = side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;
    this.flash   = new PIXI.Graphics().beginFill(0xffffff).drawCircle(0, 0, DEATH_FLASH_R).endFill();
    this.pellets = new PIXI.Container();
    this.container.addChild(this.flash, this.pellets);
    // Each pellet: side-tinted disc with a white core, so a glance at the burst
    // still says which side just lost a unit.
    const step = (Math.PI * 2) / DEATH_RAYS;
    const add = (a: number, speed: number, r: number) => {
      const g = new PIXI.Graphics();
      g.beginFill(tint).drawCircle(0, 0, r).endFill();
      g.beginFill(0xffffff).drawCircle(0, 0, r * 0.55).endFill();
      this.pellets.addChild(g);
      this.nodes.push({ g, dx: Math.cos(a) * speed, dy: Math.sin(a) * speed });
    };
    for (let i = 0; i < DEATH_RAYS; i++) {
      const aO = i * step;
      add(aO,              DEATH_SPD_OUTER, DEATH_R_OUTER);
      add(aO + step * 0.5, DEATH_SPD_INNER, DEATH_R_INNER);   // inner ring sits between the outer spokes
    }
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / DEATH_DUR;
    if (t >= 1) { this.isDone = true; return; }

    // Full brightness for most of the flight, then a quick wink-out — a long
    // fade would read as smoke rather than as the retro pellet burst.
    this.pellets.alpha = t < DEATH_FADE_FROM ? 1 : 1 - (t - DEATH_FADE_FROM) / (1 - DEATH_FADE_FROM);
    for (const n of this.nodes) n.g.position.set(n.dx * this.life, n.dy * this.life);

    // White pop at the centre, covering the frame the body disappears on.
    this.flash.visible = this.life < DEATH_FLASH_DUR;
    if (this.flash.visible) {
      const ft = this.life / DEATH_FLASH_DUR;
      this.flash.alpha = 1 - ft;
      this.flash.scale.set(1 - ft * 0.5);
    }
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
  // Drawn once; update() only changes scale and alpha (the flash lasts ~7
  // frames and used to rebuild five shapes on each of them).
  private glow:  PIXI.Graphics;   // soft discs — scaled by `grow`
  private spike: PIXI.Graphics;   // forward barrel spike, unit length — scaled in x as it shortens
  private star:  PIXI.Graphics;   // rear + vertical spikes (fixed)
  private core:  PIXI.Graphics;
  private life = 0;

  constructor(x: number, y: number, dir: 1 | -1 = 1) {
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;
    // Additive blend brightens what's behind the disc — the body sprite under
    // the glow reads as lit, the open background only picks up a faint warmth.
    const add = () => { const g = new PIXI.Graphics(); g.blendMode = PIXI.BLEND_MODES.ADD; this.container.addChild(g); return g; };
    // Soft glow discs (relative alphas baked in; the layer alpha fades them together)
    this.glow = add();
    this.glow.beginFill(GLOW_COLOR_OUTER, 1).drawCircle(0, 0, GLOW_R_OUTER).endFill();
    this.glow.beginFill(GLOW_COLOR_MID, 0.8).drawCircle(0, 0, GLOW_R_MID).endFill();
    // Forward-biased 4-point flash star — long horizontal spike (down the
    // barrel), short vertical ones. Reads as a directional muzzle flash.
    const spikeS = GLOW_R_OUTER * 0.6, fwd = dir;
    this.spike = add();
    this.spike.beginFill(GLOW_COLOR_MID, 1).drawPolygon([fwd, 0, 0, -spikeS * 0.5, 0, spikeS * 0.5]).endFill();
    this.star = add();
    this.star.beginFill(GLOW_COLOR_MID, 1);
    this.star.drawPolygon([0, -spikeS * 0.5, -fwd * spikeS * 0.7, 0, 0, spikeS * 0.5]);   // short rear spike
    this.star.drawPolygon([0, -spikeS, spikeS * 0.35, 0, 0, spikeS, -spikeS * 0.35, 0]);  // vertical short spikes
    this.star.endFill();
    // White-hot core on top
    this.core = add();
    this.core.beginFill(GLOW_COLOR_CORE, 0.7).drawCircle(0, 0, GLOW_R_CORE).endFill();
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / GLOW_DUR;
    if (t >= 1) { this.isDone = true; return; }
    const alpha = (1 - t) * 0.9;
    const grow  = 0.7 + 0.3 * (1 - t);  // pops big then settles
    this.glow.scale.set(grow); this.glow.alpha = alpha;
    this.spike.scale.x = GLOW_R_OUTER * 1.8 * (1 - t) + 8;   // spike length in px (unit polygon)
    this.spike.alpha = this.star.alpha = alpha;
    this.core.scale.set(grow); this.core.alpha = alpha;
  }
}

// ── ShotgunBlast ──────────────────────────────────────────────────────────────
// The shock trooper's shotgun: a punchy muzzle flash plus a forward-fanning cone
// of pellet streaks and a drifting powder-smoke puff. The pellet spread visualises
// the AoE cone the blast actually strikes (same forward reach as attackRange).
// Anchored in world space at the gun tip — does not follow the shooter.

const SHOTGUN_DUR       = 0.24;    // overall lifetime (smoke is the longest layer)
const SHOTGUN_PELLETS   = 16;
const SHOTGUN_CONE_HALF = 0.42;    // half-angle of the pellet fan (radians) ≈ 24°
const SHOTGUN_TAIL      = 0.030;   // seconds of velocity drawn as each pellet's streak
const SHOTGUN_FLASH_DUR = 0.10;    // muzzle flash holds briefly then snaps out
const SHOTGUN_RING_DUR  = 0.17;    // concussive shockwave ring lifetime

interface Pellet { x: number; y: number; vx: number; vy: number; }

class ShotgunBlast implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private smokeG:  PIXI.Graphics;  // normal-blend powder smoke (behind)
  private ringG:   PIXI.Graphics;  // additive concussive shockwave ring
  private pelletG: PIXI.Graphics;  // additive pellet streaks
  private flashG:  PIXI.Graphics;  // additive muzzle flash (front)
  private life = 0;
  private dir:    1 | -1;
  private range:  number;
  private pellets: Pellet[] = [];
  private puffs:   { x: number; y: number; r: number }[] = [];

  constructor(x: number, y: number, dir: 1 | -1, range: number) {
    this.dir = dir;
    this.range = range;
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;

    this.smokeG  = new PIXI.Graphics();
    this.ringG   = new PIXI.Graphics(); this.ringG.blendMode   = PIXI.BLEND_MODES.ADD;
    this.pelletG = new PIXI.Graphics(); this.pelletG.blendMode = PIXI.BLEND_MODES.ADD;
    this.flashG  = new PIXI.Graphics(); this.flashG.blendMode  = PIXI.BLEND_MODES.ADD;
    this.container.addChild(this.smokeG, this.ringG, this.pelletG, this.flashG);

    // Pellets fan out within the cone, the fastest just reaching `range` by end of
    // life. Speed varies so the spread reads as a scattered burst, not a ring.
    const baseSpeed = range / SHOTGUN_DUR;
    for (let i = 0; i < SHOTGUN_PELLETS; i++) {
      const a  = (Math.random() * 2 - 1) * SHOTGUN_CONE_HALF;
      const sp = baseSpeed * (0.55 + Math.random() * 0.5);
      this.pellets.push({ x: 0, y: 0, vx: dir * Math.cos(a) * sp, vy: Math.sin(a) * sp });
    }
    // A few smoke puffs lingering at the barrel.
    for (let i = 0; i < 3; i++) {
      this.puffs.push({
        x: dir * (10 + Math.random() * 14),
        y: (Math.random() - 0.5) * 14,
        r: 7 + Math.random() * 6,
      });
    }
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / SHOTGUN_DUR;
    if (t >= 1) { this.isDone = true; return; }

    // ── Powder smoke (normal blend) — ramps in as the flash dies, drifts forward. ──
    this.smokeG.clear();
    const ramp = Math.min(1, this.life / 0.08);
    const ma   = 0.40 * ramp * (1 - t) * (1 - t);
    if (ma > 0.01) {
      const grow = 0.85 + t * 1.6;
      for (const p of this.puffs) {
        this.smokeG.beginFill(0x6b6b6b, ma);
        this.smokeG.drawCircle(p.x + this.dir * t * 20, p.y - t * 6, p.r * grow);
        this.smokeG.endFill();
      }
    }

    // ── Concussive shockwave ring (additive) — a fast forward-stretched ellipse
    // that snaps outward then fades, giving the blast a percussive "kick". ──
    this.ringG.clear();
    const rt = this.life / SHOTGUN_RING_DUR;
    if (rt < 1) {
      const ease  = 1 - (1 - rt) * (1 - rt);            // ease-out expansion
      const rr    = 10 + (this.range * 0.42) * ease;    // scales with the gun's reach
      const ra    = (1 - rt) * 0.7;
      // Stretched along the barrel (wider forward) so it reads as directional recoil.
      this.ringG.lineStyle(Math.max(1, 5 * (1 - rt)), 0xffe2a8, ra);
      this.ringG.drawEllipse(this.dir * rr * 0.35, 0, rr * 1.15, rr * 0.7);
      this.ringG.lineStyle(0);
    }

    // ── Pellet streaks (additive) ──
    this.pelletG.clear();
    const pa = 1 - t * t;   // hold bright, fade toward the end
    for (const p of this.pellets) { p.x += p.vx * dt; p.y += p.vy * dt; }
    this.pelletG.lineStyle(2.3, 0xffedc0, pa);
    for (const p of this.pellets) {
      this.pelletG.moveTo(p.x - p.vx * SHOTGUN_TAIL, p.y - p.vy * SHOTGUN_TAIL);
      this.pelletG.lineTo(p.x, p.y);
    }
    this.pelletG.lineStyle(0);
    this.pelletG.beginFill(0xfff6df, pa);
    for (const p of this.pellets) this.pelletG.drawCircle(p.x, p.y, 2.0);
    this.pelletG.endFill();

    // ── Muzzle flash (additive, front-loaded) ──
    this.flashG.clear();
    const ft = this.life / SHOTGUN_FLASH_DUR;
    if (ft < 1) {
      const fa   = 1 - ft;
      const grow = 0.7 + 0.3 * fa;
      const fwd  = this.dir;
      this.flashG.beginFill(0xffd0a0, fa * 0.95); this.flashG.drawCircle(0, 0, 32 * grow); this.flashG.endFill();
      this.flashG.beginFill(0xffb060, fa * 0.95); this.flashG.drawCircle(0, 0, 20 * grow); this.flashG.endFill();
      // Forward flash star — long down-barrel spike, short rear + vertical spikes,
      // plus a pair of diagonal spikes for a more ragged, energetic burst.
      const spikeL = 56 * fa + 14;
      const spikeS = 19;
      this.flashG.beginFill(0xfff0c0, fa);
      this.flashG.drawPolygon([ fwd * spikeL, 0,  0, -spikeS * 0.5,  -fwd * spikeS * 0.7, 0,  0, spikeS * 0.5 ]);
      this.flashG.drawPolygon([ 0, -spikeS,  spikeS * 0.32, 0,  0, spikeS,  -spikeS * 0.32, 0 ]);
      const dl = spikeL * 0.5;
      this.flashG.drawPolygon([ fwd * dl, -dl * 0.5,  0, -spikeS * 0.3,  0, spikeS * 0.3,  fwd * dl, dl * 0.5 ]);
      this.flashG.endFill();
      this.flashG.beginFill(0xffffff, fa * 0.9); this.flashG.drawCircle(0, 0, 10 * grow); this.flashG.endFill();
    }
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
  // Every layer except the shockwave ring is drawn ONCE in the constructor and
  // animated by scale / alpha / position in update(). A grenadier volley used
  // to cost ~130 Graphics geometry rebuilds per second from these four layers
  // alone. The ring keeps its per-frame redraw: its stroke thins as it grows,
  // which a scale cannot express.
  private fire:   PIXI.Container;
  private shells: PIXI.Graphics[];   // three concentric unit discs, each with its own alpha
  private core:   PIXI.Graphics;
  private ring:   PIXI.Graphics;
  private sparks: PIXI.Container;
  private smoke:  PIXI.Container;
  private life = 0;
  private r:     number;
  private embers: (Ember & { node: PIXI.Container; tail: PIXI.Graphics })[] = [];
  private puffs:  { g: PIXI.Graphics; y: number }[] = [];

  constructor(x: number, y: number, radius: number) {
    this.r = radius;
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;

    // Smoke (normal blend): four puffs at base size; grown, lifted and faded per frame.
    this.smoke = new PIXI.Container();
    this.smoke.visible = false;
    for (let i = 0; i < 4; i++) {
      const g = new PIXI.Graphics().beginFill(0x3a3a3a).drawCircle(0, 0, radius * (0.3 + Math.random() * 0.35)).endFill();
      g.x = (Math.random() - 0.5) * radius;
      g.y = (Math.random() - 0.5) * radius * 0.6;
      this.smoke.addChild(g);
      this.puffs.push({ g, y: g.y });
    }

    // Fireball (normal blend, opaque): unit discs, the group scaled to the shell radius.
    this.fire = new PIXI.Container();
    this.shells = [[0xd02808, 1], [0xff7a18, 0.7], [0xffd23a, 0.42]].map(([color, k]) => {
      const g = new PIXI.Graphics().beginFill(color).drawCircle(0, 0, k).endFill();
      this.fire.addChild(g);
      return g;
    });

    // Hot core + shockwave ring (additive highlights).
    this.core = new PIXI.Graphics(); this.core.blendMode = PIXI.BLEND_MODES.ADD;
    this.core.beginFill(0xffffff).drawCircle(0, 0, radius * 0.55).endFill();
    this.ring = new PIXI.Graphics(); this.ring.blendMode = PIXI.BLEND_MODES.ADD;

    // Embers (additive): per ember a unit-length tail stretched to EXP_SPARK_TAIL
    // seconds of velocity each frame, plus a fixed bright head.
    this.sparks = new PIXI.Container();
    for (let i = 0; i < EXP_SPARKS; i++) {
      const a  = Math.random() * Math.PI * 2;
      const sp = (0.7 + Math.random() * 1.1) * radius * 5;  // px/s
      const node = new PIXI.Container();
      const tail = new PIXI.Graphics(); tail.blendMode = PIXI.BLEND_MODES.ADD;
      tail.lineStyle(2, 0xffd66b, 1).moveTo(-1, 0).lineTo(0, 0).lineStyle(0);
      const head = new PIXI.Graphics(); head.blendMode = PIXI.BLEND_MODES.ADD;
      head.beginFill(0xffe9a0).drawCircle(0, 0, 1.8).endFill();
      node.addChild(tail, head);
      this.sparks.addChild(node);
      // Slight upward bias (proportional to speed) so embers arc up before gravity pulls them back.
      this.embers.push({ x: 0, y: 0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - sp * 0.3, node, tail });
    }

    this.container.addChild(this.smoke, this.fire, this.core, this.ring, this.sparks);
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / EXP_DUR;
    if (t >= 1) { this.isDone = true; return; }
    const R = this.r;

    // ── Fireball (opaque, normal blend, front-loaded) ──
    const ft = this.life / 0.34;
    this.fire.visible = ft < 1;
    if (ft < 1) {
      const fa = (1 - ft) * (1 - ft);             // hold bright then drop off fast
      this.fire.scale.set(R * (0.35 + 0.8 * ft));
      this.shells[0].alpha = Math.min(1, fa + 0.15);
      this.shells[1].alpha = Math.min(1, fa + 0.2);
      this.shells[2].alpha = Math.min(1, fa + 0.25);
    }

    // ── Hot core + shockwave (additive highlights) ──
    const ct = this.life / 0.09;
    this.core.visible = ct < 1;
    if (ct < 1) { this.core.alpha = (1 - ct) * 0.95; this.core.scale.set(0.6 + ct); }
    const st = this.life / 0.36;
    if (st < 1) {
      const ringR = R * (0.5 + 1.7 * st);
      this.ring.clear();
      this.ring.lineStyle(Math.max(1, 6 * (1 - st)), 0xfff0c0, (1 - st) * 0.85);
      this.ring.drawCircle(0, 0, ringR);
      this.ring.lineStyle(0);
    } else if (this.ring.visible) {
      this.ring.visible = false;
    }

    // ── Embers (additive streaks) ──
    const sa = Math.max(0, 1 - this.life / 0.55);
    this.sparks.visible = sa > 0;
    if (sa > 0) {
      this.sparks.alpha = sa;
      for (const e of this.embers) {
        e.vy += EXP_SPARK_GRAV * dt;
        e.x  += e.vx * dt;
        e.y  += e.vy * dt;
        e.node.position.set(e.x, e.y);
        e.node.rotation = Math.atan2(e.vy, e.vx);
        e.tail.scale.x  = Math.hypot(e.vx, e.vy) * EXP_SPARK_TAIL;
      }
    }

    // ── Smoke (normal blend) — ramps in as the fireball dies, then rises/fades.
    // Sits behind the opaque fireball, so it only becomes visible once the fire
    // thins out (no muddy grey over the initial flash).
    const ramp = Math.min(1, this.life / 0.25);          // fade in over first 0.25s
    const ma   = 0.42 * ramp * (1 - t) * (1 - t);
    this.smoke.visible = ma > 0.01;
    if (ma > 0.01) {
      this.smoke.alpha = ma;
      const grow = 0.8 + t * 1.1, rise = t * R * 0.6;
      for (const p of this.puffs) { p.g.scale.set(grow); p.g.y = p.y - rise; }
    }
  }
}

// ── AfterImage ────────────────────────────────────────────────────────────────
// A fading ghost copy of a character's body+legs sprite frames, dropped in world
// space while a speed power-up is active. Each part reuses the live frame Texture
// (no new GPU texture allocated) and copies the source sprite's anchor, scale
// (including facing flip), and rotation, so the ghost matches the character
// exactly. Anchored where it spawns — the character glides ahead of the trail.
// Visual-only: never touches physics, collision, or hitboxes.

const AFTERIMAGE_DUR     = 0.26;   // seconds to fade fully out (in the 200–300 ms range)
const AFTERIMAGE_ALPHA_0 = 0.4;    // starting opacity (~40%)

export interface AfterImagePart {
  texture:  PIXI.Texture;
  x:        number;   // world position of the source sprite
  y:        number;
  anchorX:  number;
  anchorY:  number;
  scaleX:   number;   // includes facing flip (negative when facing left)
  scaleY:   number;
  rotation: number;
}

class AfterImage implements VfxEffect {
  container: PIXI.Container;
  isDone   = false;
  private life = 0;

  constructor(parts: AfterImagePart[]) {
    this.container = new PIXI.Container();
    for (const p of parts) {
      const s = new PIXI.Sprite(p.texture);
      s.position.set(p.x, p.y);
      s.anchor.set(p.anchorX, p.anchorY);
      s.scale.set(p.scaleX, p.scaleY);
      s.rotation = p.rotation;
      this.container.addChild(s);
    }
    this.container.alpha = AFTERIMAGE_ALPHA_0;
  }

  update(dt: number): void {
    this.life += dt;
    const t = this.life / AFTERIMAGE_DUR;
    if (t >= 1) { this.isDone = true; return; }
    this.container.alpha = AFTERIMAGE_ALPHA_0 * (1 - t);
  }
}

// ── Spawn helpers ───────────────────────────────────────────────────────────

export function spawnSlashArc(x: number, y: number, dir: 1 | -1, side: 'player' | 'enemy'): void {
  register(new SlashArc(x, y, dir, side));
}

/** Drop a fading ghost of the supplied sprite layers into the afterimage layer
 *  (behind characters). No-op if there are no parts (e.g. Graphics-rendered units). */
export function spawnAfterImage(parts: AfterImagePart[]): void {
  if (parts.length === 0) return;
  register(new AfterImage(parts), afterImageLayer);
}

export function spawnExplosion(x: number, y: number, radius: number): void {
  register(new Explosion(x, y, radius));
}

export function spawnHitSpark(x: number, y: number): void {
  register(new HitSpark(x, y));
}

/** Mega Man-style death: a ring of pellets bursting out of where the body was.
 *  Spawned at the character's torso as it is culled — the body is already gone. */
export function spawnDeathBurst(x: number, y: number, side: 'player' | 'enemy'): void {
  register(new DeathBurst(x, y, side));
}

/** Shield-block flash: vertical crescent facing `dir` (toward the attacker). */
export function spawnBlockFlash(x: number, y: number, dir: 1 | -1): void {
  register(new BlockFlash(x, y, dir));
}

/** Aggression-buff shockwave pulse centred on the character's torso. */
export function spawnAggroWave(x: number, y: number): void {
  register(new AggroWave(x, y));
}

export function spawnMuzzleGlow(x: number, y: number, dir: 1 | -1 = 1): void {
  register(new MuzzleGlow(x, y, dir));
}

/** Shock trooper shotgun: muzzle flash + a forward-fanning pellet cone reaching
 *  roughly `range` px, plus a powder-smoke puff. */
export function spawnShotgunBlast(x: number, y: number, dir: 1 | -1, range: number): void {
  register(new ShotgunBlast(x, y, dir, range));
}

export function spawnSpeedStreak(x: number, feetY: number, charH: number, dir: 1 | -1): void {
  register(new SpeedStreak(x, feetY, charH, dir));
}
