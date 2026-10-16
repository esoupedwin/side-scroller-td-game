import * as PIXI from 'pixi.js';
import { loadFittedTexture } from './SkinTextures';
import {
  TOWER_WIDTH, TOWER_HEIGHT, TOWER_HP,
  TOWER_ATTACK_RANGE, TOWER_ATTACK_POWER, TOWER_FIRE_RATE,
  TOWER_HIT_SHAKE_SEC, TOWER_HIT_SHAKE_AMP, TOWER_HIT_SHAKE_HZ,
  TOWER_COLLAPSE_COLS, TOWER_COLLAPSE_ROWS, TOWER_COLLAPSE_GRAVITY,
  TOWER_COLLAPSE_VX_MIN, TOWER_COLLAPSE_VX_MAX, TOWER_COLLAPSE_POP_MIN, TOWER_COLLAPSE_POP_MAX,
  TOWER_COLLAPSE_SPIN_MAX, TOWER_COLLAPSE_ROW_DELAY, TOWER_COLLAPSE_BOUNCE, TOWER_COLLAPSE_SETTLE_VY,
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

/** One chunk of a collapsing tower (see Tower.collapse). */
interface DebrisPiece {
  node:    PIXI.Container;   // Sprite (skin sub-rect) or Graphics (fallback), pivot at its centre
  halfW:   number;
  halfH:   number;
  vx:      number;
  vy:      number;
  spin:    number;           // rad/s
  delay:   number;           // s until this piece lets go (bottom rows first)
  settled: boolean;
}

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
  // Tower art (Graphics body + skin sprite) lives in its own sub-container so
  // the hit shake can jolt the building without dragging the HP bar along.
  private readonly art:      PIXI.Container;
  private shakeTimer = 0;   // seconds of hit shake left (0 = still)
  private shakePhase = 0;
  private skin: PIXI.Sprite | null = null;   // loaded skin sprite, if the tribe has one
  private debris: DebrisPiece[] | null = null;   // non-null once the tower has collapsed
  private lastDrawnTowerRatio = -1;

  // HP bar dimensions — 1.4× height, 1.2× width relative to the original
  // design, then the whole bar (and its label) scaled up another 40 %.
  private static readonly BAR_SCALE = 1.4;
  private static readonly BAR_H = Math.round(10 * 1.4 * Tower.BAR_SCALE);                // 20 px
  private static readonly BAR_W = Math.round((TOWER_WIDTH + 8) * 1.8 * Tower.BAR_SCALE); // ~222 px

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
    this.art       = new PIXI.Container();
    this.container.addChild(this.art);

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
    this.art.addChild(this.body);

    if (skinUrl) {
      const sw   = skinW ?? TOWER_WIDTH;
      const sh   = skinH ?? TOWER_HEIGHT;
      // Source skins are authored facing east; the enemy tower mirrors so it
      // faces west into the battlefield. Anchoring at top-centre keeps the
      // sprite centred on the tower's x regardless of scale sign.
      const flip = side === 'enemy';
      loadFittedTexture(skinUrl, sw, sh)
        .then(tex => {
          if (this.debris) return;   // destroyed before the skin arrived — stay rubble
          this.body.visible = false;
          const sprite = new PIXI.Sprite(tex);
          sprite.anchor.set(0.5, 0);
          sprite.x      = x;
          sprite.y      = baseY - sh;
          sprite.width  = sw;
          sprite.height = sh;
          if (flip) sprite.scale.x = -sprite.scale.x;
          this.skin = sprite;
          this.art.addChildAt(sprite, 0);
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
      fontSize: Math.round(13 * Tower.BAR_SCALE),   // 18 px — keeps the label proportional to the bar
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
    // Coalesce sub-0.5% changes, but never skip the frame that reaches zero:
    // hp clamps at 0, so a killing blow landing on a sliver (4 -> 0 of 1000)
    // moves the ratio by less than the threshold and would leave a destroyed
    // tower reading "4 / 1000" for the rest of the match.
    if (this.hp > 0 && Math.abs(ratio - this.lastDrawnTowerRatio) < 0.005) return;
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
    // Jolt the building. Restarting (not extending) keeps a sustained
    // barrage reading as a continuous rattle at full amplitude.
    if (this.hp <= 0) {
      // tick() stops driving tickShake once the match is over — settle the art
      // now so a tower killed mid-jolt isn't frozen off-centre on the game-over screen.
      this.shakeTimer = 0; this.shakePhase = 0; this.art.x = 0; this.art.y = 0;
      this.collapse();
    } else if (dmg > 0) {
      this.shakeTimer = TOWER_HIT_SHAKE_SEC;
    }
  }

  /** Call each tick: drives the hit-shake offset on the tower art (not the
   *  HP bar) and settles it back to rest when the shake runs out. */
  tickShake(dt: number) {
    if (this.shakeTimer <= 0) return;
    this.shakeTimer = Math.max(0, this.shakeTimer - dt);
    if (this.shakeTimer === 0) { this.art.x = 0; this.art.y = 0; this.shakePhase = 0; return; }
    this.shakePhase += dt;
    const falloff = this.shakeTimer / TOWER_HIT_SHAKE_SEC;      // 1 → 0 over the shake
    const w       = this.shakePhase * Math.PI * 2 * TOWER_HIT_SHAKE_HZ;
    this.art.x = Math.sin(w) * TOWER_HIT_SHAKE_AMP * falloff;
    this.art.y = Math.cos(w * 1.31) * TOWER_HIT_SHAKE_AMP * 0.35 * falloff;
  }

  /**
   * Break the tower into debris. The intact art (skin sprite or Graphics body)
   * is hidden and replaced by a cols × rows grid of pieces covering the same
   * box — sub-rect textures of the skin when one is loaded, flat colour
   * rectangles otherwise. Each piece gets an outward velocity, an upward kick
   * and a spin; rows let go bottom-first so the top visibly drops as the base
   * gives way. tickCollapse() then runs the fall.
   */
  private collapse() {
    if (this.debris) return;
    const cols = TOWER_COLLAPSE_COLS, rows = TOWER_COLLAPSE_ROWS;
    const skin = this.skin;
    // Box the debris covers: the skin's drawn rect, or the Graphics body box.
    const boxW = skin ? this.skinW_resolved : TOWER_WIDTH;
    const boxH = skin ? this.skinH_resolved : TOWER_HEIGHT;
    const left = this.x - boxW / 2, top = this.baseY - boxH;
    const pw = boxW / cols, ph = boxH / rows;
    const flip  = skin ? skin.scale.x < 0 : false;
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const rand  = (a: number, b: number) => a + Math.random() * (b - a);

    this.body.visible = false;
    if (skin) skin.visible = false;
    this.debris = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let node: PIXI.Container;
        if (skin) {
          // Source cell: the enemy skin is mirrored, so screen column c shows
          // source column (cols-1-c); the piece keeps the mirror via scale.x.
          const f  = skin.texture.frame, sc = flip ? cols - 1 - c : c;
          const sub = new PIXI.Texture(skin.texture.baseTexture,
            new PIXI.Rectangle(f.x + sc * f.width / cols, f.y + r * f.height / rows, f.width / cols, f.height / rows));
          const s = new PIXI.Sprite(sub);
          s.anchor.set(0.5);
          s.width = pw; s.height = ph;
          if (flip) s.scale.x = -s.scale.x;
          node = s;
        } else {
          const g = new PIXI.Graphics();
          g.beginFill(color, 0.9).drawRect(-pw / 2, -ph / 2, pw, ph).endFill();
          node = g;
        }
        node.position.set(left + (c + 0.5) * pw, top + (r + 0.5) * ph);
        this.art.addChild(node);
        // Outward: away from the centre column; the middle column picks a side.
        const dir = c < (cols - 1) / 2 ? -1 : c > (cols - 1) / 2 ? 1 : (Math.random() < 0.5 ? -1 : 1);
        this.debris.push({
          node, halfW: pw / 2, halfH: ph / 2,
          vx:    dir * rand(TOWER_COLLAPSE_VX_MIN, TOWER_COLLAPSE_VX_MAX),
          vy:    -rand(TOWER_COLLAPSE_POP_MIN, TOWER_COLLAPSE_POP_MAX),
          spin:  rand(-TOWER_COLLAPSE_SPIN_MAX, TOWER_COLLAPSE_SPIN_MAX),
          delay: (rows - 1 - r) * TOWER_COLLAPSE_ROW_DELAY,
          settled: false,
        });
      }
    }
  }

  /** Call each tick after the tower has died (Game.tickGameOver): advances
   *  the debris until every piece has come to rest on the ground. */
  tickCollapse(dt: number) {
    if (!this.debris) return;
    for (const p of this.debris) {
      if (p.settled) continue;
      if (p.delay > 0) { p.delay -= dt; continue; }
      p.vy += TOWER_COLLAPSE_GRAVITY * dt;
      p.node.x += p.vx * dt;
      p.node.y += p.vy * dt;
      p.node.rotation += p.spin * dt;
      // Rest height follows the piece's rotated extent so flat and upright
      // pieces both sit on the ground line.
      const rot   = p.node.rotation;
      const restY = this.baseY - (p.halfH * Math.abs(Math.cos(rot)) + p.halfW * Math.abs(Math.sin(rot)));
      if (p.node.y >= restY && p.vy > 0) {
        p.node.y = restY;
        if (p.vy > TOWER_COLLAPSE_SETTLE_VY) {
          p.vy = -p.vy * TOWER_COLLAPSE_BOUNCE;
          p.vx *= 0.5; p.spin *= 0.5;
        } else {
          p.vy = 0; p.vx = 0; p.spin = 0;
          // Lie flat-ish: snap to the nearest quarter turn so the rubble stacks cleanly.
          p.node.rotation = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
          p.node.y = this.baseY - (Math.abs(Math.cos(p.node.rotation)) > 0.5 ? p.halfH : p.halfW);
          p.settled = true;
        }
      }
    }
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
