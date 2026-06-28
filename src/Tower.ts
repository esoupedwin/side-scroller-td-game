import * as PIXI from 'pixi.js';
import {
  TOWER_WIDTH, TOWER_HEIGHT, TOWER_HP,
  TOWER_ATTACK_RANGE, TOWER_ATTACK_POWER, TOWER_FIRE_RATE,
  PLAYER_COLOR, ENEMY_COLOR,
} from './constants';
import type { Character } from './Character';
import type { Tribe } from './Tribes';
import { getTowerTemplate } from './TribeTowerTemplates';

export interface TowerShot {
  sx: number; sy: number;
  tx: number; ty: number;
  damage: number;
}

export type Side = 'player' | 'enemy';

export class Tower {
  readonly side: Side;
  readonly x: number;
  /** Bottom y of the tower body. */
  readonly baseY: number;
  /** Vertical centre of the tower body — cached to avoid per-tick multiplication. */
  readonly centerY: number;
  readonly container: PIXI.Container;

  hp: number = TOWER_HP;
  private attackTimer = 0;
  private bar:               PIXI.Graphics;
  private hpText:            PIXI.Text;
  private body:              PIXI.Graphics;
  private lastDrawnTowerRatio = -1;

  // HP bar dimensions — 1.4× height, 1.2× width relative to the original design
  private static readonly BAR_H = Math.round(10 * 1.4);                   // 14 px
  private static readonly BAR_W = Math.round((TOWER_WIDTH + 8) * 1.8);    // ~158 px

  /** Resolved rendered skin width (template w or TOWER_WIDTH fallback). */
  private readonly skinW_resolved: number;
  /** Resolved rendered skin height (template h or TOWER_HEIGHT fallback). */
  private readonly skinH_resolved: number;
  /** Resolved collision rect in skin-local pixels. */
  private readonly tplCollision: { x: number; y: number; w: number; h: number };
  /** Resolved spawn point in skin-local pixels (east-facing). */
  private readonly tplSpawn: { x: number; y: number };

  constructor(side: Side, x: number, baseY: number, tribe: Tribe) {
    this.side    = side;
    this.x       = x;
    this.baseY   = baseY;
    this.centerY = baseY - TOWER_HEIGHT * 0.5;
    this.container = new PIXI.Container();

    const tpl     = getTowerTemplate(tribe);
    const skinUrl = tpl.skin;
    const skinW   = tpl.w;
    const skinH   = tpl.h;
    this.skinW_resolved = skinW ?? TOWER_WIDTH;
    this.skinH_resolved = skinH ?? TOWER_HEIGHT;
    this.tplCollision = tpl.collision ?? { x: 0, y: 0, w: this.skinW_resolved, h: this.skinH_resolved };
    this.tplSpawn     = tpl.spawn     ?? { x: this.skinW_resolved, y: 0 };

    const color = side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const cx    = x - TOWER_WIDTH / 2;

    // Body
    this.body = new PIXI.Graphics();
    this.body.beginFill(color, 0.85);
    this.body.drawRoundedRect(0, 0, TOWER_WIDTH, TOWER_HEIGHT, 6);
    this.body.endFill();
    // Battlements
    const merlonW = 10, merlonH = 14, gap = 4;
    this.body.beginFill(color);
    for (let bx = 0; bx < TOWER_WIDTH; bx += merlonW + gap) {
      this.body.drawRect(bx, -merlonH, merlonW, merlonH);
    }
    this.body.endFill();

    this.body.x = cx;
    this.body.y = baseY - TOWER_HEIGHT;
    this.container.addChild(this.body);

    if (skinUrl) {
      const sw   = skinW ?? TOWER_WIDTH;
      const sh   = skinH ?? TOWER_HEIGHT;
      // Source skins are authored facing east; the enemy tower mirrors so it
      // faces west into the battlefield. Anchoring at top-centre keeps the
      // sprite centred on the tower's x regardless of scale sign.
      const flip = side === 'enemy';
      PIXI.Assets.load<PIXI.Texture>(skinUrl)
        .then(tex => {
          this.body.visible = false;
          const sprite = new PIXI.Sprite(tex);
          sprite.anchor.set(0.5, 0);
          sprite.x      = x;
          sprite.y      = baseY - sh;
          sprite.width  = sw;
          sprite.height = sh;
          if (flip) sprite.scale.x = -sprite.scale.x;
          this.container.addChildAt(sprite, 0);
        })
        .catch(() => { /* keep Graphics body */ });
    }

    // HP bar background — raised 262 px above tower top so it clears character sprites
    const BAR_OFFSET = 262;
    const barBg = new PIXI.Graphics();
    barBg.beginFill(0x333333);
    barBg.drawRoundedRect(x - Tower.BAR_W / 2, baseY - TOWER_HEIGHT - BAR_OFFSET, Tower.BAR_W, Tower.BAR_H, Tower.BAR_H / 2);
    barBg.endFill();
    this.container.addChild(barBg);

    // HP bar fill
    this.bar = new PIXI.Graphics();
    this.container.addChild(this.bar);

    // HP numeric overlay
    this.hpText = new PIXI.Text('', {
      fontSize: 13,
      fill: 0xffffff,
      fontWeight: 'bold',
      stroke: 0x000000,
      strokeThickness: 2,
    });
    this.container.addChild(this.hpText);
    this.drawBar();
  }

