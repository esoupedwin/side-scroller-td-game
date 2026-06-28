import * as PIXI from 'pixi.js';
import type { Side } from './Tower';
import type { Character } from './Character';
import type { PlatformData } from './Platform';
import type { BlockData } from './Block';
import { GROUND_Y } from './constants';

const EXPLODE_DUR = 0.4;   // seconds the explosion ring expands

export class Rocket {
  readonly side: Side;
  x: number;
  y: number;
  isDead = false;

  private vx: number;
  private vy: number;
  private elapsed      = 0;
  private exploding    = false;
  private explodeTimer = 0;
  private flameTimer   = 0;

  private readonly fuseSec:      number;
  private readonly splashRadius: number;
  private readonly damage:       number;
  private readonly gravity:      number;
  private readonly shooter:      Character | null;
  private readonly groundY:      number;

  private pendingExplosion: { x: number; y: number; radius: number; damage: number } | null = null;

  readonly container: PIXI.Container;
  private gfx:        PIXI.Graphics;
  private flameGfx:   PIXI.Graphics;
  private explodeGfx: PIXI.Graphics;

  constructor(
    side:         Side,
    sx: number,   sy: number,
    tx: number,
    damage:       number,
    fuseSec:      number,
    splashRadius: number,
    gravity:      number,
    launchVx:     number,
    shooter:      Character | null = null,
    groundY:      number = GROUND_Y,
  ) {
    this.side         = side;
    this.x            = sx;
    this.y            = sy;
    this.damage       = damage;
    this.fuseSec      = fuseSec;
    this.splashRadius = splashRadius;
    this.gravity      = gravity;
    this.shooter      = shooter;
    this.groundY      = groundY;

    const dx  = tx - sx;
    this.vx   = Math.sign(dx || 1) * launchVx;
    this.vy   = -launchVx * 0.2;   // slight upward kick for a flat arc

    this.container  = new PIXI.Container();
    this.explodeGfx = new PIXI.Graphics();
    this.flameGfx   = new PIXI.Graphics();
    this.gfx        = new PIXI.Graphics();
    this.container.addChild(this.explodeGfx);
    this.container.addChild(this.flameGfx);
    this.container.addChild(this.gfx);

    this.drawRocket();
    this.drawFlame();
    this.container.x = sx;
    this.container.y = sy;
  }

  private drawRocket() {
    this.gfx.clear();

    // Body — grey tube pointing right by default; rotated in update()
    this.gfx.beginFill(0x7a7a8a);
    this.gfx.drawRoundedRect(-12, -4, 24, 8, 3);
    this.gfx.endFill();

    // Nose cone — red tip at the right (+x) end
    this.gfx.beginFill(0xcc3300);
    this.gfx.moveTo(12, -4);
    this.gfx.lineTo(20, 0);
    this.gfx.lineTo(12, 4);
    this.gfx.closePath();
    this.gfx.endFill();

    // Fins at the tail — dark blue-grey triangles at the left (-x) end
    this.gfx.beginFill(0x445566);
    this.gfx.moveTo(-12, -4);
    this.gfx.lineTo(-20, -11);
    this.gfx.lineTo(-16, -4);
    this.gfx.closePath();
    this.gfx.endFill();
    this.gfx.beginFill(0x445566);
    this.gfx.moveTo(-12, 4);
    this.gfx.lineTo(-20, 11);
    this.gfx.lineTo(-16, 4);
    this.gfx.closePath();
    this.gfx.endFill();

    // Exhaust nozzle — darker ring at the tail
    this.gfx.beginFill(0x303040);
    this.gfx.drawRect(-15, -3.5, 4, 7);
    this.gfx.endFill();
  }

  private drawFlame() {
    this.flameGfx.clear();
    const len    = 10 + Math.random() * 10;
    const spread =  3 + Math.random() * 2;
    // Orange flame extends behind the rocket (−x when pointing right)
    this.flameGfx.beginFill(0xff8800, 0.85);
    this.flameGfx.moveTo(-15, -spread);
    this.flameGfx.lineTo(-15 - len, 0);
    this.flameGfx.lineTo(-15, spread);
    this.flameGfx.closePath();
    this.flameGfx.endFill();
    // Inner yellow core
    this.flameGfx.beginFill(0xffdd00, 0.7);
    this.flameGfx.moveTo(-15, -spread * 0.4);
    this.flameGfx.lineTo(-15 - len * 0.6, 0);
    this.flameGfx.lineTo(-15, spread * 0.4);
    this.flameGfx.closePath();
    this.flameGfx.endFill();
  }

  update(dt: number, platforms: PlatformData[], blocks: BlockData[] = []) {
    if (this.isDead) return;

    if (this.exploding) {
      this.explodeTimer += dt;
      const t     = Math.min(1, this.explodeTimer / EXPLODE_DUR);
      const alpha = 1 - t;
      const r     = this.splashRadius * t;

      this.explodeGfx.clear();
      this.explodeGfx.beginFill(0xff6600, alpha * 0.18);
      this.explodeGfx.drawCircle(0, 0, r);
      this.explodeGfx.endFill();
      this.explodeGfx.lineStyle(2.5, 0xff8800, alpha * 0.8);
      this.explodeGfx.drawCircle(0, 0, r * 0.5);
      this.explodeGfx.lineStyle(3, 0xff3300, alpha);
      this.explodeGfx.drawCircle(0, 0, r);

      if (this.explodeTimer >= EXPLODE_DUR) this.isDead = true;
      return;
    }

    this.elapsed += dt;
    const prevX   = this.x;
    const prevY   = this.y;
    this.vy      += this.gravity * dt;
    this.x       += this.vx * dt;
    this.y       += this.vy * dt;

    // Block — explode on contact (solid from all sides)
    for (const b of blocks) {
      if (this.x >= b.x && this.x <= b.x + b.width &&
          this.y >= b.y && this.y <= b.y + b.height) {
        this.x = prevX;
        this.y = prevY;
        this.explode();
        return;
      }
    }

    // Platform — one-way; explode on top surface hit
    if (this.vy >= 0) {
      for (const p of platforms) {
        if (this.x >= p.x && this.x <= p.x + p.width && prevY <= p.y && this.y >= p.y) {
          this.y = p.y;
          this.explode();
          return;
        }
      }
    }

    // Ground
    if (this.y >= this.groundY) {
      this.y = this.groundY;
      this.explode();
      return;
    }

    // Flame flicker
    this.flameTimer += dt;
    if (this.flameTimer >= 0.05) {
      this.flameTimer = 0;
      this.drawFlame();
    }

    // Rotate to match velocity direction
    this.container.rotation = Math.atan2(this.vy, this.vx);
    this.container.x = this.x;
    this.container.y = this.y;

    if (this.elapsed >= this.fuseSec) this.explode();
  }

  triggerHit() {
    if (!this.exploding && !this.isDead) this.explode();
  }

  private explode() {
    this.exploding        = true;
    this.pendingExplosion = { x: this.x, y: this.y, radius: this.splashRadius, damage: this.damage };
    this.gfx.visible      = false;
    this.flameGfx.visible = false;

    // Immediate white flash
    this.explodeGfx.clear();
    this.explodeGfx.beginFill(0xffffff, 0.9);
    this.explodeGfx.drawCircle(0, 0, this.splashRadius * 0.18);
    this.explodeGfx.endFill();

    this.container.rotation = 0;
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
