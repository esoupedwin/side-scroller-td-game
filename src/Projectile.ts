import * as PIXI from 'pixi.js';
import {
  GROUND_Y, PLAYER_COLOR, ENEMY_COLOR,
  BULLET_SPEED, BULLET_MIN_TIME, BULLET_ARC_FACTOR, BULLET_SPLASH,
  ARROW_SPEED, ARROW_MIN_TIME, ARROW_ARC_FACTOR, ARROW_SPLASH,
  PROJ_TOWER_SPLASH,
} from './constants';
import type { Character } from './Character';
import type { Tower, Side } from './Tower';

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
      this.drawBullet(angle);
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

  private drawBullet(_angle: number) {
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

    // Angle follows instantaneous velocity
    const vx = (this.tx - this.sx) / this.travelTime;
    const vy = (this.ty - this.sy) / this.travelTime
             + this.arcHeight * 4 * (2 * t - 1) / this.travelTime;
    this.redraw(Math.atan2(vy, vx));

    this.container.x = this.x;
    this.container.y = this.y;

    if (t >= 1) this.land(characters, playerTower, enemyTower);
  }

  private land(characters: Character[], playerTower: Tower, enemyTower: Tower) {
    this.isDead = true;
    const targetTower = this.side === 'player' ? enemyTower : playerTower;

    const splash = this.kind === 'bullet' ? BULLET_SPLASH : ARROW_SPLASH;
    let hitChar = false;
    for (const c of characters) {
      if (c.isDead || c.side === this.side) continue;
      if (Math.abs(c.x - this.tx) <= splash) {
        c.takeDamage(this.damage, this.shooter ?? undefined);
        hitChar = true;
        break;
      }
    }

    if (!hitChar && Math.abs(this.tx - targetTower.frontX) <= splash + PROJ_TOWER_SPLASH) {
      targetTower.takeDamage(this.damage);
    }
  }

  static groundY() { return GROUND_Y; }

  destroy() {
    this.container.destroy({ children: true });
  }
}