  private drawBar() {
    const color  = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const ratio  = Math.max(0, this.hp / TOWER_HP);
    if (Math.abs(ratio - this.lastDrawnTowerRatio) < 0.005) return;
    this.lastDrawnTowerRatio = ratio;
    const barX   = this.x - Tower.BAR_W / 2;
    const barY   = this.baseY - TOWER_HEIGHT - 262;

    this.bar.clear();
    this.bar.beginFill(color);
    this.bar.drawRoundedRect(barX, barY, Math.max(Tower.BAR_H, Tower.BAR_W * ratio), Tower.BAR_H, Tower.BAR_H / 2);
    this.bar.endFill();

    this.hpText.text = `${Math.ceil(this.hp)} / ${TOWER_HP}`;
    this.hpText.x    = barX + (Tower.BAR_W - this.hpText.width) / 2;
    this.hpText.y    = barY + (Tower.BAR_H - this.hpText.height) / 2;
  }

  /** Call each tick; returns a shot descriptor if the tower fires, otherwise null. */
  tryFire(dt: number, enemies: Character[]): TowerShot | null {
    this.attackTimer = Math.max(0, this.attackTimer - dt);
    if (this.attackTimer > 0) return null;

    // Target the enemy closest to this tower within range
    let target: Character | null = null;
    let minDist = Infinity;
    for (const c of enemies) {
      if (c.isDead) continue;
      const dist = Math.abs(c.x - this.frontX);
      if (dist <= TOWER_ATTACK_RANGE && dist < minDist) {
        minDist = dist;
        target  = c;
      }
    }
    if (!target) return null;

    this.attackTimer = TOWER_FIRE_RATE;

    // Fire from the tower's battlement level (near top of tower body)
    const fireY = this.baseY - TOWER_HEIGHT + 8;
    return {
      sx: this.frontX, sy: fireY,
      tx: target.x,   ty: target.y - target.config.height * 0.5,
      damage: TOWER_ATTACK_POWER,
    };
  }

  takeDamage(dmg: number) {
    this.hp = Math.max(0, this.hp - dmg);
    this.drawBar();
  }

  get isDead() { return this.hp <= 0; }

  /** X edge facing the enemy — where units attack toward */
  get frontX() {
    return this.side === 'player'
      ? this.x + TOWER_WIDTH / 2
      : this.x - TOWER_WIDTH / 2;
  }

  /**
   * Skin-local x → world x. Player towers render skins un-flipped from
   * `(x - W/2)` rightward; enemy towers mirror horizontally around `x`,
   * so the template's east-facing convention reflects to face west.
   */
  private skinToWorldX(sx: number): number {
    return this.side === 'player'
      ? this.x - this.skinW_resolved / 2 + sx
      : this.x + this.skinW_resolved / 2 - sx;
  }
  private skinToWorldY(sy: number): number {
    return this.baseY - this.skinH_resolved + sy;
  }

  /** World x of the centre of the tower's collision rectangle. */
  get collisionCenterX(): number {
    const c    = this.tplCollision;
    const left = this.skinToWorldX(c.x);
    return this.side === 'player' ? left + c.w / 2 : left - c.w / 2;
  }
  /** Collision rectangle width (skin-local px == world px). */
  get collisionWidth(): number { return this.tplCollision.w; }

  /** Full collision rect in world space (used by the dev-mode overlay). */
  get collisionRect(): { x: number; y: number; w: number; h: number } {
    const c = this.tplCollision;
    return {
      x: this.collisionCenterX - c.w / 2,
      y: this.skinToWorldY(c.y),
      w: c.w,
      h: c.h,
    };
  }

  /** World x for the tribe's spawn point (tower-side edge of the unit). */
  get spawnX(): number { return this.skinToWorldX(this.tplSpawn.x); }
  /** World y for the tribe's spawn point. */
  get spawnY(): number { return this.skinToWorldY(this.tplSpawn.y); }
}
