import * as PIXI from 'pixi.js';
import Matter from 'matter-js';
import {
  GROUND_Y,
  POWERUP_PICKUP_DIST, POWERUP_LIFETIME_S, POWERUP_BOB_AMP, POWERUP_BOB_FREQ, POWERUP_BODY_RADIUS,
} from './constants';
import type { Physics } from './Physics';
import type { PlatformData } from './Platform';

export type PowerUpType = 'heal' | 'speed' | 'attack' | 'promote';

const TYPE_COLOR: Record<PowerUpType, number> = {
  heal:    0x44dd88,
  speed:   0x44aaff,
  attack:  0xff8833,
  promote: 0xf0e040,
};

export class PowerUp {
  readonly type: PowerUpType;
  x: number;
  y: number;
  isDead     = false;
  isPickedUp = false;
  isOnGround = false;
  floorY     = GROUND_Y;

  readonly body:      Matter.Body;
  readonly container: PIXI.Container;
  private gfx:        PIXI.Graphics;
  private icon:       PIXI.Graphics;
  private physics:    Physics;
  private bodyInWorld = true;

  private settledY       = 0;
  private timer          = 0;
  private floatT         = 0;
  private lastDrawAlpha  = -1;

  constructor(x: number, type: PowerUpType, physics: Physics) {
    this.x       = x;
    this.y       = -POWERUP_BODY_RADIUS;
    this.type    = type;
    this.physics = physics;
    this.body    = physics.createPowerUpBody(x, this.y);

    this.container = new PIXI.Container();
    this.gfx       = new PIXI.Graphics();
    this.icon      = new PIXI.Graphics();
    this.container.addChild(this.gfx);
    this.container.addChild(this.icon);

    this.draw(1);
  }

  // ── Draw ──────────────────────────────────────────────────────────────────

  private draw(alpha: number) {
    if (Math.abs(alpha - this.lastDrawAlpha) < 0.01) return;
    this.lastDrawAlpha = alpha;
    const color = TYPE_COLOR[this.type];

    this.gfx.clear();
    this.gfx.lineStyle(2, color, 0.35 * alpha);
    this.gfx.drawCircle(0, 0, 22);
    this.gfx.lineStyle(0);
    this.gfx.beginFill(0x111122, 0.82 * alpha);
    this.gfx.drawCircle(0, 0, 18);
    this.gfx.endFill();
    this.gfx.lineStyle(2.5, color, alpha);
    this.gfx.drawCircle(0, 0, 18);
    this.gfx.lineStyle(0);

    this.icon.clear();
    this.icon.beginFill(color, alpha);
    if (this.type === 'heal') {
      this.icon.drawRect(-3, -10, 6, 20);
      this.icon.drawRect(-10, -3, 20, 6);
    } else if (this.type === 'speed') {
      this.icon.drawPolygon([2, -11, -4, 1, 2, 1, -2, 11, 8, -3, 2, -3]);
    } else if (this.type === 'attack') {
      this.icon.drawPolygon([0, -11, 6, -3, 2, -3, 2, 11, -2, 11, -2, -3, -6, -3]);
    } else {
      // Promote: 5-pointed star
      const R = 10, r = 4.5, pts = 5;
      const verts: number[] = [];
      for (let i = 0; i < pts * 2; i++) {
        const ang = (i * Math.PI / pts) - Math.PI / 2;
        const rad = i % 2 === 0 ? R : r;
        verts.push(Math.cos(ang) * rad, Math.sin(ang) * rad);
      }
      this.icon.drawPolygon(verts);
    }
    this.icon.endFill();
  }

  // ── Update ────────────────────────────────────────────────────────────────

  update(dt: number, platforms: PlatformData[], blocks: PlatformData[] = []) {
    if (this.isDead || this.isPickedUp) return;

    if (!this.isOnGround) {
      this.x = this.body.position.x;
      this.y = this.body.position.y;

      const speed = Math.hypot(this.body.velocity.x, this.body.velocity.y);

      if (speed < 0.05) {
        const platBelow = platforms.find(p =>
          this.x >= p.x && this.x <= p.x + p.width &&
          this.y >= p.y - 40 && this.y <= p.y + 5,
        );
        const blockBelow = blocks.find(b =>
          this.x >= b.x && this.x <= b.x + b.width &&
          this.y >= b.y - 40 && this.y <= b.y + 5,
        );
        const nearGround = this.y >= GROUND_Y - 40;

        if (platBelow || blockBelow || nearGround) {
          this.isOnGround = true;
          this.floorY     = platBelow ? platBelow.y : blockBelow ? blockBelow.y : GROUND_Y;
          this.settledY   = this.floorY - POWERUP_BODY_RADIUS;
          Matter.Body.setStatic(this.body, true);
          this.y = this.settledY;
          // Draw once at full opacity on settle; blink is handled via container.alpha
          this.draw(1);
          this.container.alpha = 1;
        }
      }

      this.container.x = this.x;
      this.container.y = this.y;
      return;
    }

    // Resting: lifetime + bob
    this.timer  += dt;
    this.floatT += dt;

    if (this.timer >= POWERUP_LIFETIME_S) {
      this.isDead = true;
      return;
    }

    this.y = this.settledY + Math.sin(this.floatT * POWERUP_BOB_FREQ * Math.PI * 2) * POWERUP_BOB_AMP;

    // Blink via container.alpha instead of redrawing graphics each frame
    this.container.alpha = this.timer > POWERUP_LIFETIME_S - 4
      ? 0.3 + 0.7 * Math.abs(Math.sin(this.timer * 5))
      : 1;

    this.container.x = this.x;
    this.container.y = this.y;
  }

  // ── Pickup ────────────────────────────────────────────────────────────────

  tryPickup(chars: { x: number; y: number; isDead: boolean }[]): number {
    if (!(this.isOnGround || this.y >= GROUND_Y - 35) || this.isDead || this.isPickedUp) return -1;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c.isDead) continue;
      if (Math.hypot(c.x - this.x, c.y - this.y) <= POWERUP_PICKUP_DIST) return i;
    }
    return -1;
  }

  collect() {
    this.isPickedUp         = true;
    this.isDead             = true;
    this.container.visible  = false;
    this.removeBody();
  }

  destroy() {
    this.removeBody();
    this.container.destroy({ children: true });
  }

  private removeBody() {
    if (this.bodyInWorld) {
      this.physics.removeBody(this.body);
      this.bodyInWorld = false;
    }
  }
}
