import * as PIXI from 'pixi.js';
import Matter from 'matter-js';
import { GROUND_Y, PLAYER_TOWER_X, ENEMY_TOWER_X, TOWER_WIDTH } from './constants';

const DEFAULT_WALL_L = PLAYER_TOWER_X - TOWER_WIDTH / 2;
const DEFAULT_WALL_R = ENEMY_TOWER_X  + TOWER_WIDTH / 2;
import type { Physics } from './Physics';
import type { PlatformData } from './Platform';

export type CoinKind = 'gold' | 'silver' | 'blue';

export const COIN_PALETTE: Record<CoinKind, readonly [number, number, number, number]> = {
  gold:   [0xf0a500, 0xffd166, 0xf0a500, 0xfffab0],
  silver: [0x909090, 0xbfbfbf, 0x909090, 0xe8e8e8],
  blue:   [0x0d47a1, 0x2196f3, 0x0d47a1, 0xbbe1ff],   // rare, high-value sapphire coin
};

/**
 * Built-in default coin skins (PNGs served from public/sprites/coins/). Applied
 * to every coin of that kind unless the map's own `coinSkins` provides an
 * override. The blue (jackpot) coin is reskinned as the purple coin art.
 */
const DEFAULT_COIN_SKINS: Partial<Record<CoinKind, string>> = {
  gold:   '/sprites/coins/coin_gold.png',
  silver: '/sprites/coins/coin_silver.png',
  blue:   '/sprites/coins/coin_purple.png',
};

export class Coin {
  x: number;
  y: number;

  readonly kind:  CoinKind;
  readonly value: number;
  /** Effective skin URL (map override or built-in default), or undefined for the
   *  procedural coin. Read by a carrying character to skin its carry visual. */
  readonly skin?: string;

  readonly container: PIXI.Container;
  private gfx: PIXI.Graphics;

  isOnGround = false;
  isPickedUp = false;
  isDead     = false;
  floorY:    number;

  private readonly groundY: number;
  private readonly landY:   number;

  get isOnPlatform() { return this.isOnGround && this.floorY < this.groundY; }

  body:    Matter.Body;
  private physics:     Physics;
  private bodyInWorld = true;
  private timer             = 0;
  private lifetimeRemaining: number;
  private readonly wallBoundsL: number;
  private readonly wallBoundsR: number;

  constructor(
    x: number,
    lifetimeSec: number,
    value: number,
    kind:       CoinKind = 'gold',
    initVx      = 0,
    initVy      = 0,
    initY       = -20,
    physics?:   Physics,
    dt          = 1 / 60,
    wallBoundsL = DEFAULT_WALL_L,
    wallBoundsR = DEFAULT_WALL_R,
    groundY     = GROUND_Y,
    skin?:      string,
  ) {
    this.groundY     = groundY;
    this.landY       = groundY - 14;
    this.floorY      = groundY;
    this.x           = x;
    this.y           = initY < 0 ? this.landY + initY : initY;
    this.value       = value;
    this.kind        = kind;
    this.wallBoundsL = wallBoundsL;
    this.wallBoundsR = wallBoundsR;
    this.lifetimeRemaining = lifetimeSec;

    this.container = new PIXI.Container();
    this.gfx       = new PIXI.Graphics();
    this.drawCoin();
    this.container.addChild(this.gfx);
    // Map override wins; otherwise fall back to any built-in default skin for this kind.
    const effectiveSkin = skin ?? DEFAULT_COIN_SKINS[kind];
    this.skin = effectiveSkin;
    if (effectiveSkin) this.applySkin(effectiveSkin);
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

  /** Replace the procedural coin graphic with a custom PNG (map coinSkins).
   *  Loads async — the Graphics shows until the texture resolves, then is hidden. */
  private applySkin(skin: string) {
    PIXI.Assets.load<PIXI.Texture>(skin)
      .then(tex => {
        if (this.isDead) return;
        const sprite  = new PIXI.Sprite(tex);
        sprite.anchor.set(0.5);
        sprite.width  = 22;   // ≈ the 10px-radius procedural coin, slightly padded
        sprite.height = 22;
        this.container.addChildAt(sprite, 0);
        this.gfx.visible = false;
      })
      .catch(() => { /* missing/corrupt data URL — keep the procedural graphic */ });
  }

  update(dt: number, platforms: PlatformData[] = [], blocks: PlatformData[] = []) {
    if (this.isDead || this.isPickedUp) return;

    // Kill coin instantly if it travels beyond either tower
    if (this.x < this.wallBoundsL || this.x > this.wallBoundsR) {
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

      // Settle when nearly stopped and close to a surface (ground, platform, or block).
      // Search platforms first, then blocks — short-circuit as soon as one is found
      // so both arrays are never fully scanned when a platform match exists.
      if (speed < 0.05) {
        let surfaceY: number | null = null;
        for (const s of platforms) {
          if (this.x >= s.x && this.x <= s.x + s.width && this.y >= s.y - 35 && this.y <= s.y + 5) {
            surfaceY = s.y;
            break;
          }
        }
        if (surfaceY === null) {
          for (const s of blocks) {
            if (this.x >= s.x && this.x <= s.x + s.width && this.y >= s.y - 35 && this.y <= s.y + 5) {
              surfaceY = s.y;
              break;
            }
          }
        }
        if (surfaceY !== null || this.y >= this.groundY - 35) {
          this.isOnGround = true;
          this.floorY     = surfaceY ?? this.groundY;
          Matter.Body.setStatic(this.body, true);
          this.y = this.floorY === this.groundY ? this.landY : this.floorY - 14;
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

  /**
   * Move a settled coin with a surface that just animated (dx, dy).
   * Called by Game.tickBlocks so coins stay glued to moving platforms/blocks.
   */
  carryWith(dx: number, dy: number): void {
    this.x      += dx;
    this.y      += dy;
    this.floorY += dy;
    Matter.Body.setPosition(this.body, { x: this.x, y: this.y });
    this.container.x = this.x;
    this.container.y = this.y;
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
