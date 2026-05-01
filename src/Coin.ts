import * as PIXI from 'pixi.js';
import Matter from 'matter-js';
import { GROUND_Y, PLAYER_TOWER_X, ENEMY_TOWER_X, TOWER_WIDTH } from './constants';
import type { Physics } from './Physics';
import type { PlatformData } from './Platform';

const LAND_Y = GROUND_Y - 14;

export type CoinKind = 'gold' | 'silver';

export const COIN_PALETTE: Record<CoinKind, readonly [number, number, number, number]> = {
  gold:   [0xf0a500, 0xffd166, 0xf0a500, 0xfffab0],
  silver: [0x909090, 0xbfbfbf, 0x909090, 0xe8e8e8],
};

export class Coin {
  x: number;
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

  body:    Matter.Body;
  private physics:     Physics;
  private bodyInWorld = true;
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
    physics?: Physics,
    dt     = 1 / 60,
  ) {
    this.x     = x;
    this.y     = initY < 0 ? LAND_Y + initY : initY;
    this.value = value;
    this.kind  = kind;
    this.lifetimeRemaining = lifetimeSec;

    this.container = new PIXI.Container();
    this.gfx       = new PIXI.Graphics();
    this.drawCoin();
    this.container.addChild(this.gfx);
    this.container.x = x;
    this.container.y = this.y;

    // Physics body — created even without a Physics instance for safety,
    // but only added to the world when physics is provided.
    if (physics) {
      this.physics = physics;
      this.body    = physics.createCoinBody(this.x, this.y, initVx, initVy, dt);
    } else {
      // Fallback: dummy (never added to world)
      this.physics = null!;
      this.body    = Matter.Bodies.circle(this.x, this.y, 10);
    }
  }

  private drawCoin() {
    const [outer, mid, inner, hi] = COIN_PALETTE[this.kind];
    this.gfx.clear();
    this.gfx.beginFill(outer);      this.gfx.drawCircle(0, 0, 10);     this.gfx.endFill();
    this.gfx.beginFill(mid);        this.gfx.drawCircle(0, 0, 7);      this.gfx.endFill();
    this.gfx.beginFill(inner);      this.gfx.drawCircle(0, 0, 4);      this.gfx.endFill();
    this.gfx.beginFill(hi, 0.85);   this.gfx.drawCircle(-3, -3, 2.5);  this.gfx.endFill();
  }

  update(dt: number, platforms: PlatformData[] = []) {
    if (this.isDead || this.isPickedUp) return;

    // Kill coin instantly if it travels beyond either tower
    const leftBound  = PLAYER_TOWER_X - TOWER_WIDTH / 2;
    const rightBound = ENEMY_TOWER_X  + TOWER_WIDTH / 2;
    if (this.x < leftBound || this.x > rightBound) {
      this.isDead = true;
      return;
    }

    this.timer += dt;

    if (!this.isOnGround) {
      // Read position from Matter.js body
      this.x = this.body.position.x;
      this.y = this.body.position.y;

      const speed = Math.sqrt(
        this.body.velocity.x * this.body.velocity.x +
        this.body.velocity.y * this.body.velocity.y,
      );

      // Settle when nearly stopped and close to a surface (ground or platform).
      if (speed < 0.05) {
        const platBelow = platforms.find(
          p => this.x >= p.x && this.x <= p.x + p.width &&
               this.y >= p.y - 35 && this.y <= p.y + 5,
        );
        const nearGround = this.y >= GROUND_Y - 35;

        if (platBelow || nearGround) {
          this.isOnGround = true;
          this.floorY     = platBelow ? platBelow.y : GROUND_Y;
          Matter.Body.setStatic(this.body, true);
          this.y = this.floorY === GROUND_Y ? LAND_Y : this.floorY - 14;
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
    }

    this.gfx.rotation += dt * 1.8;
  }

  pickup() {
    this.isPickedUp        = true;
    this.isDead            = true;
    this.container.visible = false;
    this.removePhysicsBody();
  }

  destroy() {
    this.removePhysicsBody();
    this.container.destroy({ children: true });
  }

  private removePhysicsBody() {
    if (this.physics && this.bodyInWorld) {
      this.physics.removeBody(this.body);
      this.bodyInWorld = false;
    }
  }
}
