import * as PIXI from 'pixi.js';
import Matter from 'matter-js';
import {
  GROUND_Y, PLAYER_COLOR, ENEMY_COLOR, GAME_WIDTH,
  JUMP_VELOCITY,
  CHAR_PICKUP_DIST, CHAR_DEPOSIT_DIST, CHAR_CARRY_SPEED_MULT, CHAR_COIN_RECOVERY_COOLDOWN,
  CHAR_HP_BAR_W, CHAR_HP_BAR_H,
  CHAR_HEAL_RANGE, CHAR_HEAL_RATE,
  TOWER_ATTACK_RANGE, HARASS_SAFETY_BUFFER, RANGED_KITE_THRESHOLD,
  PROMO_KILL_AP, PROMO_COIN_AP, PROMO_THRESHOLDS,
  PROMO_HP_BOOST, PROMO_SPEED_BOOST, PROMO_ATK_BOOST,
} from './constants';
import type { Physics } from './Physics';

export const RANK_NAMES = ['Private', 'Corporal', 'Sergeant', 'Captain'] as const;
import type { Side } from './Tower';
import type { Coin, CoinKind } from './Coin';
import { COIN_PALETTE } from './Coin';
import type { PlatformData } from './Platform';

export interface CharacterConfig {
  type:        'warrior' | 'archer' | 'rifleman' | 'medic' | 'heavy';
  hp:          number;
  speed:       number;
  attackRange: number;
  attackPower: number;
  fireRate:    number;
  width:       number;
  height:      number;
}

export interface FireRequest {
  side:           Side;
  sx: number; sy: number;
  tx: number; ty: number;
  damage:         number;
  projectileKind: 'arrow' | 'bullet';
  shooter?:       Character;
}

/** Context passed to Character.update() each tick. */
export interface UpdateContext {
  dt:                number;
  allChars:          Character[];
  enemyTowerFrontX:  number;
  enemyTowerY:       number;
  homeTowerFrontX:   number;   // the collecting character's own tower
  coins:             Coin[];
  platforms:         PlatformData[];
  onFire?:           (req: FireRequest) => void;
  onDamageTower?:    (dmg: number) => void;
  onDepositCoin:     (value: number) => void;
}

type State = 'marching' | 'fighting' | 'collecting' | 'returning' | 'dead';

export class Character {
  readonly side:   Side;
  readonly config: CharacterConfig;

  readonly id: number;

  hp:    number;
  x:     number;
  y:     number;          // feet y (ground contact point)
  state: State = 'marching';

  readonly container: PIXI.Container;
  private bar:    PIXI.Graphics;
  private barBg:  PIXI.Graphics;

  private body:      Matter.Body;
  private physics:   Physics;
  private jumpVx     = 0;
  private isAirborne = false;
  private floorY     = GROUND_Y;
  get isOnPlatform(): boolean { return this.floorY < GROUND_Y; }

  /** Damage events emitted this tick; Game.ts reads and clears each frame. */
  readonly pendingDamages: { amount: number; x: number; y: number }[] = [];
  /** Set when the character drops a carried coin; Game.ts spawns the coin. */
  pendingCoinDrop: { x: number; y: number; value: number; kind: CoinKind } | null = null;

  rank:              0 | 1 | 2 | 3 = 0;
  pendingPromotion = false;
  killedBy: 'character' | 'tower' | null = null;
  private ap            = 0;
  private rankGfx!:     PIXI.Graphics;
  private promoAnimGfx: PIXI.Graphics | null = null;
  private promoAnimTimer = -1;

  private attackTimer        = 0;
  private coinPickupCooldown = 0;
  private _behavior:    'attacking' | 'collecting' | 'harass' = 'attacking';
  private carryingCoin  = false;
  private coinCarryValue: number   = 0;
  private coinCarryKind:  CoinKind = 'gold';
  private targetCoin:   Coin | null = null;
  private coinCarryGfx: PIXI.Graphics | null = null;

  constructor(side: Side, startX: number, config: CharacterConfig, id: number, physics: Physics) {
    this.side    = side;
    this.id      = id;
    this.config  = { ...config };
    this.hp      = config.hp;
    this.x       = startX;
    this.y       = GROUND_Y;
    this.physics = physics;
    this.body    = physics.createCharBody(startX, GROUND_Y, config.width, config.height);

    this.container = new PIXI.Container();
    this.buildSprite();

    this.barBg = new PIXI.Graphics();
    this.barBg.beginFill(0x333333);
    this.barBg.drawRect(-CHAR_HP_BAR_W / 2, -this.config.height * 0.15, CHAR_HP_BAR_W, CHAR_HP_BAR_H);
    this.barBg.endFill();
    this.container.addChild(this.barBg);

    this.bar = new PIXI.Graphics();
    this.container.addChild(this.bar);
    this.drawBar();

    this.rankGfx = new PIXI.Graphics();
    this.container.addChild(this.rankGfx);
    this.drawRankBadge();

    const idLabel = new PIXI.Text(`#${id}`, {
      fontSize:        8,
      fontWeight:      'bold',
      fill:            0xffffff,
      stroke:          0x000000,
      strokeThickness: 2,
    });
    idLabel.anchor.set(0.5, 1);
    idLabel.x = 0;
    idLabel.y = -this.config.height * 0.15 - 1;
    this.container.addChild(idLabel);

    this.syncPosition();
  }

