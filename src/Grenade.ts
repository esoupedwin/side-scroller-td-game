import * as PIXI from 'pixi.js';
import type { Side } from './Tower';
import type { Character } from './Character';
import type { PlatformData } from './Platform';
import { GROUND_Y } from './constants';

const EXPLODE_DUR = 0.5;   // seconds the explosion ring expands

export class Grenade {
  readonly side: Side;
  x: number;
  y: number;
  isDead = false;

  private vx: number;
  private vy: number;
  private elapsed     = 0;
  private exploding   = false;
  private explodeTimer = 0;

  private readonly fuseSec:      number;
  private readonly splashRadius: number;
  private readonly damage:       number;
  private readonly gravity:      number;
  private readonly shooter:      Character | null;

  private pendingExplosion: { x: number; y: number; radius: number; damage: number } | null = null;

  readonly container: PIXI.Container;
  private gfx:        PIXI.Graphics;
  private explodeGfx: PIXI.Graphics;

  constructor(
    side:         Side,
    sx: number,   sy: number,
    tx: number,
    damage:       number,
    fuseSec:      number,
    splashRadius: number,
    gravity:      number,
    maxVx:        number,
    shooter:      Character | null = null,
  ) {
    this.side         = side;
    this.x            = sx;
    this.y            = sy;
    this.damage       = damage;
    this.fuseSec      = fuseSec;
    this.splashRadius = splashRadius;
    this.gravity      = gravity;
    this.shooter      = shooter;

    // 60° launch angle: always use at least 45% of maxVx so the arc is visible;
    // scale up for distant targets so the grenade still arcs convincingly.
    const dx    = tx - sx;
    const vxAbs = Math.max(maxVx * 0.45, Math.min(Math.abs(dx) * 0.55, maxVx));
    this.vx = Math.sign(dx || 1) * vxAbs;
    this.vy = -vxAbs * Math.sqrt(3);   // tan(60°) = √3 → exactly 60° above horizontal

    this.container  = new PIXI.Container();
    this.explodeGfx = new PIXI.Graphics();
    this.gfx        = new PIXI.Graphics();
    this.container.addChild(this.explodeGfx);
    this.container.addChild(this.gfx);

    this.drawGrenade();
    this.container.x = sx;
    this.container.y = sy;
  }

  private drawGrenade() {
    this.gfx.clear();

    // Olive body
    this.gfx.beginFill(0x4a5a2a);
    this.gfx.drawCircle(0, 0, 6);
    this.gfx.endFill();

    // Segmentation lines
    this.gfx.lineStyle(0.8, 0x2a3a12, 0.8);
    this.gfx.moveTo(-6, 0); this.gfx.lineTo(6, 0);
    this.gfx.moveTo(0, -6); this.gfx.lineTo(0, 6);
    this.gfx.lineStyle(0);

    // Handle stub
    this.gfx.beginFill(0x2a2a2a);
    this.gfx.drawRect(-2, 5, 4, 6);
    this.gfx.endFill();

    // Safety lever
    this.gfx.beginFill(0xaaaaaa);
    this.gfx.drawRect(3, -4, 5, 2);
    this.gfx.endFill();

    // Fuse tip (yellow dot at top)
    this.gfx.beginFill(0xffcc00, 0.9);
    this.gfx.drawCircle(0, -5.5, 1.5);
    this.gfx.endFill();
  }

  update(dt: number, platforms: PlatformData[]) {
    if (this.isDead) return;

    if (this.exploding) {
      this.explodeTimer += dt;
      const t     = Math.min(1, this.explodeTimer / EXPLODE_DUR);
      const alpha = 1 - t;
      const r     = this.splashRadius * t;

      this.explodeGfx.clear();
      this.explodeGfx.beginFill(0xff4400, alpha * 0.15);
      this.explodeGfx.drawCircle(0, 0, r);
      this.explodeGfx.endFill();
      this.explodeGfx.lineStyle(2, 0xffcc00, alpha * 0.7);
      this.explodeGfx.drawCircle(0, 0, r * 0.55);
      this.explodeGfx.lineStyle(3, 0xff6600, alpha);
      this.explodeGfx.drawCircle(0, 0, r);

      if (this.explodeTimer >= EXPLODE_DUR) this.isDead = true;
      return;
    }

    this.elapsed += dt;
    const prevY   = this.y;
    this.vy      += this.gravity * dt;
    this.x       += this.vx * dt;
    this.y       += this.vy * dt;

    // Platform collision — one-way, tunneling-safe (same logic as character syncFromBody)
    if (this.vy >= 0) {
      for (const p of platforms) {
        if (this.x >= p.x && this.x <= p.x + p.width && prevY <= p.y && this.y >= p.y) {
          this.y = p.y;
          this.bounce();
          break;
        }
      }
    }

    // Ground collision — bounce until settled
    if (this.y >= GROUND_Y) {
      this.y = GROUND_Y;
      this.bounce();
    }

    this.gfx.rotation += (this.vx > 0 ? 1 : -1) * 4.5 * dt;

    this.container.x = this.x;
    this.container.y = this.y;

    if (this.elapsed >= this.fuseSec) this.explode();
  }

  private bounce() {
    if (Math.abs(this.vy) > 80) {
      this.vy = -this.vy * 0.42;
      this.vx *= 0.72;
    } else {
      this.vy  = 0;
      this.vx *= 0.88;
    }
  }

  private explode() {
    this.exploding        = true;
    this.pendingExplosion = { x: this.x, y: this.y, radius: this.splashRadius, damage: this.damage };
    this.gfx.visible      = false;

    // Immediate white flash at explosion centre
    this.explodeGfx.clear();
    this.explodeGfx.beginFill(0xffffff, 0.9);
    this.explodeGfx.drawCircle(0, 0, this.splashRadius * 0.22);
    this.explodeGfx.endFill();
  }

  consumeExplosion(): { x: number; y: number; radius: number; damage: number; shooter: Character | null } | null {
    if (!this.pendingExplosion) return null;
    const e = { ...this.pendingExplosion, shooter: this.shooter };
    this.pendingExplosion = null;
    return e;
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
