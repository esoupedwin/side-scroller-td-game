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
  readonly container: PIXI.Container;

  hp: number = TOWER_HP;
  private attackTimer = 0;
  private bar: PIXI.Graphics;
  private body: PIXI.Graphics;
  private label: PIXI.Text;

  constructor(side: Side, x: number) {
    this.side  = side;
    this.x     = x;
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
    this.body.y = GROUND_Y - TOWER_HEIGHT;
    this.container.addChild(this.body);

    // HP bar background
    const barBg = new PIXI.Graphics();
    barBg.beginFill(0x333333);
    barBg.drawRect(cx - 4, GROUND_Y - TOWER_HEIGHT - 32, TOWER_WIDTH + 8, 10);
    barBg.endFill();
    this.container.addChild(barBg);

    // HP bar fill
    this.bar = new PIXI.Graphics();
    this.container.addChild(this.bar);
    this.drawBar();

    // Label
    this.label = new PIXI.Text(side === 'player' ? 'YOUR TOWER' : 'ENEMY TOWER', {
      fontSize: 9,
      fill: 0xffffff,
      fontWeight: 'bold',
    });
    this.label.x = cx + TOWER_WIDTH / 2 - this.label.width / 2;
    this.label.y = GROUND_Y - TOWER_HEIGHT - 44;
    this.container.addChild(this.label);
  }

  private drawBar() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const ratio  = Math.max(0, this.hp / TOWER_HP);
    const cx     = this.side === 'player'
      ? this.x - TOWER_WIDTH / 2
      : this.x - TOWER_WIDTH / 2;

    this.bar.clear();
    this.bar.beginFill(color);
    this.bar.drawRect(cx - 4, GROUND_Y - TOWER_HEIGHT - 32, (TOWER_WIDTH + 8) * ratio, 10);
    this.bar.endFill();
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
    const fireY = GROUND_Y - TOWER_HEIGHT + 8;
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