  // ── Behavior toggle ──────────────────────────────────────────────────────────

  get behavior(): 'attacking' | 'collecting' | 'harass' { return this._behavior; }

  set behavior(val: 'attacking' | 'collecting' | 'harass') {
    if (val === this._behavior) return;
    if (this._behavior === 'collecting') {
      this.targetCoin = null;
      if (this.carryingCoin) this.dropCarriedCoin();
    }
    this._behavior = val;
  }

  // ── Sprite builders ──────────────────────────────────────────────────────────

  private buildSprite() {
    if      (this.config.type === 'archer')   this.buildArcherSprite();
    else if (this.config.type === 'rifleman') this.buildRiflemanSprite();
    else if (this.config.type === 'medic')    this.buildMedicSprite();
    else if (this.config.type === 'heavy')    this.buildHeavySprite();
    else                                       this.buildWarriorSprite();
  }

  private buildWarriorSprite() {
    const g     = new PIXI.Graphics();
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;

    g.beginFill(color, 0.6);
    g.drawRect(-w / 2,    h * 0.55, w * 0.35, h * 0.45);
    g.drawRect( w * 0.15, h * 0.55, w * 0.35, h * 0.45);
    g.endFill();
    g.beginFill(color);
    g.drawRoundedRect(-w / 2, h * 0.2, w, h * 0.4, 4);
    g.endFill();
    g.beginFill(color, 0.9);
    g.drawCircle(0, h * 0.1, w * 0.38);
    g.endFill();
    g.beginFill(0xffd166);
    g.drawRect(-w * 0.18, h * 0.02 - 6, w * 0.36, 4);
    g.endFill();
    const bladeBase = dir * w * 0.5;
    g.beginFill(0xcccccc);
    g.drawRect(Math.min(bladeBase, bladeBase + dir * w * 0.65), h * 0.23, w * 0.65, 3);
    g.endFill();
    g.beginFill(0xffd166);
    g.drawRect(Math.min(bladeBase, bladeBase + dir * 3), h * 0.2, 3, 9);
    g.endFill();

    this.container.addChild(g);
  }

  private buildArcherSprite() {
    const g     = new PIXI.Graphics();
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;

    g.beginFill(color, 0.55);
    g.drawRect(-w * 0.28, h * 0.55, w * 0.26, h * 0.45);
    g.drawRect( w * 0.02, h * 0.55, w * 0.26, h * 0.45);
    g.endFill();
    g.beginFill(color, 0.85);
    g.drawRoundedRect(-w * 0.38, h * 0.2, w * 0.76, h * 0.4, 3);
    g.endFill();
    g.beginFill(color, 0.45);
    g.drawRoundedRect(-w * 0.38, h * 0.28, w * 0.76, h * 0.32, 3);
    g.endFill();
    g.beginFill(color, 0.9);
    g.drawCircle(0, h * 0.1, w * 0.34);
    g.endFill();
    g.beginFill(color);
    g.drawPolygon([0, h * 0.1 - w * 0.34, -w * 0.22, h * 0.08, w * 0.22, h * 0.08]);
    g.endFill();

    const bx = dir * (w * 0.6), by = h * 0.35, brad = h * 0.28;
    g.lineStyle(3, color, 1);
    const arcStart = dir > 0 ? -Math.PI * 0.55 : Math.PI * 0.45;
    const arcEnd   = dir > 0 ?  Math.PI * 0.55 : Math.PI * 1.55;
    g.arc(bx, by, brad, arcStart, arcEnd, dir < 0);
    g.lineStyle(0);

    const tipY1 = by - brad * Math.sin(Math.abs(arcStart));
    const tipY2 = by + brad * Math.sin(Math.abs(arcStart));
    const tipX  = bx + dir * brad * Math.cos(Math.abs(arcStart));
    g.lineStyle(1, 0xcccccc, 0.9);
    g.moveTo(tipX, tipY1);
    g.lineTo(tipX, tipY2);
    g.lineStyle(0);

    const arrowTip = dir * (w * 1.3);
    g.beginFill(0xd4a017);
    g.drawRect(Math.min(0, arrowTip), by - 1.5, Math.abs(arrowTip), 3);
    g.endFill();
    g.beginFill(0xffd166);
    g.drawPolygon([arrowTip, by, arrowTip - dir * 6, by - 3.5, arrowTip - dir * 6, by + 3.5]);
    g.endFill();

    this.container.addChild(g);
  }

