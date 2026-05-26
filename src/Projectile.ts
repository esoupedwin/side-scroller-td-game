import * as PIXI from 'pixi.js';
import {
  PLAYER_COLOR, ENEMY_COLOR,
  BULLET_SPEED, BULLET_MIN_TIME, BULLET_ARC_FACTOR, BULLET_SPLASH,
  ARROW_SPEED, ARROW_MIN_TIME, ARROW_ARC_FACTOR, ARROW_SPLASH,
  PROJ_TOWER_SPLASH,
  ATTACK_KNOCKBACK_VY, ATTACK_KNOCKBACK_DECAY,
} from './constants';
import type { Character } from './Character';
import type { Tower, Side } from './Tower';
import type { BlockData } from './Block';

export type ProjectileKind = 'arrow' | 'bullet';

export class Projectile {
  readonly side:   Side;
  readonly damage: number;
  readonly kind:   ProjectileKind;

  x: number;
  y: number;
  isDead = false;

  private sx: number;
  private sy: number;
  private tx: number;
  private ty: number;
  private travelTime: number;
  private arcHeight:  number;
  private elapsed = 0;
  private readonly shooter: Character | null;

  readonly container: PIXI.Container;
  private gfx: PIXI.Graphics;

  // Muzzle flash (bullet only) — fades over one frame
  private flash: PIXI.Graphics | null = null;

  // Set on land() when the projectile actually hit a character. Drained by
  // Game.ts after each update() call so the VFX layer (which Projectile must
  // not know about directly) can spawn a hit spark at the impact point.
  private pendingImpact: { x: number; y: number } | null = null;

  constructor(
    side:   Side,
    sx: number, sy: number,
    tx: number, ty: number,
    damage: number,
    kind:   ProjectileKind = 'arrow',
    shooter: Character | null = null,
  ) {
    this.side    = side;
    this.damage  = damage;
    this.kind    = kind;
    this.shooter = shooter;
    this.sx = sx; this.sy = sy;
    this.tx = tx; this.ty = ty;
    this.x  = sx; this.y  = sy;

    const dist = Math.abs(tx - sx);

    if (kind === 'bullet') {
      this.travelTime = Math.max(BULLET_MIN_TIME, dist / BULLET_SPEED);
      this.arcHeight  = dist * BULLET_ARC_FACTOR;
    } else {
      this.travelTime = Math.max(ARROW_MIN_TIME, dist / ARROW_SPEED);
      this.arcHeight  = dist * ARROW_ARC_FACTOR;
    }

    this.container = new PIXI.Container();
    this.gfx       = new PIXI.Graphics();
    this.container.addChild(this.gfx);

    if (kind === 'bullet') {
      this.buildMuzzleFlash(sx, sy);
    }

    this.redraw(0);
  }

  // ── Visual builders ──────────────────────────────────────────────────────────

  private buildMuzzleFlash(sx: number, sy: number) {
    this.flash = new PIXI.Graphics();
    const dir  = this.side === 'player' ? 1 : -1;
    const cx   = sx + dir * 10;

    this.flash.beginFill(0xffd166, 0.85);
    this.flash.drawPolygon([cx, sy, cx + dir * 14, sy - 5, cx + dir * 18, sy, cx + dir * 14, sy + 5]);
    this.flash.endFill();
    this.flash.beginFill(0xffffff, 0.6);
    this.flash.drawCircle(cx + dir * 4, sy, 4);
    this.flash.endFill();

    // Flash is drawn in world space on the stage — but we keep it in the
    // container so it's culled when container is removed.
    this.container.addChild(this.flash);
    // Expire after first update tick
  }

  private redraw(angle: number) {
    this.gfx.clear();

    if (this.kind === 'bullet') {
      this.drawBullet();
    } else {
      this.drawArrow(angle);
    }
  }

  private drawArrow(angle: number) {
    // Shaft
    this.gfx.lineStyle(2, 0xd4a017, 1);
    this.gfx.moveTo(-7, 0);
    this.gfx.lineTo(7, 0);

    // Arrowhead
    this.gfx.lineStyle(0);
    this.gfx.beginFill(0xffd166);
    this.gfx.drawPolygon([7, 0, 2, -3, 2, 3]);
    this.gfx.endFill();

    // Fletching
    this.gfx.beginFill(this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR, 0.9);
    this.gfx.drawPolygon([-7, 0, -4, -4, -3, 0]);
    this.gfx.drawPolygon([-7, 0, -4,  4, -3, 0]);
    this.gfx.endFill();

    this.gfx.rotation = angle;
  }

