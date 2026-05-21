import * as PIXI from 'pixi.js';
import Matter from 'matter-js';
import {
  GROUND_Y, PLAYER_COLOR, ENEMY_COLOR,
  JUMP_VELOCITY,
  CHAR_PICKUP_DIST, CHAR_DEPOSIT_DIST, CHAR_CARRY_SPEED_MULT, CHAR_COIN_RECOVERY_COOLDOWN,
  CHAR_HP_BAR_W, CHAR_HP_BAR_H,
  SAFE_ZONE_HEAL_RATE, HIT_JUMP_CHANCE,
  TOWER_ATTACK_RANGE, HARASS_SAFETY_BUFFER, RANGED_KITE_THRESHOLD,
  COIN_THROW_VX, COIN_THROW_VY, COIN_THROW_SCAN_RANGE, COIN_THROW_HOLD_SEC, COIN_THROW_MIN_DIST,
  PROMO_KILL_AP, PROMO_COIN_AP, PROMO_THRESHOLDS,
  PROMO_HP_BOOST, PROMO_SPEED_BOOST, PROMO_ATK_BOOST,
  POWERUP_SPEED_MULT, POWERUP_SPEED_DUR_S, POWERUP_ATK_MULT,
  GRENADE_MAX_VX,
} from './constants';
import type { Physics } from './Physics';
import { NavGraph, type PathStep } from './Pathfinding';
import { type LoadedSpriteSet, type AnimationName, getAnimFps, getSpriteScale, getFeetAnchorY } from './SpriteRegistry';
import { type Tribe, tribeForSide } from './Tribes';

export const RANK_NAMES = ['Private', 'Corporal', 'Sergeant', 'Captain'] as const;

// Physics collision box is taller than the visual character so projectiles and
// stacking interactions register reliably even when sprite art is small. Visual
// sizing (sprite scale, HP bar, label) continues to use config.height.
const BODY_HEIGHT_MULT = 1.9;

// Liang-Barsky segment-AABB intersection test.
// Returns true if the segment (x0,y0)→(x1,y1) intersects the rectangle.
function segmentIntersectsAABB(
  x0: number, y0: number,
  x1: number, y1: number,
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  let tMin = 0, tMax = 1;
  const check = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > tMax) return false; if (t > tMin) tMin = t; }
    else        { if (t < tMin) return false; if (t < tMax) tMax = t; }
    return true;
  };
  return check(-dx, x0 - b.x) &&
         check( dx, b.x + b.width  - x0) &&
         check(-dy, y0 - b.y) &&
         check( dy, b.y + b.height - y0);
}
import type { Side } from './Tower';
import type { Coin, CoinKind } from './Coin';
import { COIN_PALETTE } from './Coin';
import type { PlatformData } from './Platform';
import type { BlockData } from './Block';

export interface CharacterConfig {
  type:        'conscript' | 'warrior' | 'archer' | 'rifleman' | 'sniper' | 'heavy' | 'tanker' | 'grenadier' | 'rocketeer';
  hp:          number;
  speed:       number;
  attackRange: number;
  attackPower: number;
  fireRate:    number;
  critical:    number;  // miss probability [0, 1] — roll each attack
  width:       number;
  height:      number;
}

export interface FireRequest {
  side:           Side;
  sx: number; sy: number;
  tx: number; ty: number;
  damage:         number;
  projectileKind: 'arrow' | 'bullet' | 'grenade' | 'rocket';
  shooter?:       Character;
}

/** Context passed to Character.update() each tick. */
export interface UpdateContext {
  dt:                number;
  allChars:          Character[];
  enemyTowerFrontX:  number;
  enemyTowerY:       number;
  homeTowerFrontX:   number;   // the collecting character's own tower
  worldWidth:        number;
  coins:             Coin[];
  platforms:         PlatformData[];
  blocks:            BlockData[];
  navGraph:          NavGraph;
  onFire?:           (req: FireRequest) => void;
  onDamageTower?:    (dmg: number) => void;
  onDepositCoin:     (value: number) => void;
}

type State = 'marching' | 'fighting' | 'collecting' | 'returning' | 'dead';

export class Character {
  readonly side:   Side;
  readonly config: CharacterConfig;

  readonly id:   number;
  readonly name: string;

  hp:    number;
  x:     number;
  y:     number;          // feet y (ground contact point)
  state: State = 'marching';

  readonly container: PIXI.Container;
  private bar:    PIXI.Graphics;
  private barBg:  PIXI.Graphics;

  private body:      Matter.Body;
  private physics:   Physics;
  private jumpVx      = 0;
  private knockbackVx      = 0;
  private knockbackDecayFactor = 1;  // precomputed per frame by caller: Math.exp(-decay * dt)
  private isAirborne  = false;
  private floorY     = GROUND_Y;
  // World bounds between tower faces — set each tick from UpdateContext, used in syncToBody.
  private boundL     = 0;
  private boundR     = 0;
  get isOnPlatform(): boolean { return this.floorY < GROUND_Y; }
  /** Actual height of the physics collision body (taller than config.height by BODY_HEIGHT_MULT). */
  get collisionHeight(): number { return this.config.height * BODY_HEIGHT_MULT; }
  /** Visual/identity tribe (derived from side; future: pickable per game). */
  get tribe(): Tribe { return tribeForSide(this.side); }
  private get isKnockedBack(): boolean { return Math.abs(this.knockbackVx) > 20; }

  /** Damage events emitted this tick; Game.ts reads and clears each frame. */
  readonly pendingDamages: { amount: number; x: number; y: number }[] = [];
  /** Set when the character drops or throws a carried coin; Game.ts spawns the coin.
   *  vx/vy present → deliberate throw (directed velocity, no recovery chase). */
  pendingCoinDrop: { x: number; y: number; value: number; kind: CoinKind; vx?: number; vy?: number } | null = null;

  rank:              0 | 1 | 2 | 3 = 0;
  pendingPromotion = false;
  killedBy: 'character' | 'tower' | null = null;
  private ap            = 0;
  get currentAP(): number { return this.ap; }
  private rankGfx!:     PIXI.Graphics;
  private promoAnimGfx: PIXI.Graphics | null = null;
  private promoAnimTimer = -1;

  private attackTimer        = 0;
  private randomJumpTimer    = Math.random() * 3;  // stagger across characters
  private evasiveJumpTimer   = 0;
  private lastMoveDir:         1 | -1 = 1;
  // Direction of the most recent attack target — used to flip the sprite while
  // attacking, so a character moving forward but attacking a target behind
  // them faces the target (not their travel direction).
  private lastAttackDir:       1 | -1 = 1;
  // Seconds remaining where the sprite stays facing the most recent attack
  // direction, even when state isn't 'fighting' (Rush/Collect fire while
  // moving without flipping into fighting state).
  private attackFacingTimer    = 0;
  // Seconds since the character's x last changed. Used by selectAnimation to
  // fall back to 'idle' when the state machine still says 'marching' but the
  // character is effectively stationary (blocked, no target, etc.).
  private stillTimer            = 0;
  // Seconds of continuous motion (resets when x stops changing). Pairs with
  // stillTimer to give asymmetric hysteresis on the idle↔walk animation
  // switch, so jittery 1-px-per-tick movement doesn't thrash the sprite.
  private movingTimer           = 0;
  private legL:     PIXI.Container | null = null;
  private legR:     PIXI.Container | null = null;
  private legPhase: number = Math.random() * Math.PI * 2;  // stagger across characters
  private spriteSet:          LoadedSpriteSet | null = null;
  private animSprite:         PIXI.AnimatedSprite  | null = null;
  private animSpriteBaseScale = 1;
  private currentAnimName:    AnimationName | null = null;
  private coinPickupCooldown = 0;
  private coinThrowTimer     = -1;  // countdown before throw; -1 = not winding up
  private pendingHitJump     = false;
  private healParticleTimer  = 0;
  private readonly healParticles: Array<{
    gfx:  PIXI.Graphics;
    relY: number;
    vy:   number;
    life: number;
  }> = [];
  private _behavior:    'attacking' | 'collecting' | 'harass' | 'defend' | 'rush' = 'attacking';

  // ── Pathfinding state ─────────────────────────────────────────────────────
  private path:        PathStep[] = [];
  private pathIdx      = 0;
  // Key of the last requested target — avoids rebuilding the path every tick.
  private pathTargetKey = '';
  // Seconds since path was built; stale paths are discarded and rebuilt.
  private pathAge      = 0;
  private readonly PATH_TTL = 8;   // s — re-plan after this many seconds
  // Diagnostic counters (lifetime).
  clampedCount      = 0;
  pathRebuildCount  = 0;
  // Pending jump intent — populated when followPath fires this.jump(), consumed on landing.
  private pendingJumpLog: { startX: number; startFloorY: number; targetX: number; targetFloorY: number } | null = null;
  // Per-jump tick-level tracking for diagnostics.
  private jumpTickCount      = 0;       // ticks where syncToBody saw isAirborne
  private jumpDurationS      = 0;       // sum of dt over those ticks
  private jumpExpectedTravel = 0;       // sum of jumpVx * dt
  private jumpKnockbackTravel = 0;      // sum of knockbackVx * dt while airborne
  private jumpVxAtStart       = 0;
  private jumpDtMin           = Infinity;
  private jumpDtMax           = 0;
  // Drained each tick by Diagnostics.
  private jumpOutcomeQueue: { startX: number; startFloorY: number; targetX: number; targetFloorY: number; landX: number; landFloorY: number; jumpVx: number; ticks: number; durationS: number; expectedTravel: number; knockbackTravel: number; dtMin: number; dtMax: number }[] = [];
  // Last path produced by requestPath (preserved across clearPath() so the
  // diagnostic system can still inspect what pathfinding most recently chose).
  private lastBuiltPath: PathStep[] = [];
  // Stuck detection: if the character hasn't moved while following a path, replan.
  private stuckTimer   = 0;
  private stuckCheckX  = 0;