  private buildRiflemanSprite() {
    const g     = new PIXI.Graphics();
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;

    g.beginFill(color, 0.5);
    g.drawRect(-w / 2,    h * 0.55, w * 0.38, h * 0.45);
    g.drawRect( w * 0.12, h * 0.55, w * 0.38, h * 0.45);
    g.endFill();
    g.beginFill(color, 0.9);
    g.drawRoundedRect(-w * 0.48, h * 0.18, w * 0.96, h * 0.42, 3);
    g.endFill();
    g.lineStyle(1, color, 0.4);
    g.moveTo(-w * 0.2, h * 0.22); g.lineTo(-w * 0.2, h * 0.58);
    g.moveTo( w * 0.2, h * 0.22); g.lineTo( w * 0.2, h * 0.58);
    g.lineStyle(0);
    g.beginFill(color, 0.85);
    g.drawCircle(0, h * 0.1, w * 0.36);
    g.endFill();
    g.beginFill(color);
    g.drawRoundedRect(-w * 0.46, h * 0.02 - 10, w * 0.92, 14, 2);
    g.endFill();
    g.beginFill(color, 0.8);
    g.drawRect(dir > 0 ? w * 0.28 : -w * 0.28 - 9, h * 0.02 + 1, 9, 3);
    g.endFill();

    const ry = h * 0.30;
    const stockL = Math.min(-dir * 14, -dir * 2);
    const stockW = Math.abs(-dir * 14 - (-dir * 2));
    g.beginFill(0x5c3d1e);
    g.drawRoundedRect(stockL, ry - 1, stockW, 9, 2);
    g.endFill();
    const recvL = Math.min(-dir * 2, dir * 16);
    const recvW = Math.abs(-dir * 2 - dir * 16);
    g.beginFill(0x3a3a3a);
    g.drawRect(recvL, ry, recvW, 6);
    g.endFill();
    const barlL = Math.min(dir * 16, dir * 38);
    const barlW = Math.abs(dir * 16 - dir * 38);
    g.beginFill(0x2a2a2a);
    g.drawRect(barlL, ry + 1, barlW, 4);
    g.endFill();
    g.beginFill(0x1a1a1a);
    g.drawRect(dir > 0 ? dir * 38 : dir * 38 - 3, ry, 3, 6);
    g.endFill();
    const scopeL = Math.min(dir * 4, dir * 18);
    const scopeW = Math.abs(dir * 4 - dir * 18);
    g.beginFill(0x222222);
    g.drawRoundedRect(scopeL, ry - 8, scopeW, 7, 2);
    g.endFill();
    g.beginFill(0x4488ff, 0.7);
    g.drawCircle(dir * 17, ry - 4.5, 3.2);
    g.endFill();
    g.beginFill(0xffffff, 0.5);
    g.drawCircle(dir * 17 - dir, ry - 6, 1);
    g.endFill();
    g.beginFill(0x444444);
    g.drawRect(dir > 0 ? dir * 8  : dir * 8  - 2, ry - 2, 2, 4);
    g.drawRect(dir > 0 ? dir * 14 : dir * 14 - 2, ry - 2, 2, 4);
    g.endFill();

    this.container.addChild(g);
  }

  private buildHeavySprite() {
    const g     = new PIXI.Graphics();
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;

    // Thick legs
    g.beginFill(color, 0.7);
    g.drawRect(-w * 0.44, h * 0.55, w * 0.38, h * 0.45);
    g.drawRect( w * 0.06, h * 0.55, w * 0.38, h * 0.45);
    g.endFill();

    // Armored torso
    g.beginFill(color);
    g.drawRoundedRect(-w / 2, h * 0.18, w, h * 0.42, 6);
    g.endFill();
    // Chest plate highlight
    g.beginFill(0xffffff, 0.1);
    g.drawRoundedRect(-w * 0.34, h * 0.22, w * 0.68, h * 0.30, 4);
    g.endFill();
    // Belt line
    g.beginFill(0x000000, 0.2);
    g.drawRect(-w / 2, h * 0.52, w, 3);
    g.endFill();

    // Large head
    g.beginFill(color, 0.9);
    g.drawCircle(0, h * 0.1, w * 0.44);
    g.endFill();
    // Full-face visor slit
    g.beginFill(0x000000, 0.3);
    g.drawRect(-w * 0.30, h * 0.08, w * 0.60, 5);
    g.endFill();
    // Helmet crest
    g.beginFill(color);
    g.drawRect(-w * 0.12, h * 0.02 - 11, w * 0.24, 11);
    g.endFill();

    // War-hammer handle
    const handleBase = dir * w * 0.42;
    g.beginFill(0x7a4f2e);
    g.drawRect(Math.min(handleBase, handleBase + dir * w * 0.62), h * 0.26, w * 0.62, 5);
    g.endFill();
    // Hammer head
    const headX = dir * (w * 0.42 + w * 0.62);
    g.beginFill(0x888888);
    g.drawRect(Math.min(headX, headX + dir * 18), h * 0.13, 18, 26);
    g.endFill();
    // Hammer face highlight
    g.beginFill(0xaaaaaa, 0.7);
    g.drawRect(Math.min(headX + dir, headX + dir * 7), h * 0.14, 6, 6);
    g.endFill();
    // Top and bottom spurs
    g.beginFill(0x777777);
    g.drawRect(Math.min(headX, headX + dir * 10), h * 0.13 - 4, 10, 4);
    g.drawRect(Math.min(headX, headX + dir * 10), h * 0.13 + 26, 10, 4);
    g.endFill();

    this.container.addChild(g);
  }