  private drawBullet() {
    // Outer shell (yellow)
    this.gfx.beginFill(0xf5c400);
    this.gfx.drawCircle(0, 0, 4.5);
    this.gfx.endFill();

    // Inner highlight (lighter yellow, offset for 3-D effect)
    this.gfx.beginFill(0xffe566, 0.7);
    this.gfx.drawCircle(-1.1, -1.1, 2.25);
    this.gfx.endFill();

    // No rotation — circles look the same from every angle
  }

  // ── Update ───────────────────────────────────────────────────────────────────

  update(
    dt: number,
    characters: Character[],
    playerTower: Tower,
    enemyTower:  Tower,
    blocks:      BlockData[] = [],
  ) {
    if (this.isDead) return;

    // Remove muzzle flash after first tick
    if (this.flash) {
      this.container.removeChild(this.flash);
      this.flash.destroy();
      this.flash = null;
    }

    this.elapsed += dt;
    const t = Math.min(this.elapsed / this.travelTime, 1);

    // Parametric ballistic arc
    this.x = this.sx + (this.tx - this.sx) * t;
    const yLerp   = this.sy + (this.ty - this.sy) * t;
    const arcDrop = -this.arcHeight * 4 * t * (1 - t);
    this.y = yLerp + arcDrop;

    // Block collision — kill the projectile if it enters a solid block mid-flight
    for (const b of blocks) {
      if (this.x >= b.x && this.x <= b.x + b.width &&
          this.y >= b.y && this.y <= b.y + b.height) {
        this.isDead = true;
        return;
      }
    }

    // Character collision — strict AABB check against every enemy character
    // every tick. Without this, a projectile aimed past a clustered group
    // (e.g. at the tower) flies straight through everyone and only the unit
    // nearest to its landing tx ever takes damage. land()'s splash check
    // remains as a leniency fallback for projectiles that arrive after their
    // intended target has moved.
    for (const c of characters) {
      if (c.isDead || c.side === this.side) continue;
      if (this.x < c.x - c.config.width / 2)  continue;
      if (this.x > c.x + c.config.width / 2)  continue;
      if (this.y > c.y)                       continue;  // below feet
      if (this.y < c.y - c.collisionHeight)   continue;  // above head
      c.takeDamage(this.damage, this.shooter ?? undefined);
      this.applyKnockback(c, dt);
      this.pendingImpact = { x: c.x, y: c.y - c.config.height * 0.5 };
      this.isDead = true;
      return;
    }

    // Angle follows instantaneous velocity
    const vx = (this.tx - this.sx) / this.travelTime;
    const vy = (this.ty - this.sy) / this.travelTime
             + this.arcHeight * 4 * (2 * t - 1) / this.travelTime;
    if (this.kind !== 'bullet') this.gfx.rotation = Math.atan2(vy, vx);

    this.container.x = this.x;
    this.container.y = this.y;

    if (t >= 1) this.land(characters, playerTower, enemyTower, dt);
  }

  private land(characters: Character[], playerTower: Tower, enemyTower: Tower, dt: number) {
    this.isDead = true;
    const targetTower = this.side === 'player' ? enemyTower : playerTower;

    const splash = this.kind === 'bullet' ? BULLET_SPLASH : ARROW_SPLASH;
    let hitChar = false;
    for (const c of characters) {
      if (c.isDead || c.side === this.side) continue;
      if (Math.abs(c.x - this.tx) <= splash) {
        c.takeDamage(this.damage, this.shooter ?? undefined);
        this.applyKnockback(c, dt);
        this.pendingImpact = { x: c.x, y: c.y - c.config.height * 0.5 };
        hitChar = true;
        break;
      }
    }

    if (!hitChar && Math.abs(this.tx - targetTower.frontX) <= splash + PROJ_TOWER_SPLASH) {
      targetTower.takeDamage(this.damage);
    }
  }

  /**
   * Apply the shooter's per-type knockback to `target`. Direction is the
   * bullet's travel direction (sign of tx - sx), so a victim takes the hit
   * in the same direction the projectile was moving. No-op when the shooter
   * is missing or has zero knockback.
   */
  private applyKnockback(target: Character, dt: number): void {
    const kb = this.shooter?.config.knockback ?? 0;
    if (kb <= 0 || target.isDead) return;
    const dir   = Math.sign(this.tx - this.sx) || (this.side === 'player' ? 1 : -1);
    const decay = Math.exp(-ATTACK_KNOCKBACK_DECAY * dt);
    target.applyKnockback(kb * dir, ATTACK_KNOCKBACK_VY, dt, decay);
  }

  /** Returns the impact location once (if the projectile just hit a character), then clears it. */
  consumeImpact(): { x: number; y: number } | null {
    const i = this.pendingImpact;
    this.pendingImpact = null;
    return i;
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
