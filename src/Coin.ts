import * as PIXI from 'pixi.js';
import {
  GROUND_Y, COIN_GRAVITY,
  COIN_BOUNCE_DAMPING, COIN_BOUNCE_X_FRICTION, COIN_BOUNCE_SETTLE_VY,
  COIN_BOUNCE_INIT_VX_MIN, COIN_BOUNCE_INIT_VX_MAX,
} from './constants';
import type { PlatformData } from './Platform';

const LAND_Y = GROUND_Y - 14;

export type CoinKind = 'gold' | 'silver';

// [outer, mid, inner, highlight] — shared by Coin and Character carry visual
export const COIN_PALETTE: Record<CoinKind, readonly [number, number, number, number]> = {
  gold:   [0xf0a500, 0xffd166, 0xf0a500, 0xfffab0],
  silver: [0x909090, 0xbfbfbf, 0x909090, 0xe8e8e8],
};

export class Coin {
  x: number;   // mutable — dropped coins drift horizontally
  y: number;

  readonly kind:  CoinKind;
  readonly value: number;

  readonly container: PIXI.Container;
  private gfx: PIXI.Graphics;

  isOnGround = false;
  isPickedUp = false;
  isDead     = false;
  floorY     = GROUND_Y;

  get isOnPlatform() { return this.isOnGround && this.floorY < GROUND_Y; }

  private vx: number;
  private vy: number;
  private timer             = 0;
  private lifetimeRemaining: number;

  constructor(
    x: number,
    lifetimeSec: number,
    value: number,
    kind:   CoinKind = 'gold',
    initVx = 0,
    initVy = 0,
    initY  = -20,
  ) {
    this.x     = x;
    this.y     = initY;
    this.value = value;
    this.kind  = kind;
    this.vx    = initVx;
    this.vy    = initVy;
    this.lifetimeRemaining = lifetimeSec;

    this.container = new PIXI.Container();
    this.gfx       = new PIXI.Graphics();
    this.drawCoin();
    this.container.addChild(this.gfx);
    this.container.x = x;
    this.container.y = this.y;
  }

  private drawCoin() {
    const [outer, mid, inner, hi] = COIN_PALETTE[this.kind];
    this.gfx.clear();
    this.gfx.beginFill(outer);      this.gfx.drawCircle(0, 0, 10);     this.gfx.endFill();
    this.gfx.beginFill(mid);        this.gfx.drawCircle(0, 0, 7);      this.gfx.endFill();
    this.gfx.beginFill(inner);      this.gfx.drawCircle(0, 0, 4);      this.gfx.endFill();
    this.gfx.beginFill(hi, 0.85);   this.gfx.drawCircle(-3, -3, 2.5);  this.gfx.endFill();
  }

  // Resolves a landing: either bounces the coin or settles it on the surface.
  private bounce(surfaceY: number, surfaceFloorY: number) {
    const bounceVy = -this.vy * COIN_BOUNCE_DAMPING;
    if (Math.abs(bounceVy) < COIN_BOUNCE_SETTLE_VY) {
      this.y          = surfaceY;
      this.vy         = 0;
      this.vx         = 0;
      this.isOnGround = true;
      this.floorY     = surfaceFloorY;
    } else {
      this.y      = surfaceY;
      this.vy     = bounceVy;
      this.floorY = surfaceFloorY;
      if (Math.abs(this.vx) < 10) {
        // Spawn-drop coins arrive with no horizontal velocity — kick them sideways.
        const sign = Math.random() < 0.5 ? 1 : -1;
        this.vx = sign * (COIN_BOUNCE_INIT_VX_MIN + Math.random() * (COIN_BOUNCE_INIT_VX_MAX - COIN_BOUNCE_INIT_VX_MIN));
      } else {
        this.vx *= COIN_BOUNCE_X_FRICTION;
      }
    }
  }

  update(dt: number, platforms: PlatformData[] = []) {
    if (this.isDead || this.isPickedUp) return;

    this.timer += dt;

    if (!this.isOnGround) {
      this.vy += COIN_GRAVITY * dt;
      this.x  += this.vx * dt;
      this.y  += this.vy * dt;

      if (this.vy > 0) {
        // Platform landing
        for (const p of platforms) {
          const platLandY = p.y - 14;
          if (this.x >= p.x && this.x <= p.x + p.width && this.y >= platLandY) {
            this.bounce(platLandY, p.y);
            break;
          }
        }
        // Ground landing
        if (!this.isOnGround && this.y >= LAND_Y) {
          this.bounce(LAND_Y, GROUND_Y);
        }
      }

      this.container.x = this.x;
      this.container.y = this.y;
      return;
    }

    // Resting: count down lifetime, animate
    this.lifetimeRemaining -= dt;
    if (this.lifetimeRemaining <= 0) {
      this.isDead = true;
      return;
    }

    if (this.lifetimeRemaining < 5) {
      this.container.alpha = 0.35 + 0.65 * Math.abs(Math.sin(this.timer * 6));
    } else {
      this.container.alpha = 1;
      this.container.y = this.y + Math.sin(this.timer * 2.8) * 2.5;
    }

    this.gfx.rotation += dt * 1.8;
  }

  pickup() {
    this.isPickedUp        = true;
    this.isDead            = true;
    this.container.visible = false;
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