  private buildMedicSprite() {
    const g     = new PIXI.Graphics();
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;

    // Legs
    g.beginFill(color, 0.6);
    g.drawRect(-w / 2,    h * 0.55, w * 0.35, h * 0.45);
    g.drawRect( w * 0.15, h * 0.55, w * 0.35, h * 0.45);
    g.endFill();

    // White coat
    g.beginFill(0xffffff, 0.95);
    g.drawRoundedRect(-w / 2, h * 0.2, w, h * 0.4, 4);
    g.endFill();

    // Red cross on coat
    const cx = 0, cy = h * 0.32;
    g.beginFill(0xe63946);
    g.drawRect(cx - 2, cy - 7, 4, 14);
    g.drawRect(cx - 7, cy - 2, 14, 4);
    g.endFill();

    // Head
    g.beginFill(color, 0.9);
    g.drawCircle(0, h * 0.1, w * 0.38);
    g.endFill();

    // Medic cap
    g.beginFill(0xffffff, 0.9);
    g.drawRect(-w * 0.28, h * 0.02 - 7, w * 0.56, 5);
    g.endFill();
    g.beginFill(0xe63946);
    g.drawRect(-1.5, h * 0.02 - 9, 3, 8);
    g.drawRect(-5,   h * 0.02 - 6, 10, 3);
    g.endFill();

    this.container.addChild(g);
  }

  // ── HP bar ───────────────────────────────────────────────────────────────────

  get maxHp() { return this.config.hp * (1 + this.rank * PROMO_HP_BOOST); }

  private drawBar() {
    const ratio = Math.max(0, this.hp / this.maxHp);
    this.bar.clear();
    this.bar.beginFill(this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR);
    this.bar.drawRect(-CHAR_HP_BAR_W / 2, -this.config.height * 0.15, CHAR_HP_BAR_W * ratio, CHAR_HP_BAR_H);
    this.bar.endFill();
  }

  private drawRankBadge() {
    this.rankGfx.clear();
    if (this.rank === 0) return;

    const dir = this.side === 'player' ? 1 : -1;
    const w   = this.config.width;
    const h   = this.config.height;
    // Place badge on the "back" side of the character, at mid-torso height
    const bx  = -dir * (w / 2 + 11);
    const by  =  h * 0.30;

    if (this.rank === 3) {
      // Captain: gold 5-pointed star
      const R = 7;
      const pts: number[] = [];
      for (let i = 0; i < 5; i++) {
        const oa = (i / 5) * Math.PI * 2 - Math.PI / 2;
        pts.push(bx + R * Math.cos(oa), by + R * Math.sin(oa));
        const ia = ((i + 0.5) / 5) * Math.PI * 2 - Math.PI / 2;
        pts.push(bx + R * 0.42 * Math.cos(ia), by + R * 0.42 * Math.sin(ia));
      }
      this.rankGfx.beginFill(0xffd700);
      this.rankGfx.drawPolygon(pts);
      this.rankGfx.endFill();
      this.rankGfx.lineStyle(0.8, 0xd4850a, 0.7);
      this.rankGfx.drawPolygon(pts);
      this.rankGfx.lineStyle(0);
    } else {
      // Corporal (rank 1): 2 chevrons, Sergeant (rank 2): 3 chevrons
      const count = this.rank === 1 ? 2 : 3;
      const color = this.rank === 1 ? 0xd4a857 : 0xc8c8c8;
      const cw = 9, ch = 4.5, gap = 3;
      const totalH = count * ch + (count - 1) * gap;
      const startY  = by - totalH / 2;
      for (let i = 0; i < count; i++) {
        const top = startY + i * (ch + gap);
        const bot = top + ch;
        this.rankGfx.lineStyle(2.5, color, 1);
        this.rankGfx.moveTo(bx - cw / 2, bot);
        this.rankGfx.lineTo(bx,           top);
        this.rankGfx.lineTo(bx + cw / 2,  bot);
        this.rankGfx.lineStyle(0);
      }
    }
  }

