import * as PIXI from 'pixi.js';
import {
  TOWER_WIDTH, TOWER_HEIGHT, TOWER_HP, GROUND_Y,
  TOWER_ATTACK_RANGE, TOWER_ATTACK_POWER, TOWER_FIRE_RATE,
  PLAYER_COLOR, ENEMY_COLOR,
} from './constants';
import type { Character } from './Character';

export interface TowerShot {
  sx: number; sy: number;
  tx: number; ty: number;
  damage: number;
}

export type Side = 'player' | 'enemy';

export class Tower {
  readonly side: Side;
  readonly x: number;
  /** Bottom y of the tower body (defaults to GROUND_Y). */
  readonly baseY: number;
  readonly container: PIXI.Container;

  hp: number = TOWER_HP;
  private attackTimer = 0;
  private bar:               PIXI.Graphics;
  private hpText:            PIXI.Text;
  private body:              PIXI.Graphics;
  private label:             PIXI.Text;
  private lastDrawnTowerRatio = -1;

  // HP bar dimensions — 1.4× height, 1.2× width relative to the original design
  private static readonly BAR_H = Math.round(10 * 1.4);                   // 14 px
  private static readonly BAR_W = Math.round((TOWER_WIDTH + 8) * 1.8);    // ~158 px

  constructor(side: Side, x: number, skinUrl?: string, skinW?: number, skinH?: number, baseY = GROUND_Y) {
    this.side  = side;
    this.x     = x;
    this.baseY = baseY;
    this.container = new PIXI.Container();

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
      const sw = skinW ?? TOWER_WIDTH;
      const sh = skinH ?? TOWER_HEIGHT;
      PIXI.Assets.load<PIXI.Texture>(skinUrl)
        .then(tex => {
          this.body.visible = false;
          const sprite = new PIXI.Sprite(tex);
          sprite.x      = x - sw / 2;
          sprite.y      = baseY - sh;
          sprite.width  = sw;
          sprite.height = sh;
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

    // Label
    this.label = new PIXI.Text(side === 'player' ? 'YOUR TOWER' : 'ENEMY TOWER', {
      fontSize: 13,
      fill: 0xffffff,
      fontWeight: 'bold',
    });
    this.label.x = x - this.label.width / 2;
    this.label.y = baseY - TOWER_HEIGHT - BAR_OFFSET - 18;
    this.container.addChild(this.label);
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
}