  /** Read-only view of the current path for debug rendering. */
  get debugPath(): { steps: readonly PathStep[]; currentIdx: number } {
    return { steps: this.path, currentIdx: this.pathIdx };
  }

  private carryingCoin  = false;
  private coinCarryValue: number   = 0;
  private coinCarryKind:  CoinKind = 'gold';
  private targetCoin:   Coin | null = null;
  private coinCarryGfx: PIXI.Graphics | null = null;

  // Power-up effects
  private powerUpSpeedMult  = 1.0;
  private powerUpSpeedTimer = 0;
  private powerUpAtkMult    = 1.0;

  constructor(side: Side, startX: number, config: CharacterConfig, id: number, name: string, physics: Physics, spriteSet?: LoadedSpriteSet) {
    this.side      = side;
    this.id        = id;
    this.name      = name;
    this.config    = { ...config };
    this.hp        = config.hp;
    this.x         = startX;
    this.y         = GROUND_Y;
    this.physics   = physics;
    this.spriteSet = spriteSet ?? null;
    this.body      = physics.createCharBody(startX, GROUND_Y, config.width, config.height * BODY_HEIGHT_MULT);

    this.container = new PIXI.Container();
    this.buildSprite();

    this.barBg = new PIXI.Graphics();
    this.barBg.beginFill(0x333333);
    this.barBg.drawRect(-CHAR_HP_BAR_W / 2, this.hpBarOffsetY(), CHAR_HP_BAR_W, CHAR_HP_BAR_H);
    this.barBg.endFill();
    this.container.addChild(this.barBg);

    this.bar = new PIXI.Graphics();
    this.container.addChild(this.bar);
    this.drawBar();

    this.rankGfx = new PIXI.Graphics();
    this.container.addChild(this.rankGfx);
    this.drawRankBadge();

    const idLabel = new PIXI.Text(name, {
      fontSize:        12,
      fontWeight:      'bold',
      fill:            0xffffff,
      stroke:          0x000000,
      strokeThickness: 2,
    });
    idLabel.anchor.set(0.5, 1);
    idLabel.x = 0;
    idLabel.y = this.hpBarOffsetY() - 2;
    this.container.addChild(idLabel);

    this.syncPosition();
  }

  // ── Diagnostic introspection (read-only snapshot of internal state) ────────

  get diagnosticInfo(): {
    isAirborne:        boolean;
    floorY:            number;
    pathLen:           number;
    pathStep:          { action: string; targetX: number; floorY: number } | null;
    pathRemaining:     { action: string; targetX: number; floorY: number; jumpTriggerX?: number }[];
    lastBuiltPath:     { action: string; targetX: number; floorY: number; jumpTriggerX?: number }[];
    clampedCount:      number;
    pathRebuildCount:  number;
  } {
    const mapStep = (s: PathStep) => ({
      action:       s.action,
      targetX:      s.targetX,
      floorY:       s.floorY,
      jumpTriggerX: s.jumpTriggerX,
    });
    const remaining = this.path.slice(this.pathIdx).map(mapStep);
    return {
      isAirborne:       this.isAirborne,
      floorY:           this.floorY,
      pathLen:          remaining.length,
      pathStep:         remaining[0] ?? null,
      pathRemaining:    remaining,
      lastBuiltPath:    this.lastBuiltPath.map(mapStep),
      clampedCount:     this.clampedCount,
      pathRebuildCount: this.pathRebuildCount,
    };
  }

  // ── Behavior toggle ──────────────────────────────────────────────────────────

  get behavior(): 'attacking' | 'collecting' | 'harass' | 'defend' | 'rush' { return this._behavior; }

  set behavior(val: 'attacking' | 'collecting' | 'harass' | 'defend' | 'rush') {
    if (val === this._behavior) return;
    if (this._behavior === 'collecting') {
      this.targetCoin = null;
      if (this.carryingCoin) this.dropCarriedCoin();
    }
    this._behavior = val;
  }

  // ── Sprite builders ──────────────────────────────────────────────────────────

  private buildSprite() {
    if (this.spriteSet) { this.buildAnimSprite(); return; }
    if      (this.config.type === 'conscript')  this.buildConscriptSprite();
    else if (this.config.type === 'archer')     this.buildArcherSprite();
    else if (this.config.type === 'rifleman')   this.buildRiflemanSprite();
    else if (this.config.type === 'sniper')     this.buildSniperSprite();
    else if (this.config.type === 'heavy')      this.buildHeavySprite();
    else if (this.config.type === 'tanker')     this.buildTankerSprite();
    else if (this.config.type === 'grenadier')  this.buildGrenadierSprite();
    else if (this.config.type === 'rocketeer')  this.buildRocketeerSprite();
    else                                         this.buildWarriorSprite();
  }

  // Creates two animated leg containers (added to container before body, so legs render behind).
  private buildAnimLegs(lx: number, rx: number, legW: number, legH: number, alpha: number) {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const hipY  = this.config.height * 0.55;
    const make  = (cx: number): PIXI.Container => {
      const c = new PIXI.Container();
      c.x = cx; c.y = hipY;
      const g = new PIXI.Graphics();
      g.beginFill(color, alpha);
      g.drawRect(-legW / 2, 0, legW, legH);
      g.endFill();
      c.addChild(g);
      this.container.addChild(c);
      return c;
    };
    this.legL = make(lx);
    this.legR = make(rx);
  }

  /** Render scale that makes a frame `frameH` tall display at `config.height × spriteScale` on screen. */
  private animScaleFor(animName: AnimationName, frameH: number): number {
    return getSpriteScale(this.tribe, this.config.type, animName) * this.config.height / frameH;
  }

  private buildAnimSprite() {
    const set = this.spriteSet!;
    const frames = set.walk ?? set.idle ?? set.attack;
    if (!frames) return;

    const startAnim: AnimationName = set.walk ? 'walk' : set.idle ? 'idle' : 'attack';
    const anim = new PIXI.AnimatedSprite(frames);
    anim.anchor.set(0.5, getFeetAnchorY(this.tribe, this.config.type, startAnim));
    anim.y = this.config.height;  // container origin = head; feet = head + height
    this.animSpriteBaseScale = this.animScaleFor(startAnim, frames[0].height);
    anim.scale.set(this.animSpriteBaseScale);
    anim.animationSpeed = getAnimFps(this.tribe, this.config.type, startAnim) / 60;
    anim.loop = true;
    anim.play();
    this.animSprite      = anim;
    this.currentAnimName = startAnim;
    this.container.addChild(anim);
  }

  private selectAnimation(): AnimationName {
    // Asymmetric hysteresis on idle↔walk so single-tick movement noise doesn't
    // thrash the animation:
    //   - already in walk/carry → keep moving unless still for > 0.15 s
    //   - already in idle/attack → only switch to walk after 0.05 s of motion
    const wasMoving = this.currentAnimName === 'walk' || this.currentAnimName === 'carry';
    const inMotion  = wasMoving ? this.stillTimer < 0.15 : this.movingTimer > 0.05;

    if (this.carryingCoin || this.state === 'returning') return inMotion ? 'carry' : 'idle';
    if (this.state === 'fighting') return 'attack';
    if (this.state === 'marching' || this.state === 'collecting') return inMotion ? 'walk' : 'idle';
    return 'idle';
  }

  private switchAnimation(name: AnimationName) {
    const anim = this.animSprite;
    const set  = this.spriteSet;
    if (!anim || !set) return;

    // Fallback order so a missing animation uses the closest available substitute
    const fallback: Record<AnimationName, AnimationName[]> = {
      idle:       ['idle', 'walk'],
      walk:       ['walk', 'idle'],
      attack:     ['attack', 'idle', 'walk'],
      attackWalk: ['attackWalk', 'attack', 'walk'],
      carry:      ['carry', 'walk', 'idle'],
    };
    let frames: PIXI.Texture[] | undefined;
    let picked: AnimationName = name;
    for (const n of fallback[name]) {
      if (set[n]) { frames = set[n]; picked = n; break; }
    }
    if (!frames) return;

    anim.textures            = frames;
    anim.anchor.set(0.5, getFeetAnchorY(this.tribe, this.config.type, picked));
    anim.animationSpeed      = getAnimFps(this.tribe, this.config.type, picked) / 60;
    this.animSpriteBaseScale = this.animScaleFor(picked, frames[0].height);
    anim.play();
    this.currentAnimName = name;
  }

  private tickAnimSprite() {
    const anim = this.animSprite;
    if (!anim) return;

    // Face the attack target while fighting OR within the brief post-fire window
    // (Rush/Collect fire opportunistically without entering fighting state).
    // Otherwise face the actual travel direction. Sprites are drawn facing right.
    const facingDir = (this.state === 'fighting' || this.attackFacingTimer > 0)
      ? this.lastAttackDir
      : this.lastMoveDir;
    anim.scale.x    = this.animSpriteBaseScale * facingDir;

    const target = this.selectAnimation();
    if (target !== this.currentAnimName) this.switchAnimation(target);

    this.updateLocomotionFps();
  }

  /**
   * Scale the walk/carry/attackWalk animation speed by the character's current
   * effective moveSpeed vs its config baseline, so promotions, carry slowdown,
   * and speed power-ups keep the stride visually in sync with the actual pace.
   * Idle and attack are stationary — left at their baseline fps.
   */
  private updateLocomotionFps() {
    const anim = this.animSprite;
    const name = this.currentAnimName;
    if (!anim || !name) return;
    if (name !== 'walk' && name !== 'carry' && name !== 'attackWalk') return;

    const baselineFps = getAnimFps(this.tribe, this.config.type, name);
    const ratio       = this.moveSpeed / this.config.speed;
    const targetSpeed = (baselineFps * ratio) / 60;

    // PIXI dirty-flags on every write; only push when it would actually change.
    if (Math.abs(anim.animationSpeed - targetSpeed) > 1e-4) {
      anim.animationSpeed = targetSpeed;
    }
  }