  private startPromoAnim() {
    if (!this.promoAnimGfx) {
      this.promoAnimGfx = new PIXI.Graphics();
      this.container.addChild(this.promoAnimGfx);
    }
    this.promoAnimTimer = 0;
  }

  private tickPromoAnim(dt: number) {
    if (this.promoAnimTimer < 0 || !this.promoAnimGfx) return;
    const DURATION = 1.0;
    this.promoAnimTimer += dt;
    if (this.promoAnimTimer >= DURATION) {
      this.promoAnimGfx.clear();
      this.promoAnimTimer = -1;
      return;
    }
    const t     = this.promoAnimTimer / DURATION;
    const alpha = 1 - t;
    const g     = this.promoAnimGfx;
    g.clear();

    // Anchor burst just above the character's head
    const cy    = this.config.height * 0.1;
    const maxR  = 30;
    const N     = 8;

    // Outer expanding ring
    g.lineStyle(2, 0xffd700, alpha * 0.9);
    g.drawCircle(0, cy, maxR * t);
    g.lineStyle(0);

    // Lagging inner ring (appears at t=0.15)
    if (t > 0.15) {
      const t2 = (t - 0.15) / 0.85;
      g.lineStyle(1.5, 0xffa500, (1 - t2) * 0.55);
      g.drawCircle(0, cy, maxR * t2 * 0.65);
      g.lineStyle(0);
    }

    // Radial rays + sparkle tip dots
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2;
      const r1    = maxR * t * 0.25;
      const r2    = maxR * t;
      const tx    = Math.cos(angle), ty_ = Math.sin(angle);
      g.lineStyle(1.5, 0xffd700, alpha * 0.9);
      g.moveTo(tx * r1, cy + ty_ * r1);
      g.lineTo(tx * r2, cy + ty_ * r2);
      g.lineStyle(0);
      g.beginFill(0xffffff, alpha * 0.85);
      g.drawCircle(tx * r2, cy + ty_ * r2, 1.5);
      g.endFill();
    }
  }

  private earnAP(amount: number) {
    if (this.rank >= 3) return;
    this.ap += amount;
    while (this.rank < 3 && this.ap >= PROMO_THRESHOLDS[this.rank]) {
      this.rank = (this.rank + 1) as 0 | 1 | 2 | 3;
      this.hp   = this.maxHp;
      this.pendingPromotion = true;
      this.drawRankBadge();
      this.drawBar();
      this.startPromoAnim();
    }
  }

  private syncPosition() {
    this.container.x = this.x;
    this.container.y = this.y - this.config.height;
  }

  // ── Coin carry visual ────────────────────────────────────────────────────────

  private showCoinCarry() {
    if (this.coinCarryGfx) return;
    const [outer, mid,, hi] = COIN_PALETTE[this.coinCarryKind];
    const g = new PIXI.Graphics();
    g.beginFill(outer);   g.drawCircle(0, 0, 7);   g.endFill();
    g.beginFill(mid);     g.drawCircle(0, 0, 5);   g.endFill();
    g.beginFill(hi, 0.8); g.drawCircle(-2, -2, 2); g.endFill();
    g.x = 0;
    g.y = -14;
    this.coinCarryGfx = g;
    this.container.addChild(g);
  }

  private removeCoinCarry() {
    if (!this.coinCarryGfx) return;
    this.container.removeChild(this.coinCarryGfx);
    this.coinCarryGfx.destroy();
    this.coinCarryGfx = null;
  }

  private dropCarriedCoin() {
    this.carryingCoin       = false;
    this.removeCoinCarry();
    this.pendingCoinDrop    = { x: this.x, y: this.y - this.config.height * 0.5, value: this.coinCarryValue, kind: this.coinCarryKind };
    this.coinPickupCooldown = CHAR_COIN_RECOVERY_COOLDOWN;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  takeDamage(dmg: number, killer?: Character) {
    this.hp = Math.max(0, this.hp - dmg);
    this.drawBar();
    this.pendingDamages.push({
      amount: dmg,
      x: this.x,
      y: this.y - this.config.height - 6,
    });
    if (this.carryingCoin) this.dropCarriedCoin();
    if (this.hp <= 0) {
      this.state = 'dead';
      this.removeCoinCarry();
      killer?.earnAP(PROMO_KILL_AP);
      this.killedBy = killer ? 'character' : 'tower';
    }
  }

  heal(amount: number) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.drawBar();
  }

  /** Called by Game.ts after spawning the dropped coin so the character chases it. */
  recoverCoin(coin: Coin) {
    this.targetCoin = coin;
  }

  get isDead()         { return this.state === 'dead'; }
  get isCarryingCoin() { return this.carryingCoin; }

  get frontX() {
    return this.side === 'player'
      ? this.x + this.config.width / 2
      : this.x - this.config.width / 2;
  }

  get bowY() { return this.y - this.config.height * 0.62; }

  update(ctx: UpdateContext) {
    if (this.isDead) return;

    this.attackTimer = Math.max(0, this.attackTimer - ctx.dt);

    if (this.config.type === 'medic') this.tickHeal(ctx.dt, ctx.allChars);

    if (this.coinPickupCooldown > 0) {
      this.coinPickupCooldown = Math.max(0, this.coinPickupCooldown - ctx.dt);
      this.container.alpha = this.coinPickupCooldown > 0
        ? 0.3 + 0.7 * Math.abs(Math.sin(this.coinPickupCooldown * 10))
        : 1;
    }

    this.syncFromBody(ctx.platforms);

    if (this._behavior === 'collecting') {
      this.updateCollecting(ctx);
    } else if (this._behavior === 'harass') {
      this.updateHarass(ctx);
    } else {
      this.updateAttacking(ctx);
    }

    this.tickPromoAnim(ctx.dt);
    this.syncPosition();
  }

  // ── Physics ──────────────────────────────────────────────────────────────────

  private jump(dirX: number, dt: number) {
    if (this.isAirborne) return;
    this.jumpVx     = dirX * this.moveSpeed;
    this.isAirborne = true;
    Matter.Body.setVelocity(this.body, {
      x: this.body.velocity.x,
      y: -JUMP_VELOCITY * dt,   // px/tick = px/s * s/tick
    });
  }

  syncToBody(dt: number) {
    if (this.isAirborne) this.x += this.jumpVx * dt;
    Matter.Body.setPosition(this.body, { x: this.x, y: this.body.position.y });
    Matter.Body.setVelocity(this.body, { x: 0, y: this.body.velocity.y });
  }

  syncFromBody(platforms: PlatformData[]) {
    const halfH = this.config.height / 2;
    this.y = this.body.position.y + halfH;

    const onSurface = this.physics.isOnSurface(this.body);
    if (onSurface && this.isAirborne) {
      this.isAirborne = false;
      this.jumpVx     = 0;
    } else if (!onSurface && !this.isAirborne) {
      // Walked off an edge
      this.isAirborne = true;
    }

    // Derive floorY from which surface we landed on
    if (!this.isAirborne) {
      const onPlat = platforms.find(
        p => this.x >= p.x && this.x <= p.x + p.width && Math.abs(this.y - p.y) < 8,
      );
      this.floorY = onPlat ? onPlat.y : GROUND_Y;
    }
  }

  // ── Attacking behaviour ──────────────────────────────────────────────────────

  private updateAttacking(ctx: UpdateContext) {
    const { dt, allChars, enemyTowerFrontX, enemyTowerY, onFire } = ctx;
    if (this.isAirborne) return;   // don't change horizontal intent mid-air

    if (this.config.type === 'medic') {
      // Medic marches with the line but stops before reaching the enemy tower
      if (Math.abs(this.x - enemyTowerFrontX) > 100) {
        this.state = 'marching';
        this.x += (this.side === 'player' ? 1 : -1) * this.moveSpeed * dt;
      } else {
        this.state = 'fighting';
      }
      return;
    }

    const isRanged    = this.config.type === 'archer' || this.config.type === 'rifleman';
    const dir         = this.side === 'player' ? 1 : -1;
    const nearest     = this.nearestEnemy(allChars, this.config.attackRange);
    const distToTower = Math.abs(this.x - enemyTowerFrontX);

    if (nearest !== null) {
      this.state = 'fighting';
      this.attackEnemy(nearest, onFire);

      // Kiting: ranged units back away when a melee enemy closes in
      if (isRanged) {
        const dist        = Math.abs(this.x - nearest.x);
        const enemyIsMelee = nearest.config.type === 'warrior' || nearest.config.type === 'heavy';
        if (enemyIsMelee && dist < RANGED_KITE_THRESHOLD) {
          const retreatX = this.x - dir * this.moveSpeed * dt;
          // Don't back into own tower
          this.x = dir > 0 ? Math.max(retreatX, ctx.homeTowerFrontX) : Math.min(retreatX, ctx.homeTowerFrontX);
        }
      }
    } else if (distToTower <= this.config.attackRange) {
      this.state = 'fighting';
      this.attackTower(enemyTowerFrontX, enemyTowerY, onFire, ctx.onDamageTower);
    } else {
      this.state = 'marching';
      this.x += dir * this.moveSpeed * dt;
    }
  }

  // ── Collecting behaviour ─────────────────────────────────────────────────────

  private updateCollecting(ctx: UpdateContext) {
    const { dt, allChars, coins, platforms, homeTowerFrontX, onFire, onDepositCoin } = ctx;

    // Attack any enemy that wanders into range without stopping movement
    if (!this.isAirborne) {
      const nearest = this.nearestEnemy(allChars, this.config.attackRange);
      if (nearest) this.attackEnemy(nearest, onFire);
    }

    if (this.carryingCoin) {
      if (this.isAirborne) return;   // wait until landed
      const distToTower = Math.abs(this.x - homeTowerFrontX);
      if (distToTower <= CHAR_DEPOSIT_DIST) {
        this.carryingCoin = false;
        this.removeCoinCarry();
        this.state = 'marching';
        onDepositCoin(this.coinCarryValue);
        this.earnAP(PROMO_COIN_AP);
      } else {
        this.state = 'returning';
        this.x += Math.sign(homeTowerFrontX - this.x) * this.moveSpeed * dt;
      }
      return;
    }

    if (this.targetCoin && (this.targetCoin.isDead || this.targetCoin.isPickedUp)) {
      this.targetCoin = null;
    }

    if (!this.targetCoin) {
      this.targetCoin = this.nearestCoin(coins);
    }

    if (this.targetCoin) {
      const coinOnPlatform = this.targetCoin.isOnPlatform;
      const charOnPlatform = this.floorY < GROUND_Y;

      // ── Pathfinding: jump onto platform ──────────────────────────────────────
      if (coinOnPlatform && !charOnPlatform && !this.isAirborne) {
        const plat = platforms[0];
        if (plat) {
          // Walk toward coin; jump once character enters the platform's x range
          const dirToCoin = Math.sign(this.targetCoin.x - this.x);
          this.x += dirToCoin * this.moveSpeed * dt;
          if (this.x >= plat.x && this.x <= plat.x + plat.width) {
            this.jump(dirToCoin, dt);
          }
          this.state = 'collecting';
          return;
        }
      }

      if (this.isAirborne) return;   // horizontal position handled by physics tick

      // ── Same-floor pickup ────────────────────────────────────────────────────
      const dist       = Math.abs(this.x - this.targetCoin.x);
      const sameSurface = Math.abs(this.floorY - this.targetCoin.floorY) < 30;

      if (dist <= CHAR_PICKUP_DIST && sameSurface && this.targetCoin.isOnGround && this.coinPickupCooldown <= 0) {
        this.coinCarryValue = this.targetCoin.value;
        this.coinCarryKind  = this.targetCoin.kind;
        this.targetCoin.pickup();
        this.targetCoin  = null;
        this.carryingCoin = true;
        this.showCoinCarry();
        this.state = 'returning';
      } else {
        this.state = 'collecting';
        this.x += Math.sign(this.targetCoin.x - this.x) * this.moveSpeed * dt;
      }
    } else {
      // No coins on field — drift toward center drop zone
      this.state = 'marching';
      const center = GAME_WIDTH / 2;
      if (Math.abs(this.x - center) > 40) {
        this.x += Math.sign(center - this.x) * this.moveSpeed * 0.5 * dt;
      }
    }
  }

  // ── Harass behaviour ─────────────────────────────────────────────────────────

  private updateHarass(ctx: UpdateContext) {
    const { dt, allChars, enemyTowerFrontX, homeTowerFrontX, onFire, platforms } = ctx;
    if (this.isAirborne) return;

    const isRanged = this.config.type === 'archer' || this.config.type === 'rifleman';
    const dir   = this.side === 'player' ? 1 : -1;
    const safeX = enemyTowerFrontX - dir * (TOWER_ATTACK_RANGE + HARASS_SAFETY_BUFFER);

    // Retreat is highest priority — back off before doing anything else
    if (dir * (this.x - safeX) > 0) {
      this.state = 'marching';
      this.x -= dir * this.moveSpeed * dt;
      // Still fire at enemies while retreating
      const target = this.nearestEnemy(allChars, this.config.attackRange);
      if (target) this.attackEnemy(target, onFire);
      return;
    }

    // Attack any enemy in range (no position change)
    const inRange = this.nearestEnemy(allChars, this.config.attackRange);
    if (inRange) {
      this.state = 'fighting';
      this.attackEnemy(inRange, onFire);

      // Kiting: ranged harass units retreat when a melee enemy closes in
      if (isRanged) {
        const isMelee = inRange.config.type === 'warrior' || inRange.config.type === 'heavy';
        if (isMelee && Math.abs(this.x - inRange.x) < RANGED_KITE_THRESHOLD) {
          const retreatX = this.x - dir * this.moveSpeed * dt;
          this.x = dir > 0 ? Math.max(retreatX, homeTowerFrontX) : Math.min(retreatX, homeTowerFrontX);
          return;
        }
      }
    }

    // Find the closest enemy (no range limit) to guide movement
    let closest: Character | null = null;
    let closestDist = Infinity;
    for (const c of allChars) {
      if (c.isDead || c.side === this.side) continue;
      const d = Math.abs(c.x - this.x);
      if (d < closestDist) { closestDist = d; closest = c; }
    }

    const clamp = (v: number) => dir > 0 ? Math.min(v, safeX) : Math.max(v, safeX);

    const charOnPlatform = this.floorY < GROUND_Y;

    if (closest) {
      const toEnemy = dir * (closest.x - this.x);

      // Closest enemy is on the platform and we're on the ground — climb up
      if (closest.isOnPlatform && !charOnPlatform && platforms.length > 0) {
        const plat = platforms[0];
        const dirToEnemy = Math.sign(closest.x - this.x);
        this.x += dirToEnemy * this.moveSpeed * dt;
        if (this.x >= plat.x && this.x <= plat.x + plat.width) {
          this.jump(dirToEnemy, dt);
        }
        this.state = 'marching';
      } else if (toEnemy > 0 && closestDist > this.config.attackRange * 0.8) {
        // Enemy is ahead and not yet in range — advance, hard-clamped at safe line
        this.x = clamp(this.x + dir * this.moveSpeed * dt);
        if (this.state !== 'fighting') this.state = 'marching';
      } else if (toEnemy <= 0) {
        if (!isRanged && closestDist <= this.config.attackRange * 4) {
          // Melee harass: pursue enemy that's behind rather than drifting away
          this.x -= dir * this.moveSpeed * dt;
          if (this.state !== 'fighting') this.state = 'marching';
        } else if (dir * (safeX - this.x) > 5) {
          // Ranged or enemy too far behind — drift to safe line
          this.x = clamp(this.x + dir * this.moveSpeed * 0.4 * dt);
          if (this.state !== 'fighting') this.state = 'marching';
        }
      }
      // else: enemy is ahead and within attack range — hold position
    } else {
      // No enemies — drift to the safe line at reduced speed
      if (dir * (safeX - this.x) > 5) {
        this.x = clamp(this.x + dir * this.moveSpeed * 0.4 * dt);
        this.state = 'marching';
      }
    }
  }

  // ── Attack helpers ───────────────────────────────────────────────────────────

  private tickHeal(dt: number, allChars: Character[]) {
    let target: Character | null = null;
    let lowestRatio = 1;
    for (const c of allChars) {
      if (c === this || c.isDead || c.side !== this.side) continue;
      if (Math.abs(this.x - c.x) > CHAR_HEAL_RANGE) continue;
      const ratio = c.hp / c.maxHp;
      if (ratio < lowestRatio) { lowestRatio = ratio; target = c; }
    }
    if (target) target.heal(CHAR_HEAL_RATE * dt);
  }

  private get moveSpeed() {
    return this.config.speed * (1 + this.rank * PROMO_SPEED_BOOST) * (this.carryingCoin ? CHAR_CARRY_SPEED_MULT : 1);
  }

  private get effectiveAtk() {
    return this.config.attackPower * (1 + this.rank * PROMO_ATK_BOOST);
  }

  private get projectileKind(): 'arrow' | 'bullet' {
    return this.config.type === 'rifleman' ? 'bullet' : 'arrow';
  }

  private attackEnemy(target: Character, onFire?: (r: FireRequest) => void) {
    if (this.attackTimer > 0) return;
    if (this.config.type === 'warrior' || this.config.type === 'heavy') {
      target.takeDamage(this.effectiveAtk, this);
    } else if (onFire) {
      onFire({
        side: this.side, sx: this.x, sy: this.bowY,
        tx: target.x,   ty: target.bowY,
        damage: this.effectiveAtk, projectileKind: this.projectileKind,
        shooter: this,
      });
    }
    this.attackTimer = this.config.fireRate;
  }

  private attackTower(
    towerFrontX: number, towerY: number,
    onFire?: (r: FireRequest) => void,
    onDamageTower?: (dmg: number) => void,
  ) {
    if (this.attackTimer > 0) return;
    if (this.config.type === 'warrior' || this.config.type === 'heavy') {
      onDamageTower?.(this.effectiveAtk);
    } else if (onFire) {
      onFire({
        side: this.side, sx: this.x, sy: this.bowY,
        tx: towerFrontX, ty: towerY,
        damage: this.effectiveAtk, projectileKind: this.projectileKind,
      });
    }
    this.attackTimer = this.config.fireRate;
  }

  private nearestEnemy(chars: Character[], range: number): Character | null {
    let best: Character | null = null;
    let minDistSq = Infinity;
    const rangeSq = range * range;
    for (const t of chars) {
      if (t.isDead || t.side === this.side) continue;
      const dx = this.x - t.x;
      const dy = this.y - t.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= rangeSq && distSq < minDistSq) { minDistSq = distSq; best = t; }
    }
    return best;
  }

  private nearestCoin(coins: Coin[]): Coin | null {
    let best: Coin | null = null;
    let minDist = Infinity;
    for (const c of coins) {
      if (c.isDead || c.isPickedUp) continue;
      const dist = Math.abs(this.x - c.x);
      if (dist < minDist) { minDist = dist; best = c; }
    }
    return best;
  }

  destroy() {
    this.removeCoinCarry();
    this.physics.removeBody(this.body);
    this.container.destroy({ children: true });
  }
}