  private buildConscriptSprite() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.3, w * 0.3, w * 0.32, h * 0.45, 0.65);

    const g = new PIXI.Graphics();
    // Simple torso (no armour)
    g.beginFill(color, 0.72);
    g.drawRoundedRect(-w * 0.42, h * 0.22, w * 0.84, h * 0.38, 4);
    g.endFill();
    // Head
    g.beginFill(color, 0.88);
    g.drawCircle(0, h * 0.1, w * 0.35);
    g.endFill();
    // Punching arm extending forward
    const armStartX = dir * w * 0.42;
    const fistX     = dir * (w * 0.42 + w * 0.5);
    const armY      = h * 0.29;
    g.beginFill(color, 0.7);
    g.drawRect(Math.min(armStartX, fistX), armY, Math.abs(fistX - armStartX), 5);
    g.endFill();
    // Fist
    g.beginFill(color);
    g.drawRoundedRect(fistX - 5, armY - 4, 10, 9, 3);
    g.endFill();

    this.container.addChild(g);
  }

  private buildWarriorSprite() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.325, w * 0.325, w * 0.35, h * 0.45, 0.6);

    const g = new PIXI.Graphics();
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
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.15, w * 0.15, w * 0.26, h * 0.45, 0.55);

    const g = new PIXI.Graphics();
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
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.31, w * 0.31, w * 0.38, h * 0.45, 0.5);

    const g = new PIXI.Graphics();
    // Torso with combat vest
    g.beginFill(color, 0.9);
    g.drawRoundedRect(-w * 0.46, h * 0.18, w * 0.92, h * 0.42, 3);
    g.endFill();
    g.lineStyle(1, color, 0.4);
    g.moveTo(-w * 0.12, h * 0.22); g.lineTo(-w * 0.12, h * 0.58);
    g.moveTo( w * 0.12, h * 0.22); g.lineTo( w * 0.12, h * 0.58);
    g.lineStyle(0);

    // Head
    g.beginFill(color, 0.85);
    g.drawCircle(0, h * 0.1, w * 0.36);
    g.endFill();
    // Wide infantry helmet
    g.beginFill(color);
    g.drawRoundedRect(-w * 0.42, h * 0.02 - 9, w * 0.84, 11, 3);
    g.endFill();

    // Assault rifle (shorter barrel than sniper)
    const ry = h * 0.30;
    // Stock
    const stockL = Math.min(-dir * 12, -dir * 2);
    const stockW = Math.abs(-dir * 12 - (-dir * 2));
    g.beginFill(0x5c3d1e);
    g.drawRoundedRect(stockL, ry, stockW, 8, 2);
    g.endFill();
    // Receiver
    const recvL = Math.min(-dir * 2, dir * 14);
    const recvW = Math.abs(-dir * 2 - dir * 14);
    g.beginFill(0x3a3a3a);
    g.drawRect(recvL, ry, recvW, 6);
    g.endFill();
    // Magazine hanging below receiver
    const magX = dir > 0 ? 4 : -10;
    g.beginFill(0x2a2a2a);
    g.drawRoundedRect(magX, ry + 6, 6, 9, 1);
    g.endFill();
    // Barrel (14→26 px; sniper is 16→38)
    const barlL = Math.min(dir * 14, dir * 26);
    const barlW = Math.abs(dir * 14 - dir * 26);
    g.beginFill(0x2a2a2a);
    g.drawRect(barlL, ry + 1, barlW, 4);
    g.endFill();
    // Muzzle
    g.beginFill(0x1a1a1a);
    g.drawRect(dir > 0 ? dir * 26 : dir * 26 - 3, ry, 3, 6);
    g.endFill();

    this.container.addChild(g);
  }

  private buildSniperSprite() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.31, w * 0.31, w * 0.38, h * 0.45, 0.5);

    const g = new PIXI.Graphics();
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
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.25, w * 0.25, w * 0.38, h * 0.45, 0.7);

    const g = new PIXI.Graphics();
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

  private buildTankerSprite() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width;
    const h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;

    // All vertical positions are proportional so the sprite fills the full h.
    // From bottom:  tracks (0–18%), lower hull (18–52%), upper hull (52–70%),
    //               turret (52–88%), cupola (88–100%).
    const trackTop    = h * 0.82;
    const hullLowTop  = h * 0.48;
    const hullHighTop = h * 0.30;
    const turretTop   = h * 0.12;
    const cupolaTop   = h * 0.00;

    const g = new PIXI.Graphics();

    // ── Rubber track belt ─────────────────────────────────────────────────
    g.beginFill(0x1e1e1e);
    g.drawRoundedRect(-w / 2, trackTop, w, h - trackTop, 3);
    g.endFill();
    // Tread links
    g.lineStyle(1, 0x333333, 0.8);
    for (let i = 0; i <= 8; i++) {
      const tx = -w / 2 + i * (w / 8);
      g.moveTo(tx, trackTop);
      g.lineTo(tx, h);
    }
    g.lineStyle(0);
    // Road wheels
    const wheelY = trackTop + (h - trackTop) * 0.5;
    const wheelR = (h - trackTop) * 0.38;
    g.beginFill(0x3d3d3d);
    for (let i = 0; i < 5; i++) {
      g.drawCircle(-w / 2 + 9 + i * ((w - 18) / 4), wheelY, wheelR);
    }
    g.endFill();
    g.beginFill(0x666666, 0.6);
    for (let i = 0; i < 5; i++) {
      g.drawCircle(-w / 2 + 9 + i * ((w - 18) / 4), wheelY, wheelR * 0.45);
    }
    g.endFill();

    // ── Lower hull ────────────────────────────────────────────────────────
    g.beginFill(color, 0.85);
    g.drawRoundedRect(-w / 2, hullLowTop, w, trackTop - hullLowTop, 3);
    g.endFill();
    // Side skirt panels
    g.beginFill(0x000000, 0.18);
    g.drawRect(-w / 2,     hullLowTop, 6, trackTop - hullLowTop);
    g.drawRect(w / 2 - 6,  hullLowTop, 6, trackTop - hullLowTop);
    g.endFill();

    // ── Upper hull ────────────────────────────────────────────────────────
    g.beginFill(color);
    g.drawRoundedRect(-w / 2 + 6, hullHighTop, w - 12, hullLowTop - hullHighTop, 4);
    g.endFill();
    // Ventilation grill (rear side)
    g.lineStyle(1, 0x000000, 0.18);
    for (let i = 0; i < 4; i++) {
      const gx = -dir * (w * 0.14 + i * 5);
      g.moveTo(gx, hullHighTop + 2);
      g.lineTo(gx, hullLowTop - 2);
    }
    g.lineStyle(0);

    // ── Turret ────────────────────────────────────────────────────────────
    const turretCx = dir * w * 0.06;
    const turretH  = hullHighTop - turretTop;
    g.beginFill(color);
    g.drawRoundedRect(turretCx - w * 0.28, turretTop, w * 0.56, turretH, 6);
    g.endFill();
    // Turret top highlight
    g.beginFill(0xffffff, 0.12);
    g.drawRoundedRect(turretCx - w * 0.22, turretTop + 2, w * 0.44, turretH * 0.35, 4);
    g.endFill();
    // Armour weld lines
    g.lineStyle(1, 0x000000, 0.12);
    g.moveTo(turretCx - w * 0.28, turretTop + turretH * 0.5);
    g.lineTo(turretCx + w * 0.28, turretTop + turretH * 0.5);
    g.lineStyle(0);

    // ── Commander's cupola ────────────────────────────────────────────────
    const cupolaCx = turretCx - dir * w * 0.06;
    const cupolaH  = turretTop - cupolaTop;
    g.beginFill(color);
    g.drawRoundedRect(cupolaCx - w * 0.10, cupolaTop, w * 0.20, cupolaH + 3, 4);
    g.endFill();
    g.lineStyle(1.5, 0x000000, 0.22);
    g.drawCircle(cupolaCx, cupolaTop + cupolaH * 0.5, w * 0.07);
    g.lineStyle(0);

    // ── Gun barrel ────────────────────────────────────────────────────────
    const barrelCY   = turretTop + turretH * 0.55;
    const barrelFrom = turretCx + dir * w * 0.28;
    const barrelTo   = dir * w * 0.72;
    const barrelH    = Math.max(5, turretH * 0.28);
    g.beginFill(0x2e2e2e);
    g.drawRect(
      Math.min(barrelFrom, barrelTo),
      barrelCY - barrelH / 2,
      Math.abs(barrelTo - barrelFrom),
      barrelH,
    );
    g.endFill();
    // Muzzle brake
    const muzzleX = dir > 0
      ? Math.max(barrelFrom, barrelTo) - 4
      : Math.min(barrelFrom, barrelTo) - 2;
    g.beginFill(0x1a1a1a);
    g.drawRect(muzzleX, barrelCY - barrelH * 0.85, 6, barrelH * 1.7);
    g.endFill();
    // Barrel ring near turret
    g.lineStyle(2, color, 0.55);
    const ringX = turretCx + dir * w * 0.28 - (dir > 0 ? 2 : -5);
    g.drawRect(ringX, barrelCY - barrelH * 0.7, 5, barrelH * 1.4);
    g.lineStyle(0);

    this.container.addChild(g);
  }

  private buildGrenadierSprite() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.32, w * 0.32, w * 0.34, h * 0.45, 0.58);

    const g = new PIXI.Graphics();

    // Body — olive drab jacket
    g.beginFill(0x4a5a2a, 0.92);
    g.drawRoundedRect(-w * 0.5, h * 0.18, w, h * 0.42, 3);
    g.endFill();
    // Chest ammo pouches
    g.beginFill(0x3a4a1a, 0.8);
    g.drawRoundedRect(-w * 0.18, h * 0.22, w * 0.36, h * 0.14, 2);
    g.endFill();

    // Head
    g.beginFill(color, 0.88);
    g.drawCircle(0, h * 0.10, w * 0.37);
    g.endFill();
    // Helmet
    g.beginFill(0x3a4a1a);
    g.drawEllipse(0, h * 0.04, w * 0.43, w * 0.28);
    g.endFill();

    // Grenade launcher — thick tube at arm/shoulder height
    const tubeY  = h * 0.26;
    const tubeLen = w * 0.90;
    const tubeH  = h * 0.11;
    g.beginFill(0x222222);
    g.drawRoundedRect(dir > 0 ? w * 0.06 : -w * 0.96, tubeY, tubeLen, tubeH, 2);
    g.endFill();
    // Tube highlight
    g.beginFill(0xffffff, 0.10);
    g.drawRoundedRect(dir > 0 ? w * 0.06 : -w * 0.96, tubeY, tubeLen, tubeH * 0.4, 2);
    g.endFill();
    // Barrel opening at the front
    g.beginFill(0x111111);
    g.drawCircle(dir > 0 ? w * 0.96 : -w * 0.96, tubeY + tubeH * 0.5, tubeH * 0.6);
    g.endFill();
    // Grip handle under tube
    g.beginFill(0x333333);
    g.drawRoundedRect(dir > 0 ? w * 0.12 : -w * 0.22, tubeY + tubeH, w * 0.10, h * 0.12, 2);
    g.endFill();

    this.container.addChild(g);
  }

  private buildRocketeerSprite() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.32, w * 0.32, w * 0.34, h * 0.45, 0.58);

    const g = new PIXI.Graphics();

    // Body — dark military jacket
    g.beginFill(0x2e3b2e, 0.92);
    g.drawRoundedRect(-w * 0.50, h * 0.18, w, h * 0.42, 3);
    g.endFill();
    // Chest plate / blast vest highlight
    g.beginFill(0x1e2b1e, 0.7);
    g.drawRoundedRect(-w * 0.28, h * 0.20, w * 0.56, h * 0.20, 2);
    g.endFill();

    // Head with visor helmet
    g.beginFill(color, 0.88);
    g.drawCircle(0, h * 0.10, w * 0.37);
    g.endFill();
    // Helmet dome
    g.beginFill(0x2e3b2e);
    g.drawEllipse(0, h * 0.04, w * 0.43, w * 0.28);
    g.endFill();
    // Dark visor strip across the face
    g.beginFill(0x111122, 0.9);
    g.drawRoundedRect(-w * 0.30, h * 0.07, w * 0.60, h * 0.12, 3);
    g.endFill();
    // Visor glint
    g.beginFill(0x4488cc, 0.35);
    g.drawRoundedRect(-w * 0.26, h * 0.08, w * 0.22, h * 0.05, 2);
    g.endFill();

    // Rocket launcher — shoulder-mounted tube, thicker than the grenadier's
    const tubeY   = h * 0.20;
    const tubeLen = w * 1.10;
    const tubeH   = h * 0.14;
    g.beginFill(0x1e1e28);
    g.drawRoundedRect(dir > 0 ? -w * 0.08 : -w * 1.02, tubeY, tubeLen, tubeH, 3);
    g.endFill();
    // Tube highlight
    g.beginFill(0xffffff, 0.08);
    g.drawRoundedRect(dir > 0 ? -w * 0.08 : -w * 1.02, tubeY, tubeLen, tubeH * 0.35, 3);
    g.endFill();
    // Muzzle opening at the front
    g.beginFill(0x080810);
    g.drawCircle(dir > 0 ? w * 1.02 : -w * 1.02, tubeY + tubeH * 0.5, tubeH * 0.65);
    g.endFill();
    // Exhaust ring at back (subtle orange glow)
    g.lineStyle(1.5, 0xff6600, 0.6);
    g.drawCircle(dir > 0 ? -w * 0.08 : w * 0.08, tubeY + tubeH * 0.5, tubeH * 0.5);
    g.lineStyle(0);
    // Shoulder grip
    g.beginFill(0x2e3b2e, 0.8);
    g.drawRoundedRect(-w * 0.10, tubeY - 1, w * 0.20, h * 0.22, 2);
    g.endFill();

    this.container.addChild(g);
  }

  // ── HP bar ───────────────────────────────────────────────────────────────────

  get maxHp() { return this.config.hp * (1 + this.rank * PROMO_HP_BOOST); }

  /**
   * Y offset (in container coords) where the HP bar / name label should sit.
   * Anchored 30 px above the top of the collision box, regardless of
   * rendering style (sprite or Graphics).
   */
  private hpBarOffsetY(): number {
    // Container origin is at the head (this.y - config.height); feet at +config.height.
    // The collision body extends upward from the feet by config.height * BODY_HEIGHT_MULT,
    // so the body top in container coords is -config.height * (BODY_HEIGHT_MULT - 1).
    const bodyTop = -this.config.height * (BODY_HEIGHT_MULT - 1);
    return bodyTop - 30;
  }

  private drawBar() {
    const ratio = Math.max(0, this.hp / this.maxHp);
    this.bar.clear();
    this.bar.beginFill(this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR);
    this.bar.drawRect(-CHAR_HP_BAR_W / 2, this.hpBarOffsetY(), CHAR_HP_BAR_W * ratio, CHAR_HP_BAR_H);
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

  private tickRandomJump(dt: number, homeTowerFrontX: number) {
    if (this.config.type === 'tanker') return;
    if (this.isAirborne || this.state === 'fighting') return;
    if (this.isOnPlatform) return;   // stay on platform; horizontal movement is the right action
    this.randomJumpTimer -= dt;
    if (this.randomJumpTimer > 0) return;
    this.randomJumpTimer = 1.5 + Math.random() * 2;  // next check in 1.5–3.5 s

    const sideDir = this.side === 'player' ? 1 : -1;
    if (sideDir * (this.x - homeTowerFrontX) < 120) return;  // too close to home
    if (Math.random() < 0.20) this.jump(this.lastMoveDir, dt);
  }

  private tickLegs(dt: number) {
    if (!this.legL || !this.legR) return;

    const MAX_SWING = 0.42;   // radians ≈ 24°
    const WALK_FREQ = 7.0;    // phase advance per second

    if (this.isAirborne) {
      // Tuck back on ascent, extend forward on descent — direction-aware
      const vy  = this.body.velocity.y;
      const dir = this.lastMoveDir;
      const tL  = vy < 0 ? -dir * 0.50 :  dir * 0.30;
      const tR  = vy < 0 ? -dir * 0.30 :  dir * 0.20;
      this.legL.rotation += (tL - this.legL.rotation) * 0.22;
      this.legR.rotation += (tR - this.legR.rotation) * 0.22;
      return;
    }

    const walking = this.state === 'marching'   ||
                    this.state === 'collecting' ||
                    this.state === 'returning';

    if (walking) {
      this.legPhase += WALK_FREQ * dt;
      this.legL.rotation = Math.sin(this.legPhase)           * MAX_SWING;
      this.legR.rotation = Math.sin(this.legPhase + Math.PI) * MAX_SWING;
    } else {
      // Idle: decay toward neutral stance
      this.legL.rotation *= 0.85;
      this.legR.rotation *= 0.85;
    }
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
    this.coinThrowTimer     = -1;
    this.removeCoinCarry();
    this.pendingCoinDrop    = { x: this.x, y: this.y - this.config.height * 0.5, value: this.coinCarryValue, kind: this.coinCarryKind };
    this.coinPickupCooldown = CHAR_COIN_RECOVERY_COOLDOWN;
  }

  private throwCarriedCoin(towardX: number) {
    const dir          = Math.sign(towardX - this.x);
    this.carryingCoin  = false;
    this.removeCoinCarry();
    this.pendingCoinDrop = {
      x: this.x, y: this.y - this.config.height * 0.5,
      value: this.coinCarryValue, kind: this.coinCarryKind,
      vx: dir * COIN_THROW_VX, vy: -COIN_THROW_VY,  // 60° — vy ≈ vx × √3
    };
    // No cooldown — character stays active in the field immediately
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  takeDamage(dmg: number, killer?: Character) {
    // Always queue a label event (amount=0 → "Miss" in Game.ts)
    this.pendingDamages.push({ amount: dmg, x: this.x, y: this.y - this.config.height - 6 });
    if (dmg <= 0) return;  // miss — no HP change, no coin drop, no kill

    this.hp = Math.max(0, this.hp - dmg);
    this.drawBar();
    if (this.carryingCoin) this.dropCarriedCoin();
    if (!this.isAirborne && Math.random() < HIT_JUMP_CHANCE) this.pendingHitJump = true;
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

  /** Approximate horizontal velocity (px/s) — used by grenadier lead targeting. */
  get approxVx(): number {
    if (this.state === 'dead' || this.state === 'fighting') return 0;
    return this.moveSpeed * this.lastMoveDir;
  }

  get claimedCoin(): Coin | null { return this.targetCoin; }

  private get isRanged() {
    const t = this.config.type;
    return t === 'archer' || t === 'rifleman' || t === 'sniper' || t === 'grenadier' || t === 'rocketeer';
  }

  private static isMeleeType(type: CharacterConfig['type']) {
    return type === 'conscript' || type === 'warrior' || type === 'heavy';
  }

  update(ctx: UpdateContext) {
    if (this.isDead) return;

    this.attackTimer        = Math.max(0, this.attackTimer        - ctx.dt);
    this.evasiveJumpTimer   = Math.max(0, this.evasiveJumpTimer   - ctx.dt);
    this.attackFacingTimer  = Math.max(0, this.attackFacingTimer  - ctx.dt);

    if (this.powerUpSpeedTimer > 0) {
      this.powerUpSpeedTimer -= ctx.dt;
      if (this.powerUpSpeedTimer <= 0) {
        this.powerUpSpeedTimer = 0;
        this.powerUpSpeedMult  = 1.0;
      }
    }

    // Evasive jump on hit
    if (this.pendingHitJump) {
      this.pendingHitJump = false;
      if (!this.isAirborne) this.jump(this.lastMoveDir, ctx.dt);
    }

    // Passive regen while inside own tower's attack range
    const inSafeZone = this.hp < this.maxHp && Math.abs(this.x - ctx.homeTowerFrontX) <= TOWER_ATTACK_RANGE;
    if (inSafeZone) this.heal(SAFE_ZONE_HEAL_RATE * ctx.dt);
    this.tickHealParticles(ctx.dt, inSafeZone);

    if (this.coinPickupCooldown > 0) {
      this.coinPickupCooldown = Math.max(0, this.coinPickupCooldown - ctx.dt);
      this.container.alpha = this.coinPickupCooldown > 0
        ? 0.3 + 0.7 * Math.abs(Math.sin(this.coinPickupCooldown * 10))
        : 1;
    }

    this.syncFromBody(ctx.platforms, ctx.blocks);

    const preX = this.x;
    if (!this.isKnockedBack) {
      if (this._behavior === 'collecting') {
        this.updateCollecting(ctx);
      } else if (this._behavior === 'harass') {
        this.updateHarass(ctx);
      } else if (this._behavior === 'defend') {
        this.updateDefending(ctx);
      } else if (this._behavior === 'rush') {
        this.updateRushing(ctx);
      } else {
        this.updateAttacking(ctx);
      }
      this.tickRandomJump(ctx.dt, ctx.homeTowerFrontX);
    }
    if (this.x !== preX) {
      this.lastMoveDir  = (this.x > preX ? 1 : -1);
      this.stillTimer   = 0;
      this.movingTimer += ctx.dt;
    } else {
      this.movingTimer  = 0;
      this.stillTimer  += ctx.dt;
    }
    this.tickLegs(ctx.dt);
    this.tickAnimSprite();
    this.tickPromoAnim(ctx.dt);

    // Hard boundary: characters are blocked at each tower's front face (solid collision).
    this.boundL = Math.min(ctx.homeTowerFrontX, ctx.enemyTowerFrontX);
    this.boundR = Math.max(ctx.homeTowerFrontX, ctx.enemyTowerFrontX);
    if (this.x < this.boundL) { this.x = this.boundL; this.jumpVx = 0; }
    if (this.x > this.boundR) { this.x = this.boundR; this.jumpVx = 0; }

    // Block horizontal wall collision — character X is teleported by AI so physics
    // cannot stop side entry; clamp manually. Skip while airborne so jump arcs are
    // not interrupted (landing is handled by syncFromBody).
    if (!this.isAirborne) this.clampBlockWalls(ctx.blocks);
    this.tickStuck(ctx.dt);

    this.syncPosition();
  }

  // ── Physics ──────────────────────────────────────────────────────────────────

  private jump(dirX: number, dt: number) {
    if (this.isAirborne) return;
    if (this.config.type === 'tanker') return;   // tanks cannot jump
    this.jumpVx     = dirX * this.moveSpeed;
    this.isAirborne = true;
    this.jumpTickCount       = 0;
    this.jumpDurationS       = 0;
    this.jumpExpectedTravel  = 0;
    this.jumpKnockbackTravel = 0;
    this.jumpVxAtStart       = this.jumpVx;
    this.jumpDtMin           = Infinity;
    this.jumpDtMax           = 0;
    Matter.Body.setVelocity(this.body, {
      x: this.body.velocity.x,
      y: -JUMP_VELOCITY * dt,   // px/tick = px/s * s/tick
    });
  }

  applyKnockback(vx: number, vy: number, dt: number, decayFactor: number) {
    this.knockbackVx          = vx;
    this.knockbackDecayFactor = decayFactor;
    this.isAirborne           = true;
    this.jumpVx               = 0;
    this.clearPath();
    Matter.Body.setVelocity(this.body, {
      x: this.body.velocity.x,
      y: -Math.abs(vy) * dt,
    });
  }

  syncToBody(dt: number) {
    // Apply and decay horizontal knockback regardless of airborne state so the
    // sliding effect continues after the character lands.
    if (this.knockbackVx !== 0) {
      const kbDelta = this.knockbackVx * dt;
      this.x += kbDelta;
      if (this.isAirborne) this.jumpKnockbackTravel += kbDelta;
      this.knockbackVx *= this.knockbackDecayFactor;
      if (Math.abs(this.knockbackVx) < 1) this.knockbackVx = 0;
      if (this.x < this.boundL) { this.x = this.boundL; this.knockbackVx = 0; }
      if (this.x > this.boundR) { this.x = this.boundR; this.knockbackVx = 0; }
    }
    if (this.isAirborne) {
      const xBefore = this.x;
      this.x += this.jumpVx * dt;
      // Enforce tower faces while airborne (clamp in update() runs before syncToBody).
      if (this.x < this.boundL) { this.x = this.boundL; this.jumpVx = 0; }
      if (this.x > this.boundR) { this.x = this.boundR; this.jumpVx = 0; }
      this.jumpTickCount++;
      this.jumpDurationS      += dt;
      this.jumpExpectedTravel += this.x - xBefore;  // post-clamp delta from this branch
      if (dt < this.jumpDtMin) this.jumpDtMin = dt;
      if (dt > this.jumpDtMax) this.jumpDtMax = dt;
    } else if (this.knockbackVx !== 0) {
      // knockback delta already applied above; track it for diagnosis even when not airborne
    }
    // Character bodies have no Matter.js platform collision (mask: CAT_GROUND only).
    // Without pinning, gravity pulls the body through the platform to the ground,
    // making char.y drift to GROUND_Y while floorY stays stale at platform height.
    const onPlatform = !this.isAirborne && this.floorY < GROUND_Y;
    Matter.Body.setPosition(this.body, {
      x: this.x,
      y: onPlatform ? this.floorY - (this.config.height * BODY_HEIGHT_MULT) / 2 : this.body.position.y,
    });
    Matter.Body.setVelocity(this.body, { x: 0, y: onPlatform ? 0 : this.body.velocity.y });
  }

  private recordJumpOutcome(landFloorY: number): void {
    if (!this.pendingJumpLog) return;
    this.jumpOutcomeQueue.push({
      ...this.pendingJumpLog,
      landX: this.x,
      landFloorY,
      jumpVx:          this.jumpVxAtStart,
      ticks:           this.jumpTickCount,
      durationS:       this.jumpDurationS,
      expectedTravel:  this.jumpExpectedTravel,
      knockbackTravel: this.jumpKnockbackTravel,
      dtMin:           this.jumpDtMin === Infinity ? 0 : this.jumpDtMin,
      dtMax:           this.jumpDtMax,
    });
    this.pendingJumpLog = null;
  }

  consumeJumpOutcomes(): {
    startX: number; startFloorY: number; targetX: number; targetFloorY: number;
    landX: number; landFloorY: number;
    jumpVx: number; ticks: number; durationS: number; expectedTravel: number; knockbackTravel: number;
    dtMin: number; dtMax: number;
  }[] {
    const out = this.jumpOutcomeQueue;
    this.jumpOutcomeQueue = [];
    return out;
  }

  private clampBlockWalls(blocks: BlockData[]): void {
    const charTop = this.y - this.config.height;
    for (const b of blocks) {
      // Standing on top of this block (or any higher surface): skip lateral clamp.
      // floorY is set on landing and isn't subject to the per-step gravity drift
      // that pulls this.y a fraction of a px below floorY between syncToBody pins.
      if (this.floorY <= b.y) continue;
      if (charTop >= b.y + b.height) continue;
      // Push to the nearest block edge
      if (this.x > b.x && this.x < b.x + b.width) {
        this.x = this.x < b.x + b.width / 2 ? b.x : b.x + b.width;
        this.knockbackVx = 0;
        this.clampedCount++;
        // Clear the path so requestPath replans from the clamped position
        // (the new subsegment) and routes a jump over the block.
        this.clearPath();
      }
    }
  }

  syncFromBody(platforms: PlatformData[], blocks: BlockData[]) {
    const halfH     = (this.config.height * BODY_HEIGHT_MULT) / 2;
    // positionPrev is an internal Matter.js field not exposed in the public types;
    // it gives the body's position from before the last physics step, which is
    // required for the tunneling-safe platform/block landing check below.
    const prevFeetY = (this.body as unknown as { positionPrev: { y: number } }).positionPrev.y + halfH;
    this.y          = this.body.position.y + halfH;

    if (this.isAirborne) {
      // Platform/block landing: detect feet crossing the surface while falling (tunneling-safe).
      if (this.body.velocity.y >= 0) {
        for (const p of platforms) {
          if (this.x >= p.x && this.x <= p.x + p.width && prevFeetY <= p.y && this.y >= p.y) {
            this.y = p.y;
            Matter.Body.setPosition(this.body, { x: this.body.position.x, y: p.y - halfH });
            Matter.Body.setVelocity(this.body, { x: 0, y: 0 });
            this.isAirborne = false;
            this.jumpVx     = 0;
            this.floorY     = p.y;
            this.recordJumpOutcome(p.y);
            return;
          }
        }
        for (const b of blocks) {
          if (this.x >= b.x && this.x <= b.x + b.width && prevFeetY <= b.y && this.y >= b.y) {
            this.y = b.y;
            Matter.Body.setPosition(this.body, { x: this.body.position.x, y: b.y - halfH });
            Matter.Body.setVelocity(this.body, { x: 0, y: 0 });
            this.isAirborne = false;
            this.jumpVx     = 0;
            this.floorY     = b.y;
            this.recordJumpOutcome(b.y);
            return;
          }
        }
      }

      // Ground landing: only when falling (vy ≥ 0) — prevents premature reset
      // on the tick a jump starts, when the body hasn't moved up yet.
      if (this.y >= GROUND_Y - 1 && this.body.velocity.y >= 0) {
        this.isAirborne = false;
        this.jumpVx     = 0;
        this.floorY     = GROUND_Y;
        this.y          = GROUND_Y;
        this.recordJumpOutcome(GROUND_Y);
      }
    } else if (this.floorY < GROUND_Y) {
      // On elevated surface — detect walking off edge horizontally.
      // Match only the surface at this character's current floorY; a different
      // platform/block below that happens to overlap in x must not count, or the
      // character keeps walking at the higher floorY in mid-air.
      const onPlat  = platforms.some(p => this.x >= p.x && this.x <= p.x + p.width && Math.abs(p.y - this.floorY) < 1);
      const onBlock = blocks.some(b => this.x >= b.x && this.x <= b.x + b.width && Math.abs(b.y - this.floorY) < 1);
      if (!onPlat && !onBlock) this.isAirborne = true;
    }
  }

  // ── Pathfinding ──────────────────────────────────────────────────────────────

  /**
   * Request a fresh path to (toX, toFloorY) only when the target moved
   * far enough or the existing path has gone stale.
   */
  private requestPath(toX: number, toFloorY: number, navGraph: NavGraph, dt: number): void {
    // Quantise target to a 20 px grid so minor positional drift (e.g. an enemy
    // character drifting a few pixels) doesn't trigger a full path rebuild every tick.
    const key = `${Math.round(toX / 20) * 20},${Math.round(toFloorY)}`;
    this.pathAge += dt;
    if (key === this.pathTargetKey && this.pathAge < this.PATH_TTL && this.path.length > 0) return;

    this.path         = navGraph.findPath(this.x, this.floorY, toX, toFloorY, this.moveSpeed);
    this.pathIdx      = 0;
    this.pathTargetKey = key;
    this.pathAge      = 0;
    this.pathRebuildCount++;
    this.lastBuiltPath = this.path.slice();
  }

  /** Invalidate the current path (e.g. after a coin is picked up, target changes). */
  clearPath(): void {
    this.path          = [];
    this.pathIdx       = 0;
    this.pathTargetKey = '';
  }

  private tickStuck(dt: number): void {
    const hasActivePath = this.path.length > 0 && this.pathIdx < this.path.length;
    if (!hasActivePath || this.isAirborne || this.isKnockedBack) {
      this.stuckTimer  = 0;
      this.stuckCheckX = this.x;
      return;
    }
    this.stuckTimer += dt;
    if (this.stuckTimer >= 1.5) {
      if (Math.abs(this.x - this.stuckCheckX) < 4) this.clearPath();
      this.stuckTimer  = 0;
      this.stuckCheckX = this.x;
    }
  }

  /**
   * Follow the current path one tick.
   * Returns true when the final step is reached; false while still en-route.
   * Modifies this.x and may call this.jump().
   */
  private followPath(dt: number): boolean {
    if (this.pathIdx >= this.path.length) return true;

    const step = this.path[this.pathIdx];

    // ── walk ─────────────────────────────────────────────────────────────────
    if (step.action === 'walk') {
      // If the character has already transitioned to a different surface (e.g. fell
      // off a block before reaching the planned walk target), skip this step so the
      // character doesn't walk backward to an edge that no longer makes sense.
      if (!this.isAirborne && Math.abs(this.floorY - step.floorY) > 20) {
        this.pathIdx++;
        return this.pathIdx >= this.path.length;
      }
      const dx = step.targetX - this.x;
      if (Math.abs(dx) <= 10) {
        this.pathIdx++;
        return this.pathIdx >= this.path.length;
      }
      if (!this.isAirborne) this.x += Math.sign(dx) * this.moveSpeed * dt;
      return false;
    }

    // ── jump ─────────────────────────────────────────────────────────────────
    if (step.action === 'jump') {
      // Tanker cannot jump — skip the step and walk toward the target x on the ground.
      if (this.config.type === 'tanker') {
        this.pathIdx++;
        return false;
      }
      // If already on the target surface, advance (redundant step)
      if (!this.isAirborne && Math.abs(this.floorY - step.floorY) < 20 && step.floorY < GROUND_Y - 10) {
        this.pathIdx++;
        return this.pathIdx >= this.path.length;
      }
      // Source-floor guard: if we've drifted off the floor the pathfinder
      // assumed we'd launch from (e.g. walked off the platform edge while
      // approaching the trigger), the planned jump can't possibly land — its
      // arc was sized for a higher starting elevation. Scrap the path so the
      // next requestPath re-routes from our actual position.
      if (!this.isAirborne && step.sourceFloorY !== undefined &&
          Math.abs(this.floorY - step.sourceFloorY) > 20) {
        this.clearPath();
        return false;
      }
      if (this.isAirborne) return false;  // physics arc in progress

      const triggerX = step.jumpTriggerX ?? step.targetX;
      const dx       = triggerX - this.x;
      if (Math.abs(dx) <= 16) {
        const dir = Math.sign(step.targetX - this.x) || 1;
        this.pendingJumpLog = { startX: this.x, startFloorY: this.floorY, targetX: step.targetX, targetFloorY: step.floorY };
        this.jump(dir, dt);
      } else {
        this.x += Math.sign(dx) * this.moveSpeed * dt;
      }
      return false;
    }

    // ── fall ─────────────────────────────────────────────────────────────────
    if (step.action === 'fall') {
      // Landed at target surface — advance
      if (!this.isAirborne && Math.abs(this.floorY - step.floorY) < 20) {
        this.pathIdx++;
        return this.pathIdx >= this.path.length;
      }
      // While airborne, physics handles the descent
      if (this.isAirborne) return false;
      // Walk toward the fall-off edge
      const dx = step.targetX - this.x;
      if (Math.abs(dx) > 5) this.x += Math.sign(dx) * this.moveSpeed * dt;
      return false;
    }

    return true;
  }

  // ── Attacking behaviour ──────────────────────────────────────────────────────

  private updateAttacking(ctx: UpdateContext) {
    const { dt, allChars, enemyTowerFrontX, enemyTowerY, onFire, navGraph, blocks } = ctx;
    if (this.isAirborne) return;   // don't change horizontal intent mid-air

    const dir         = this.side === 'player' ? 1 : -1;
    const nearest     = this.nearestEnemy(allChars, this.config.attackRange, blocks);
    const distToTower = Math.abs(this.x - enemyTowerFrontX);

    if (nearest !== null) {
      this.state = 'fighting';
      this.attackEnemy(nearest, onFire);

      // Kiting: ranged units back away when a melee enemy closes in
      if (this.isRanged) {
        const dist        = Math.abs(this.x - nearest.x);
        const enemyIsMelee = Character.isMeleeType(nearest.config.type);
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
      // Use pathfinding so the character navigates down from platforms en route.
      this.requestPath(enemyTowerFrontX, GROUND_Y, navGraph, dt);
      this.followPath(dt);
    }
  }

  // ── Rush behaviour ───────────────────────────────────────────────────────────
  // Charge straight to the enemy tower, dodging enemy characters by jumping over
  // them. Fires at any enemy in range while moving — does not stop to engage.

  private updateRushing(ctx: UpdateContext) {
    const { dt, allChars, enemyTowerFrontX, enemyTowerY, onFire, blocks, navGraph } = ctx;
    if (this.isAirborne) return;

    const dir         = this.side === 'player' ? 1 : -1;
    const distToTower = Math.abs(this.x - enemyTowerFrontX);

    if (distToTower <= this.config.attackRange) {
      this.state = 'fighting';
      this.attackTower(enemyTowerFrontX, enemyTowerY, onFire, ctx.onDamageTower);
      return;
    }

    // Opportunistic attack: fire at any enemy in range without stopping movement
    const nearest = this.nearestEnemy(allChars, this.config.attackRange, blocks);
    if (nearest) this.attackEnemy(nearest, onFire);

    // Dodge enemies directly in front by jumping over them.
    const RUSH_DODGE_LOOKAHEAD = 90;
    const RUSH_FLOOR_TOL       = 25;
    const blocker = allChars.find(c =>
      !c.isDead && c.side !== this.side &&
      dir * (c.x - this.x) > 0 &&
      dir * (c.x - this.x) < RUSH_DODGE_LOOKAHEAD &&
      Math.abs(c.floorY - this.floorY) < RUSH_FLOOR_TOL,
    );

    if (blocker && this.config.type !== 'tanker') {
      this.jump(dir, dt);
      this.state = 'marching';
      return;
    }

    this.state = 'marching';
    this.requestPath(enemyTowerFrontX, GROUND_Y, navGraph, dt);
    this.followPath(dt);
  }

  // ── Collecting behaviour ─────────────────────────────────────────────────────

  private updateCollecting(ctx: UpdateContext) {
    const { dt, allChars, coins, homeTowerFrontX, onFire, onDepositCoin, navGraph, blocks } = ctx;

    // Attack any enemy that wanders into range without stopping movement
    if (!this.isAirborne) {
      const nearest = this.nearestEnemy(allChars, this.config.attackRange, blocks);
      if (nearest) this.attackEnemy(nearest, onFire);
    }

    // Evasive jump: 80% chance to leap over a blocking enemy while en route
    // Suppressed on platform — jumping from height would throw the character off
    if (!this.isAirborne && !this.isOnPlatform && this.evasiveJumpTimer <= 0) {
      const dirToTarget = this.carryingCoin
        ? Math.sign(homeTowerFrontX - this.x)
        : this.targetCoin ? Math.sign(this.targetCoin.x - this.x) : 0;
      if (dirToTarget !== 0) {
        const blocking = allChars.find(c =>
          !c.isDead && c.side !== this.side &&
          Math.sign(c.x - this.x) === dirToTarget &&
          Math.abs(c.x - this.x) < 60,
        );
        if (blocking) {
          this.evasiveJumpTimer = 2.0;
          if (Math.random() < 0.80) this.jump(dirToTarget, dt);
        }
      }
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
        return;
      } else if (distToTower > COIN_THROW_MIN_DIST) {
        // Hold coin for COIN_THROW_HOLD_SEC before releasing the 45° throw
        if (this.coinThrowTimer < 0) this.coinThrowTimer = COIN_THROW_HOLD_SEC;
        this.coinThrowTimer -= dt;
        this.state = 'returning';   // stand still while winding up
        if (this.coinThrowTimer > 0) return;
        // Timer expired — release throw, scan nearby for a new coin, fall through
        this.coinThrowTimer = -1;
        this.throwCarriedCoin(homeTowerFrontX);
        this.targetCoin = this.nearestCoin(coins, COIN_THROW_SCAN_RANGE);
        // carryingCoin is now false — fall through to pickup logic
      } else {
        this.coinThrowTimer = -1;  // moved close enough — cancel any pending windup
        this.state = 'returning';
        this.requestPath(homeTowerFrontX, GROUND_Y, navGraph, dt);
        this.followPath(dt);
        return;
      }
    }

    if (this.targetCoin && (this.targetCoin.isDead || this.targetCoin.isPickedUp)) {
      this.targetCoin = null;
    }

    if (!this.targetCoin) {
      // Exclude coins already claimed by an ally collector so teammates spread out
      const claimed = new Set(
        ctx.allChars
          .filter(c => c !== this && c.side === this.side && c.behavior === 'collecting' && c.claimedCoin)
          .map(c => c.claimedCoin!),
      );
      const free = coins.filter(c => !claimed.has(c));
      this.targetCoin = this.coinClosestToTower(free.length > 0 ? free : coins, homeTowerFrontX);
    }

    if (this.targetCoin) {
      // Navigate to the coin's settled floor level (coin.floorY is correct once settled,
      // falls back to GROUND_Y for in-flight coins which is fine — pathfinding adjusts en-route).
      this.requestPath(this.targetCoin.x, this.targetCoin.floorY, navGraph, dt);
      this.followPath(dt);

      this.state = 'collecting';

      if (this.isAirborne) return;   // horizontal position handled by physics

      // ── Pickup check ──────────────────────────────────────────────────────
      const dist    = Math.abs(this.x - this.targetCoin.x);
      const yProx   = Math.abs(this.floorY - this.targetCoin.y);
      // Same surface: settled floorY match OR character is physically close in Y
      const sameSurface  = Math.abs(this.floorY - this.targetCoin.floorY) < 30 || yProx < 40;
      // Reachable: settled on any surface, near ground, or character is close in Y
      const coinReachable = this.targetCoin.isOnGround
        || this.targetCoin.y >= GROUND_Y - 30
        || yProx < 40;

      if (dist <= CHAR_PICKUP_DIST && sameSurface && coinReachable && this.coinPickupCooldown <= 0) {
        this.coinCarryValue = this.targetCoin.value;
        this.coinCarryKind  = this.targetCoin.kind;
        this.targetCoin.pickup();
        this.targetCoin  = null;
        this.carryingCoin = true;
        this.showCoinCarry();
        this.clearPath();
        this.state = 'returning';
      }
    } else {
      // No coins on field — drift toward center drop zone
      this.state = 'marching';
      const center = ctx.worldWidth / 2;
      if (Math.abs(this.x - center) > 40) {
        this.x += Math.sign(center - this.x) * this.moveSpeed * 0.5 * dt;
      }
    }
  }

  // ── Harass behaviour ─────────────────────────────────────────────────────────

  private updateHarass(ctx: UpdateContext) {
    const { dt, allChars, enemyTowerFrontX, homeTowerFrontX, onFire, platforms, blocks, navGraph } = ctx;
    if (this.isAirborne) return;

    const dir   = this.side === 'player' ? 1 : -1;
    const safeX = enemyTowerFrontX - dir * (TOWER_ATTACK_RANGE + HARASS_SAFETY_BUFFER);

    // Retreat is highest priority — back off before doing anything else
    if (dir * (this.x - safeX) > 0) {
      this.state = 'marching';
      this.x -= dir * this.moveSpeed * dt;
      // Still fire at enemies while retreating
      const target = this.nearestEnemy(allChars, this.config.attackRange, blocks);
      if (target) this.attackEnemy(target, onFire);
      return;
    }

    // Attack any enemy in range (no position change)
    const inRange = this.nearestEnemy(allChars, this.config.attackRange, blocks);
    if (inRange) {
      this.state = 'fighting';
      this.attackEnemy(inRange, onFire);

      // Kiting: ranged harass units retreat when a melee enemy closes in
      if (this.isRanged) {
        const isMelee = Character.isMeleeType(inRange.config.type);
        if (isMelee && Math.abs(this.x - inRange.x) < RANGED_KITE_THRESHOLD) {
          const retreatX = this.x - dir * this.moveSpeed * dt;
          this.x = dir > 0 ? Math.max(retreatX, homeTowerFrontX) : Math.min(retreatX, homeTowerFrontX);
          return;
        }
      }
    } else if (this.state === 'fighting') {
      // No valid in-range target this tick — release the fighting lock so the
      // movement branches below can correctly drive 'marching' (and so the
      // animation stops showing 'attack' while the character is walking).
      this.state = 'marching';
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
        // Enemy is ahead and not yet in range — use pathfinding to navigate around blocks.
        // Pass the enemy's floor (not this.floorY): if the character is on a platform and the
        // enemy is on the ground/a different surface, using this.floorY snaps the destination
        // to the current platform's edge and the character can stall there.
        this.requestPath(clamp(closest.x), closest.floorY, navGraph, dt);
        this.followPath(dt);
        if (this.state !== 'fighting') this.state = 'marching';
      } else if (toEnemy <= 0) {
        if (!this.isRanged && closestDist <= this.config.attackRange * 4) {
          // Melee harass: pursue enemy that's behind rather than drifting away
          this.x -= dir * this.moveSpeed * dt;
          if (this.state !== 'fighting') this.state = 'marching';
        } else if (dir * (safeX - this.x) > 5) {
          // Ranged or enemy too far behind — use pathfinding to drift to safe line
          this.requestPath(safeX, this.floorY, navGraph, dt);
          this.followPath(dt);
          if (this.state !== 'fighting') this.state = 'marching';
        }
      }
      // else: enemy is ahead and within attack range — hold position
    } else {
      // No enemies — use pathfinding to group up or rally near own tower
      const mate = this.nearestAlly(allChars);
      const rallyX = mate ? mate.x : homeTowerFrontX + dir * 80;
      const dist   = Math.abs(this.x - rallyX);
      const thresh = mate ? 55 : 20;
      if (dist > thresh) {
        this.requestPath(rallyX, this.floorY, navGraph, dt);
        this.followPath(dt);
        this.state = 'marching';
      }
    }
  }

  // ── Defend behaviour ─────────────────────────────────────────────────────────

  private updateDefending(ctx: UpdateContext) {
    const { dt, allChars, homeTowerFrontX, onFire, blocks, navGraph } = ctx;
    if (this.isAirborne) return;

    const dir = this.side === 'player' ? 1 : -1;

    // Defending area: from the home tower's front face out to the tower's
    // attack range. Any enemy inside this zone is something we should engage.
    const zoneNearX = Math.min(homeTowerFrontX, homeTowerFrontX + dir * TOWER_ATTACK_RANGE);
    const zoneFarX  = Math.max(homeTowerFrontX, homeTowerFrontX + dir * TOWER_ATTACK_RANGE);

    // Find the nearest intruder (any enemy whose x sits inside the defending area).
    let intruder: Character | null = null;
    let minDist = Infinity;
    for (const c of allChars) {
      if (c.isDead || c.side === this.side) continue;
      if (c.x < zoneNearX || c.x > zoneFarX) continue;
      const d = Math.abs(c.x - this.x);
      if (d < minDist) { minDist = d; intruder = c; }
    }

    if (intruder) {
      // Within personal attack range — fire (uses nearestEnemy so LOS / canSnapHit
      // gating still applies; falls through to pursuit if the geometry blocks the shot).
      const target = this.nearestEnemy(allChars, this.config.attackRange, blocks);
      if (target) {
        this.state = 'fighting';
        this.attackEnemy(target, onFire);

        // Ranged: kite back from closing melee, stay within own safe zone
        if (this.isRanged) {
          const isMelee = Character.isMeleeType(target.config.type);
          if (isMelee && Math.abs(this.x - target.x) < RANGED_KITE_THRESHOLD) {
            const retreatX = this.x - dir * this.moveSpeed * dt;
            this.x = dir > 0 ? Math.max(retreatX, homeTowerFrontX) : Math.min(retreatX, homeTowerFrontX);
          }
        }
        return;
      }

      // Intruder is in our zone but not yet in our attack range (or out of LOS).
      // Pursue at the intruder's elevation; clamp so we don't leave the defending
      // area chasing them out of our zone.
      const pursueX = Math.max(zoneNearX, Math.min(zoneFarX, intruder.x));
      this.state = 'marching';
      this.requestPath(pursueX, intruder.floorY, navGraph, dt);
      this.followPath(dt);
      return;
    }

    // No intruders in zone — hold at a rally point just in front of own tower
    // (~30 % into the defending area). Idle/walk hysteresis handles the visuals
    // once we arrive.
    const restX = homeTowerFrontX + dir * TOWER_ATTACK_RANGE * 0.3;
    const delta = restX - this.x;
    if (Math.abs(delta) > 20) {
      this.state = 'marching';
      this.requestPath(restX, this.floorY, navGraph, dt);
      this.followPath(dt);
    } else {
      this.state = 'marching';
    }
  }

  // ── Attack helpers ───────────────────────────────────────────────────────────

  private tickHealParticles(dt: number, healing: boolean) {
    if (healing) {
      this.healParticleTimer -= dt;
      if (this.healParticleTimer <= 0) {
        this.healParticleTimer = 0.28;
        const gfx = new PIXI.Graphics();
        const s   = 3;
        gfx.lineStyle(2, 0x44ff88);
        gfx.moveTo(-s, 0); gfx.lineTo(s, 0);
        gfx.moveTo(0, -s); gfx.lineTo(0, s);
        gfx.x = (Math.random() - 0.5) * this.config.width * 2.5;
        gfx.y = -Math.random() * this.config.height;
        this.container.addChild(gfx);
        this.healParticles.push({ gfx, relY: gfx.y, vy: -(28 + Math.random() * 18), life: 0 });
      }
    } else {
      this.healParticleTimer = 0;
    }

    for (let i = this.healParticles.length - 1; i >= 0; i--) {
      const p = this.healParticles[i];
      p.life += dt;
      p.relY += p.vy * dt;
      p.gfx.y  = p.relY;
      p.gfx.alpha = Math.max(0, 1 - p.life / 0.85);
      if (p.life >= 0.85) {
        this.container.removeChild(p.gfx);
        p.gfx.destroy();
        this.healParticles.splice(i, 1);
      }
    }
  }

  private get moveSpeed() {
    return this.config.speed * (1 + this.rank * PROMO_SPEED_BOOST) * (this.carryingCoin ? CHAR_CARRY_SPEED_MULT : 1) * this.powerUpSpeedMult;
  }

  private get effectiveAtk() {
    return this.config.attackPower * (1 + this.rank * PROMO_ATK_BOOST) * this.powerUpAtkMult;
  }

  applyPowerUp(type: 'heal' | 'speed' | 'attack' | 'promote') {
    if (type === 'heal') {
      this.hp = this.maxHp;
      this.drawBar();
    } else if (type === 'speed') {
      this.powerUpSpeedMult  = POWERUP_SPEED_MULT;
      this.powerUpSpeedTimer = POWERUP_SPEED_DUR_S;
    } else if (type === 'attack') {
      this.powerUpAtkMult = POWERUP_ATK_MULT;
    } else {
      // Promote: advance one rank, restore HP, play the promotion animation
      if (this.rank < 3) {
        this.ap   = PROMO_THRESHOLDS[this.rank];  // jump AP to current threshold so earnAP triggers correctly
        this.rank = (this.rank + 1) as 0 | 1 | 2 | 3;
        this.hp   = this.maxHp;
        this.pendingPromotion = true;
        this.drawRankBadge();
        this.drawBar();
        this.startPromoAnim();
      }
    }
  }

  private get projectileKind(): 'arrow' | 'bullet' | 'grenade' | 'rocket' {
    const t = this.config.type;
    if (t === 'grenadier') return 'grenade';
    if (t === 'rocketeer') return 'rocket';
    if (t === 'rifleman' || t === 'sniper' || t === 'tanker') return 'bullet';
    return 'arrow';
  }

  /**
   * Forces the firing direction to horizontal — ranged units shoot sideways only,
   * no diagonal or vertical arcs. The projectile travels the original distance
   * so splash damage still lands at the intended horizontal position. Targets
   * at meaningfully different elevations are filtered out earlier by canSnapHit,
   * so ranged units close the elevation gap (via Pathfinding climb-up logic in
   * harass/collect behaviors) before they can fire.
   */
  private snapFireAngle(sx: number, sy: number, tx: number, ty: number): { tx: number; ty: number } {
    const dx   = tx - sx;
    const dy   = ty - sy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return { tx, ty };

    // Preserve the horizontal firing direction; never shoot backwards.
    const dir = dx !== 0 ? Math.sign(dx) : (this.side === 'player' ? 1 : -1);
    return { tx: sx + dist * dir, ty: sy };
  }

  private attackEnemy(target: Character, onFire?: (r: FireRequest) => void) {
    if (this.attackTimer > 0) return;
    const dirSign = Math.sign(target.x - this.x);
    if (dirSign !== 0) this.lastAttackDir = dirSign as 1 | -1;
    this.attackFacingTimer = 0.3;
    const miss   = Math.random() < this.config.critical;
    const damage = miss ? 0 : this.effectiveAtk;
    if (this.config.type === 'conscript' || this.config.type === 'warrior' || this.config.type === 'heavy') {
      target.takeDamage(damage, miss ? undefined : this);
    } else if (onFire) {
      if (this.config.type === 'grenadier') {
        // Lead targeting: predict where the target will be when the grenade arrives.
        // vxAbs mirrors the formula in Grenade.ts; two iterations refine the estimate.
        const leadTime = (dx: number) => {
          const vxAbs = Math.max(GRENADE_MAX_VX * 0.45, Math.min(Math.abs(dx) * 0.55, GRENADE_MAX_VX));
          return Math.abs(dx) / vxAbs;
        };
        const dx0  = target.x - this.x;
        const tx0  = target.x + target.approxVx * leadTime(dx0);
        const tx   = target.x + target.approxVx * leadTime(tx0 - this.x);
        onFire({
          side: this.side, sx: this.x, sy: this.bowY,
          tx,              ty: target.bowY,
          damage, projectileKind: 'grenade',
          shooter: miss ? undefined : this,
        });
      } else if (this.config.type === 'rocketeer') {
        // Rockets compute their own arc from tx; fire directly at current position
        onFire({
          side: this.side, sx: this.x, sy: this.bowY,
          tx: target.x,   ty: target.bowY,
          damage, projectileKind: 'rocket',
          shooter: miss ? undefined : this,
        });
      } else {
        const snapped = this.snapFireAngle(this.x, this.bowY, target.x, target.bowY);
        onFire({
          side: this.side, sx: this.x, sy: this.bowY,
          tx: snapped.tx,  ty: snapped.ty,
          damage, projectileKind: this.projectileKind,
          shooter: miss ? undefined : this,
        });
      }
    }
    this.attackTimer = this.config.fireRate;
  }

  private attackTower(
    towerFrontX: number, towerY: number,
    onFire?: (r: FireRequest) => void,
    onDamageTower?: (dmg: number) => void,
  ) {
    if (this.attackTimer > 0) return;
    const dirSign = Math.sign(towerFrontX - this.x);
    if (dirSign !== 0) this.lastAttackDir = dirSign as 1 | -1;
    this.attackFacingTimer = 0.3;
    this.attackTimer = this.config.fireRate;
    if (Math.random() < this.config.critical) return;  // miss — silent, towers have no label system
    if (this.config.type === 'warrior' || this.config.type === 'heavy') {
      onDamageTower?.(this.effectiveAtk);
    } else if (onFire) {
      if (this.config.type === 'grenadier') {
        onFire({
          side: this.side, sx: this.x, sy: this.bowY,
          tx: towerFrontX, ty: towerY,
          damage: this.effectiveAtk, projectileKind: 'grenade',
        });
      } else if (this.config.type === 'rocketeer') {
        onFire({
          side: this.side, sx: this.x, sy: this.bowY,
          tx: towerFrontX, ty: towerY,
          damage: this.effectiveAtk, projectileKind: 'rocket',
        });
      } else {
        const snapped = this.snapFireAngle(this.x, this.bowY, towerFrontX, towerY);
        onFire({
          side: this.side, sx: this.x, sy: this.bowY,
          tx: snapped.tx,  ty: snapped.ty,
          damage: this.effectiveAtk, projectileKind: this.projectileKind,
        });
      }
    }
  }

  private hasLineOfSight(tx: number, ty: number, blocks: BlockData[]): boolean {
    const sy = this.bowY;
    for (const b of blocks) {
      // Skip: shooter is standing on top of this block
      if (this.bowY >= b.y && this.x >= b.x && this.x <= b.x + b.width) continue;
      if (segmentIntersectsAABB(this.x, sy, tx, ty, b)) return false;
    }
    return true;
  }

  /**
   * For snap-firing types, returns true if the snapped landing X lands within the
   * projectile's splash radius of the target. Non-snap types (melee, grenade, rocket)
   * always return true — they aim freely.
   */
  private canSnapHit(target: Character): boolean {
    const t = this.config.type;
    if (t === 'conscript' || t === 'warrior' || t === 'heavy' || t === 'grenadier' || t === 'rocketeer') return true;
    // Horizontal-only fire — the projectile travels along the shooter's bowY
    // without arcing. A target is hittable only when its collision box
    // vertically spans the bow line (i.e. they're on roughly the same plane).
    return this.bowY >= target.y - target.collisionHeight && this.bowY <= target.y;
  }

  /**
   * Returns the nearest living enemy within `range` px.
   * Ranged characters additionally require an unobstructed line of sight through blocks.
   * Snap-firing types also require the snapped angle to actually land on the target —
   * otherwise the bullet would deterministically miss every shot.
   * Enemies more than 30 px below the shooter are excluded — projectiles cannot arc
   * downward and melee cannot swing through a platform floor.
   */
  private nearestEnemy(chars: Character[], range: number, blocks: BlockData[] = []): Character | null {
    let best: Character | null = null;
    let minDistSq = Infinity;
    const rangeSq = range * range;
    for (const t of chars) {
      if (t.isDead || t.side === this.side) continue;
      // Skip enemies that are meaningfully below — projectiles cannot fire downward,
      // and melee cannot swing through the floor of a platform.
      if (t.y > this.y + 30) continue;
      const dx = this.x - t.x;
      const dy = this.y - t.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= rangeSq && distSq < minDistSq) {
        if (blocks.length > 0 && this.isRanged && !this.hasLineOfSight(t.x, t.bowY, blocks)) continue;
        if (!this.canSnapHit(t)) continue;
        minDistSq = distSq;
        best = t;
      }
    }
    return best;
  }

  private nearestAlly(chars: Character[]): Character | null {
    let best: Character | null = null;
    let minDist = Infinity;
    for (const c of chars) {
      if (c === this || c.isDead || c.side !== this.side) continue;
      const dist = Math.abs(this.x - c.x);
      if (dist < minDist) { minDist = dist; best = c; }
    }
    return best;
  }

  /** Nearest coin to this character, optionally filtered to within `maxRange` px. */
  private nearestCoin(coins: Coin[], maxRange = Infinity): Coin | null {
    let best: Coin | null = null;
    let minDist = Infinity;
    for (const c of coins) {
      if (c.isDead || c.isPickedUp) continue;
      const dist = Math.abs(this.x - c.x);
      if (dist <= maxRange && dist < minDist) { minDist = dist; best = c; }
    }
    return best;
  }

  /** Coin closest to own tower front — prioritises easy-to-deposit coins. */
  private coinClosestToTower(coins: Coin[], homeTowerFrontX: number): Coin | null {
    let best: Coin | null = null;
    let minDistToTower = Infinity;
    for (const c of coins) {
      if (c.isDead || c.isPickedUp) continue;
      const distToTower = Math.abs(c.x - homeTowerFrontX);
      if (distToTower < minDistToTower) { minDistToTower = distToTower; best = c; }
    }
    return best;
  }

  destroy() {
    this.removeCoinCarry();
    this.physics.removeBody(this.body);
    this.container.destroy({ children: true });
  }
}
