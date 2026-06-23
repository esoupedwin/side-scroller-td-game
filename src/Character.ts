import * as PIXI from 'pixi.js';
import Matter from 'matter-js';
import {
  GROUND_Y, PLAYER_COLOR, ENEMY_COLOR,
  JUMP_VELOCITY,
  CHAR_PICKUP_DIST, CHAR_DEPOSIT_DIST, CHAR_CARRY_SPEED_MULT, CHAR_COIN_RECOVERY_COOLDOWN,
  CHAR_HP_BAR_W, CHAR_HP_BAR_H,
  SAFE_ZONE_HEAL_RATE, HIT_JUMP_CHANCE,
  ATTACK_KNOCKBACK_VY,
  TOWER_ATTACK_RANGE, HARASS_SAFETY_BUFFER, DEFEND_PURSUIT_RANGE, RANGED_KITE_THRESHOLD,
  COIN_THROW_VX, COIN_THROW_VY, COIN_THROW_SCAN_RANGE, COIN_THROW_HOLD_SEC, COIN_THROW_MIN_DIST, COIN_THROW_MAX_Y_GAP,
  PROMO_KILL_AP, PROMO_COIN_AP, PROMO_THRESHOLDS,
  PROMO_HP_BOOST, PROMO_SPEED_BOOST, PROMO_ATK_BOOST,
  POWERUP_SPEED_MULT, POWERUP_SPEED_DUR_S, POWERUP_ATK_MULT,
  GRENADE_MAX_VX,
} from './constants';
import type { Physics } from './Physics';
import { NavGraph, type PathStep } from './Pathfinding';
import {
  type LoadedSpriteSet, type BodyAnimName, type LegsAnimName,
  getBodyAnimFps, getBodySpriteScale, getBodyFeetAnchorY,
  getLegsAnimFps, getLegsSpriteScale, getLegsFeetAnchorY,
} from './SpriteRegistry';
import { type Tribe, tribeForSide } from './Tribes';
import { spawnSlashArc, spawnHitSpark, spawnMuzzleGlow, spawnSpeedStreak, spawnAfterImage, type AfterImagePart } from './Vfx';

export const RANK_NAMES = ['Private', 'Corporal', 'Sergeant', 'Captain'] as const;

/** Icon shown next to the character's name in-world, reflecting current behavior. */
const BEHAVIOR_ICON: Record<'attacking' | 'collecting' | 'harass' | 'defend' | 'rush', string> = {
  attacking:  '⚔',
  collecting: '💰',
  harass:     '🎯',
  defend:     '🛡',
  rush:       '⚡',
};

// Physics collision box is taller than the visual character so projectiles and
// stacking interactions register reliably even when sprite art is small. Visual
// sizing (sprite scale, HP bar, label) continues to use config.height.
const BODY_HEIGHT_MULT = 1.9;

// Liang-Barsky segment-AABB intersection test.
// Returns true if the segment (x0,y0)â†'(x1,y1) intersects the rectangle.
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
  type:        'conscript' | 'warrior' | 'archer' | 'rifleman' | 'sniper' | 'viking' | 'knight' | 'heavy' | 'tanker' | 'grenadier' | 'rocketeer' | 'shocktrooper';
  hp:          number;
  speed:       number;
  attackRange: number;
  attackPower: number;
  fireRate:    number;
  critical:    number;   // miss probability [0, 1] â€” roll each attack
  width:       number;
  height:      number;
  knockback:   number;   // px/s horizontal impulse applied to the victim on a successful hit (melee or ranged)
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
  /** Living characters on the OPPOSITE side from the one being updated. */
  enemies:           Character[];
  /** Living characters on the SAME side (still includes self â€” callers must skip `c === this`). */
  allies:            Character[];
  enemyTowerFrontX:      number;
  enemyTowerY:           number;
  /** Floor Y of the surface the enemy tower sits on (may differ from this.groundY on maps with an elevated tower block). */
  enemyTowerBaseFloorY:  number;
  homeTowerFrontX:       number;   // the collecting character's own tower
  /** Floor Y of the surface the home tower sits on. Used by collecting units so coin carry pathing
   *  lands them on the tower's actual surface â€” not this.groundY, which would route them under an
   *  elevated tower instead of onto it. */
  homeTowerBaseFloorY:   number;
  worldWidth:        number;
  coins:             Coin[];
  platforms:         PlatformData[];
  blocks:            BlockData[];
  navGraph:          NavGraph;
  onFire?:           (req: FireRequest) => void;
  onDamageTower?:    (dmg: number) => void;
  onDepositCoin:     (value: number) => void;
  onMeleeHit?:       (unitType: string, x: number) => void;
  /** Precomputed `Math.exp(-ATTACK_KNOCKBACK_DECAY * dt)` shared by every
   *  melee-swing and shotgun-blast hit landed this tick. Identical for every
   *  character in the same tick — caller computes once per frame to avoid
   *  one `Math.exp` per hit. Mirrors the documented grenade pattern. */
  attackKnockbackDecay: number;
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
  private floorY:    number;
  private readonly groundY: number;
  // When non-null, syncFromBody ignores the platform at this y while resolving
  // landing â€” used for "drop in place" through the platform the character is
  // currently standing on. Cleared automatically on any landing.
  private dropFromY:   number | null = null;
  // World bounds between tower faces â€” set each tick from UpdateContext, used in syncToBody.
  private boundL     = 0;
  private boundR     = 0;
  get isOnPlatform(): boolean { return this.floorY < this.groundY; }
  /** Actual height of the physics collision body (taller than config.height by BODY_HEIGHT_MULT). */
  get collisionHeight(): number { return this.config.height * BODY_HEIGHT_MULT; }
  /** Visual/identity tribe (derived from side; future: pickable per game). */
  get tribe(): Tribe { return tribeForSide(this.side); }
  private get isKnockedBack(): boolean { return Math.abs(this.knockbackVx) > 20; }

  /** Damage events emitted this tick; Game.ts reads and clears each frame. */
  readonly pendingDamages: { amount: number; x: number; y: number }[] = [];
  /** Set when the character drops or throws a carried coin; Game.ts spawns the coin.
   *  vx/vy present â†' deliberate throw (directed velocity, no recovery chase). */
  pendingCoinDrop: { x: number; y: number; value: number; kind: CoinKind; vx?: number; vy?: number } | null = null;

  rank:              0 | 1 | 2 | 3 = 0;
  pendingPromotion = false;
  killedBy: 'character' | 'tower' | null = null;
  private ap            = 0;
  get currentAP(): number { return this.ap; }
  private rankGfx!:     PIXI.Graphics;
  private idLabel!:     PIXI.Text;
  private promoAnimGfx: PIXI.Graphics | null = null;
  private promoAnimTimer = -1;

  private attackTimer        = 0;
  private randomJumpTimer    = Math.random() * 3;  // stagger across characters
  private evasiveJumpTimer   = 0;
  private lastMoveDir:         1 | -1 = 1;
  // Direction of the most recent attack target â€” used to flip the sprite while
  // attacking, so a character moving forward but attacking a target behind
  // them faces the target (not their travel direction).
  private lastAttackDir:       1 | -1 = 1;
  private throwFacingDir:      1 | -1 = 1;
  // Seconds remaining where the sprite stays facing the most recent attack
  // direction, even when state isn't 'fighting' (Rush/Collect fire while
  // moving without flipping into fighting state). Doubles as the body-attack
  // hold: while > 0, selectAnimations forces body to 'attack' so the swing
  // anim plays to completion before switching to walk/idle/carry.
  private attackFacingTimer    = 0;
  // Pending melee swing â€” for conscript/warrior/heavy, damage is deferred
  // until partway through the body attack animation so the swing visually
  // connects before the hit lands. Re-validated at land time (skip if a
  // character target died, moved out of reach, etc.).
  private pendingMeleeSwing: {
    target:   Character | null;        // null = tower hit
    damage:   number;
    delay:    number;
    onTower?: (dmg: number) => void;
  } | null = null;
  // Shotgun blast (shock trooper): resolved against ALL enemies in a short frontal
  // cone when the wind-up lands. Visual-only timing mirrors the melee swing.
  private pendingBlast: { damage: number; delay: number; dir: 1 | -1 } | null = null;
  // Seconds since the character's x last changed. Used by selectAnimations to
  // fall back to 'idle' when the state machine still says 'marching' but the
  // character is effectively stationary (blocked, no target, etc.).
  private stillTimer            = 0;
  // Seconds of continuous motion (resets when x stops changing). Pairs with
  // stillTimer to give asymmetric hysteresis on the idleâ†”walk animation
  // switch, so jittery 1-px-per-tick movement doesn't thrash the sprite.
  private movingTimer           = 0;
  private legL:     PIXI.Container | null = null;
  private legR:     PIXI.Container | null = null;
  private legPhase: number = Math.random() * Math.PI * 2;  // stagger across characters
  private spriteSet:        LoadedSpriteSet | null = null;
  private bodySprite:       PIXI.AnimatedSprite | null = null;
  private legsSprite:       PIXI.AnimatedSprite | null = null;
  private bodyBaseScale     = 1;
  private legsBaseScale     = 1;
  // Last facing direction applied to sprite.scale.x. 0 = uninitialised, forces
  // the first apply. Used by tickAnimSprite to skip the per-tick scale write
  // (which dirties PIXI's _transformID) when neither facing nor base scale
  // changed this frame.
  private lastAppliedFacingDir: 0 | 1 | -1 = 0;
  private currentBodyAnim:  BodyAnimName | null = null;
  private currentLegsAnim:  LegsAnimName | null = null;
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
  // â”€â”€ Defend behaviour state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The intruder this defender is currently pursuing in the attack zone, if
  // any. Other defenders read this via `claimedIntruder` so two units never
  // converge on the same target â€” leaving them to spread out and cover the
  // tower against multiple threats.
  private defendTargetIntruder: Character | null = null;
  // Each defender returns to a different randomly-picked spot inside the
  // defence zone after a pursuit so units don't all stack on the same x.
  // null = "pick a new one on next rally"; reset to null whenever the
  // defender finishes pursuing (returns from intruder branch).
  private defendRallyX: number | null = null;
  // True last tick we were actively pursuing an intruder. Used to detect the
  // pursuitâ†'rally transition and refresh defendRallyX exactly once per cycle.
  private defendWasPursuing = false;

  // â”€â”€ Pathfinding state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  private path:        PathStep[] = [];
  private pathIdx      = 0;
  // Quantised target of the last path request — avoids rebuilding the path every
  // tick. Stored as two numbers (not a template-literal key string) so the cache
  // check is a pair of cheap eq compares instead of per-tick string allocation.
  // NaN is the "no cached target" sentinel (NaN !== NaN forces a rebuild).
  private pathTargetQx = NaN;
  private pathTargetQy = NaN;
  // Seconds since path was built; stale paths are discarded and rebuilt.
  private pathAge      = 0;
  private readonly PATH_TTL = 8;   // s â€” re-plan after this many seconds
  // NavGraph version when the current path was built. If the graph has been
  // rebuilt since (e.g. an animated block moved surfaces around), the cached
  // path is invalidated even if its target key hasn't changed.
  private pathNavVersion = -1;
  // Diagnostic counters (lifetime).
  clampedCount      = 0;
  pathRebuildCount  = 0;
  // Pending jump intent â€” populated when followPath fires this.jump(), consumed on landing.
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
  private lastDrawnHpRatio  = -1;
  private lastLocoMoveSpeed = -1;

  // Power-up effects
  private powerUpSpeedMult   = 1.0;
  private powerUpSpeedTimer  = 0;
  private powerUpAtkMult     = 1.0;
  private speedStreakTimer   = 0;
  private afterImageTimer    = 0;

  constructor(side: Side, startX: number, startY: number, config: CharacterConfig, id: number, name: string, physics: Physics, spriteSet?: LoadedSpriteSet | null, groundY: number = GROUND_Y) {
    this.groundY   = groundY;
    this.floorY    = groundY;
    this.side      = side;
    this.id        = id;
    this.name      = name;
    this.config    = { ...config };
    this.hp        = config.hp;
    this.x         = startX;
    this.y         = startY;
    this.physics   = physics;
    this.spriteSet = spriteSet ?? null;
    this.body      = physics.createCharBody(startX, startY, config.width, config.height * BODY_HEIGHT_MULT);
    // If spawned above ground (e.g. on top of an elevated tower) mark as airborne
    // so syncFromBody triggers a proper fall-and-land sequence instead of treating
    // the character as already grounded at an inconsistent position.
    if (startY < this.groundY) this.isAirborne = true;

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

    this.idLabel = new PIXI.Text(this.labelText(), {
      fontSize:        12,
      fontWeight:      'bold',
      fill:            0xffffff,
      stroke:          0x000000,
      strokeThickness: 2,
    });
    this.idLabel.anchor.set(0.5, 1);
    this.idLabel.x = 0;
    this.idLabel.y = this.hpBarOffsetY() - 2;
    this.container.addChild(this.idLabel);

    this.syncPosition();
  }

  // â”€â”€ Diagnostic introspection (read-only snapshot of internal state) â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€ Behavior toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  get behavior(): 'attacking' | 'collecting' | 'harass' | 'defend' | 'rush' { return this._behavior; }

  set behavior(val: 'attacking' | 'collecting' | 'harass' | 'defend' | 'rush') {
    if (val === this._behavior) return;
    if (this._behavior === 'collecting') {
      this.targetCoin = null;
      if (this.carryingCoin) this.dropCarriedCoin();
    }
    if (this._behavior === 'defend') {
      // Leaving defend â€” release any pursuit claim and rally cache so a future
      // defender doesn't see stale state.
      this.defendTargetIntruder = null;
      this.defendRallyX         = null;
      this.defendWasPursuing    = false;
    }
    this._behavior = val;
    this.refreshLabel();
  }

  /** Intruder this defender is currently pursuing, if any. Allies use this to
   *  avoid double-targeting the same enemy in updateDefending. */
  get claimedIntruder(): Character | null { return this.defendTargetIntruder; }

  /** "<behavior-icon> <name>", shown above the HP bar. */
  private labelText(): string {
    return `${BEHAVIOR_ICON[this._behavior]} ${this.name}`;
  }

  private refreshLabel(): void {
    if (this.idLabel) this.idLabel.text = this.labelText();
  }

  // â”€â”€ Sprite builders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private buildSprite() {
    if (this.spriteSet) { this.buildAnimSprite(); return; }
    if      (this.config.type === 'conscript')  this.buildConscriptSprite();
    else if (this.config.type === 'archer')     this.buildArcherSprite();
    else if (this.config.type === 'rifleman')   this.buildRiflemanSprite();
    else if (this.config.type === 'sniper')     this.buildSniperSprite();
    else if (this.config.type === 'viking')     this.buildVikingSprite();
    else if (this.config.type === 'knight')     this.buildKnightSprite();
    else if (this.config.type === 'heavy')      this.buildHeavySprite();
    else if (this.config.type === 'tanker')     this.buildTankerSprite();
    else if (this.config.type === 'grenadier')  this.buildGrenadierSprite();
    else if (this.config.type === 'rocketeer')  this.buildRocketeerSprite();
    else if (this.config.type === 'shocktrooper') this.buildShockTrooperSprite();
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

  /** Render scale that makes a frame `frameH` tall display at `config.height Ã— spriteScale` on screen. */
  private animScaleFor(layer: 'body' | 'legs', animName: BodyAnimName | LegsAnimName, frameH: number): number {
    const scale = layer === 'body'
      ? getBodySpriteScale(this.tribe, this.config.type, animName as BodyAnimName)
      : getLegsSpriteScale(this.tribe, this.config.type, animName as LegsAnimName);
    return scale * this.config.height / frameH;
  }

  private buildAnimSprite() {
    const set = this.spriteSet!;
    // Pick a starting frame set for each layer â€” prefer walk, fall back as needed.
    const startBodyName: BodyAnimName | null =
      set.body.walk   ? 'walk'   :
      set.body.idle   ? 'idle'   :
      set.body.attack ? 'attack' :
      set.body.carry  ? 'carry'  : null;
    const startLegsName: LegsAnimName | null =
      set.legs.walk ? 'walk' :
      set.legs.idle ? 'idle' : null;

    if (!startBodyName || !startLegsName) return;
    const bodyFrames = set.body[startBodyName]!;
    const legsFrames = set.legs[startLegsName]!;

    // Legs first so they render BEHIND the body.
    const legs = new PIXI.AnimatedSprite(legsFrames);
    legs.anchor.set(0.5, getLegsFeetAnchorY(this.tribe, this.config.type, startLegsName));
    legs.y = this.config.height;
    this.legsBaseScale = this.animScaleFor('legs', startLegsName, legsFrames[0].height);
    legs.scale.set(this.legsBaseScale);
    legs.animationSpeed = getLegsAnimFps(this.tribe, this.config.type, startLegsName) / 60;
    legs.loop = true;
    legs.play();
    this.legsSprite      = legs;
    this.currentLegsAnim = startLegsName;
    this.container.addChild(legs);

    const body = new PIXI.AnimatedSprite(bodyFrames);
    body.anchor.set(0.5, getBodyFeetAnchorY(this.tribe, this.config.type, startBodyName));
    body.y = this.config.height;
    this.bodyBaseScale = this.animScaleFor('body', startBodyName, bodyFrames[0].height);
    body.scale.set(this.bodyBaseScale);
    body.animationSpeed = getBodyAnimFps(this.tribe, this.config.type, startBodyName) / 60;
    body.loop = true;
    body.play();
    this.bodySprite      = body;
    this.currentBodyAnim = startBodyName;
    this.container.addChild(body);
  }

  /**
   * Choose the target {body, legs} anim from the current state.
   * Legs follow the walk/idle hysteresis. Body lights up `attack` whenever
   * the character fired recently (even if not in fighting state, e.g. Rush
   * units firing while marching).
   */
  private selectAnimations(): { body: BodyAnimName; legs: LegsAnimName } {
    // Asymmetric hysteresis on idleâ†”walk so single-tick movement noise doesn't
    // thrash the animation:
    //   - already in walk   â†' keep moving unless still for > 0.15 s
    //   - already in idle   â†' only switch to walk after 0.05 s of motion
    const wasMoving = this.currentLegsAnim === 'walk';
    const inMotion  = wasMoving ? this.stillTimer < 0.15 : this.movingTimer > 0.05;
    const legs: LegsAnimName = inMotion ? 'walk' : 'idle';

    const recentlyFired = this.state === 'fighting' || this.attackFacingTimer > 0;
    let body: BodyAnimName;
    if (recentlyFired)                                              body = 'attack';
    else if (this.coinThrowTimer > 0)                               body = 'throw';
    else if (this.carryingCoin || this.state === 'returning')       body = 'carry';
    else if (this.state === 'marching' || this.state === 'collecting')
      body = inMotion ? 'walk' : 'idle';
    else                                                            body = 'idle';

    return { body, legs };
  }

  private switchBodyAnimation(name: BodyAnimName) {
    const sprite = this.bodySprite;
    const set    = this.spriteSet?.body;
    if (!sprite || !set) return;

    const fallback: Record<BodyAnimName, BodyAnimName[]> = {
      idle:   ['idle',   'walk'],
      walk:   ['walk',   'idle'],
      attack: ['attack', 'idle',   'walk'],
      carry:  ['carry',  'walk',   'idle'],
      throw:  ['throw',  'carry',  'walk',  'idle'],
    };
    let frames: PIXI.Texture[] | undefined;
    let picked: BodyAnimName = name;
    for (const n of fallback[name]) {
      if (set[n]) { frames = set[n]; picked = n; break; }
    }
    if (!frames) return;

    sprite.textures       = frames;
    sprite.anchor.set(0.5, getBodyFeetAnchorY(this.tribe, this.config.type, picked));
    sprite.animationSpeed = getBodyAnimFps(this.tribe, this.config.type, picked) / 60;
    this.bodyBaseScale    = this.animScaleFor('body', picked, frames[0].height);
    sprite.play();
    this.currentBodyAnim = name;
  }

  private switchLegsAnimation(name: LegsAnimName) {
    const sprite = this.legsSprite;
    const set    = this.spriteSet?.legs;
    if (!sprite || !set) return;

    const fallback: Record<LegsAnimName, LegsAnimName[]> = {
      idle: ['idle', 'walk'],
      walk: ['walk', 'idle'],
    };
    let frames: PIXI.Texture[] | undefined;
    let picked: LegsAnimName = name;
    for (const n of fallback[name]) {
      if (set[n]) { frames = set[n]; picked = n; break; }
    }
    if (!frames) return;

    sprite.textures       = frames;
    sprite.anchor.set(0.5, getLegsFeetAnchorY(this.tribe, this.config.type, picked));
    sprite.animationSpeed = getLegsAnimFps(this.tribe, this.config.type, picked) / 60;
    this.legsBaseScale    = this.animScaleFor('legs', picked, frames[0].height);
    sprite.play();
    this.currentLegsAnim = name;
  }

  private tickAnimSprite() {
    const body = this.bodySprite;
    const legs = this.legsSprite;
    if (!body || !legs) return;

    // Switch anims FIRST so the base scale is current before we apply scale.x.
    // Previously the order was reversed and the new base-scale was visible only
    // on the *next* tick.
    const target = this.selectAnimations();
    const bodyChanged = target.body !== this.currentBodyAnim;
    const legsChanged = target.legs !== this.currentLegsAnim;
    if (bodyChanged) this.switchBodyAnimation(target.body);
    if (legsChanged) this.switchLegsAnimation(target.legs);

    // Face the attack target while fighting OR within the brief post-fire window
    // (Rush/Collect fire opportunistically without entering fighting state).
    // Otherwise face the actual travel direction. Sprites are drawn facing right.
    const facingDir = (this.state === 'fighting' || this.attackFacingTimer > 0)
      ? this.lastAttackDir
      : this.coinThrowTimer > 0
        ? this.throwFacingDir
        : this.lastMoveDir;
    // Skip the scale.x writes when nothing relevant changed — `scale.x = …` on
    // a PIXI.Sprite dirties _transformID even when assigning the same value,
    // costing one transform recalc per character per frame.
    const facingChanged = facingDir !== this.lastAppliedFacingDir;
    if (bodyChanged || facingChanged) body.scale.x = this.bodyBaseScale * facingDir;
    if (legsChanged || facingChanged) legs.scale.x = this.legsBaseScale * facingDir;
    this.lastAppliedFacingDir = facingDir;

    this.updateLocomotionFps();
  }

  /**
   * Scale the locomotion animation speed by the character's current effective
   * moveSpeed vs its config baseline, so promotions, carry slowdown, and speed
   * power-ups keep the stride visually in sync with the actual pace.
   * Idle and attack are stationary â€” left at their baseline fps.
   */
  private updateLocomotionFps() {
    const ms = this.moveSpeed;
    if (ms === this.lastLocoMoveSpeed) return;
    this.lastLocoMoveSpeed = ms;
    const ratio = ms / this.config.speed;

    const legs = this.legsSprite;
    const legsName = this.currentLegsAnim;
    if (legs && legsName === 'walk') {
      const target = (getLegsAnimFps(this.tribe, this.config.type, legsName) * ratio) / 60;
      if (Math.abs(legs.animationSpeed - target) > 1e-4) legs.animationSpeed = target;
    }

    const body = this.bodySprite;
    const bodyName = this.currentBodyAnim;
    if (body && bodyName && (bodyName === 'walk' || bodyName === 'carry')) {
      const target = (getBodyAnimFps(this.tribe, this.config.type, bodyName) * ratio) / 60;
      if (Math.abs(body.animationSpeed - target) > 1e-4) body.animationSpeed = target;
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
    // Barrel (14â†'26 px; sniper is 16â†'38)
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

  private buildShockTrooperSprite() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.31, w * 0.31, w * 0.38, h * 0.45, 0.5);

    const g = new PIXI.Graphics();
    // Heavy tactical torso
    g.beginFill(color, 0.92);
    g.drawRoundedRect(-w * 0.50, h * 0.16, w * 1.0, h * 0.46, 3);
    g.endFill();
    // Diagonal bandolier of shells
    g.lineStyle(2, 0x222222, 0.5);
    g.moveTo(-w * 0.40, h * 0.20); g.lineTo(w * 0.40, h * 0.55);
    g.lineStyle(0);

    // Head
    g.beginFill(color, 0.85);
    g.drawCircle(0, h * 0.1, w * 0.36);
    g.endFill();
    // Wide combat helmet
    g.beginFill(color);
    g.drawRoundedRect(-w * 0.44, h * 0.02 - 9, w * 0.88, 11, 3);
    g.endFill();

    // Pump-action shotgun: short stock + short fat barrel + pump grip
    const ry = h * 0.32;
    const stockL = Math.min(-dir * 12, -dir * 2);
    const stockW = Math.abs(-dir * 12 - (-dir * 2));
    g.beginFill(0x4a3219);
    g.drawRoundedRect(stockL, ry, stockW, 8, 2);   // wooden stock
    g.endFill();
    const recvL = Math.min(-dir * 2, dir * 10);
    const recvW = Math.abs(-dir * 2 - dir * 10);
    g.beginFill(0x303030);
    g.drawRect(recvL, ry - 1, recvW, 8);           // chunky receiver
    g.endFill();
    const barlL = Math.min(dir * 10, dir * 22);
    const barlW = Math.abs(dir * 10 - dir * 22);
    g.beginFill(0x1f1f1f);
    g.drawRect(barlL, ry - 1, barlW, 7);           // short fat barrel
    g.endFill();
    g.beginFill(0x4a3219);
    g.drawRoundedRect(dir > 0 ? dir * 12 : dir * 12 - 6, ry + 7, 6, 4, 1); // pump grip
    g.endFill();
    // Twin muzzle holes
    g.beginFill(0x000000);
    g.drawCircle(dir * 23, ry + 0.5, 1.6);
    g.drawCircle(dir * 23, ry + 4.5, 1.6);
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

  private buildVikingSprite() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.30, w * 0.30, w * 0.38, h * 0.45, 0.65);

    const g = new PIXI.Graphics();

    // â”€â”€ Shield (non-weapon side â€” left for player) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const sX = -dir * w * 0.52;
    const sW =  w  * 0.52;
    const sH =  h  * 0.55;
    const sY =  h  * 0.13;
    g.beginFill(color, 0.85);
    g.drawRoundedRect(sX - sW * 0.5, sY, sW, sH, 7);
    g.endFill();
    g.lineStyle(2, 0xffd166, 0.55);
    g.drawRoundedRect(sX - sW * 0.5, sY, sW, sH, 7);
    g.lineStyle(0);
    g.beginFill(0xffd166, 0.75);
    g.drawCircle(sX, sY + sH * 0.46, sW * 0.17);
    g.endFill();

    // â”€â”€ Torso â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    g.beginFill(color);
    g.drawRoundedRect(-w * 0.46, h * 0.19, w * 0.92, h * 0.42, 5);
    g.endFill();
    // Fur collar
    g.beginFill(0xdddddd, 0.22);
    g.drawRoundedRect(-w * 0.46, h * 0.19, w * 0.92, h * 0.10, 5);
    g.endFill();
    // Belt
    g.beginFill(0x5a3010, 0.45);
    g.drawRect(-w * 0.46, h * 0.54, w * 0.92, 4);
    g.endFill();

    // â”€â”€ Head â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    g.beginFill(color, 0.9);
    g.drawCircle(0, h * 0.10, w * 0.40);
    g.endFill();
    // Helmet cap
    g.beginFill(color);
    g.drawRoundedRect(-w * 0.35, h * 0.02 - 7, w * 0.70, 9, 3);
    g.endFill();
    // Horns
    g.beginFill(0xeeeecc, 0.85);
    g.drawPolygon([-w * 0.35, h * 0.02 - 2, -w * 0.52, h * 0.02 - 15, -w * 0.26, h * 0.02]);
    g.drawPolygon([ w * 0.35, h * 0.02 - 2,  w * 0.52, h * 0.02 - 15,  w * 0.26, h * 0.02]);
    g.endFill();
    // Nose guard
    g.beginFill(color, 0.55);
    g.drawRect(-1.5, h * 0.10, 3, 7);
    g.endFill();

    // â”€â”€ Axe (weapon side) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const hx0 = dir * w * 0.44;
    const hx1 = hx0 + dir * w * 0.55;
    const axeY = h * 0.29;
    // Handle
    g.beginFill(0x7a4f2e);
    g.drawRect(Math.min(hx0, hx1), axeY, w * 0.55, 4);
    g.endFill();
    // Axe head â€” swept crescent
    g.beginFill(0xb0b0b0);
    g.drawPolygon([
      hx1,              axeY - 2,
      hx1 + dir *  9,   axeY - 11,
      hx1 + dir * 13,   axeY + 2,
      hx1 + dir * 11,   axeY + 16,
      hx1,              axeY + 6,
    ]);
    g.endFill();
    // Edge highlight
    g.beginFill(0xd8d8d8, 0.7);
    g.drawPolygon([
      hx1 + dir *  9, axeY - 10,
      hx1 + dir * 13, axeY +  2,
      hx1 + dir * 11, axeY + 15,
      hx1 + dir *  9, axeY +  2,
    ]);
    g.endFill();

    this.container.addChild(g);
  }

  private buildKnightSprite() {
    const color = this.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const w = this.config.width, h = this.config.height;
    const dir = this.side === 'player' ? 1 : -1;
    this.buildAnimLegs(-w * 0.30, w * 0.30, w * 0.38, h * 0.45, 0.65);

    const g = new PIXI.Graphics();

    // â”€â”€ Kite shield (non-weapon side) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const shX = -dir * w * 0.54;
    const shW =  w  * 0.48;
    const shH =  h  * 0.62;
    const shY =  h  * 0.10;
    // Shield body â€” tall kite shape
    g.beginFill(color, 0.80);
    g.drawPolygon([
      shX - shW * 0.5, shY,
      shX + shW * 0.5, shY,
      shX + shW * 0.5, shY + shH * 0.72,
      shX,             shY + shH,
      shX - shW * 0.5, shY + shH * 0.72,
    ]);
    g.endFill();
    // Shield border
    g.lineStyle(1.5, 0xdddddd, 0.60);
    g.drawPolygon([
      shX - shW * 0.5, shY,
      shX + shW * 0.5, shY,
      shX + shW * 0.5, shY + shH * 0.72,
      shX,             shY + shH,
      shX - shW * 0.5, shY + shH * 0.72,
    ]);
    g.lineStyle(0);
    // Cross emblem on shield
    g.beginFill(0xffffff, 0.50);
    g.drawRect(shX - 1.5,         shY + shH * 0.18, 3,             shH * 0.50);
    g.drawRect(shX - shW * 0.28,  shY + shH * 0.30, shW * 0.56,   3);
    g.endFill();

    // â”€â”€ Plate armour torso â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    g.beginFill(0x888899, 0.30);
    g.drawRoundedRect(-w * 0.46, h * 0.19, w * 0.92, h * 0.42, 5);
    g.endFill();
    // Surcoat tabard (coloured cloth over plate)
    g.beginFill(color, 0.70);
    g.drawRoundedRect(-w * 0.38, h * 0.22, w * 0.76, h * 0.36, 4);
    g.endFill();
    // Chest-plate highlight
    g.beginFill(0xffffff, 0.12);
    g.drawRoundedRect(-w * 0.30, h * 0.24, w * 0.60, h * 0.22, 3);
    g.endFill();
    // Waist belt
    g.beginFill(0x3a2008, 0.55);
    g.drawRect(-w * 0.46, h * 0.54, w * 0.92, 4);
    g.endFill();

    // â”€â”€ Great helm (full-face, closed visor) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Helm bowl
    g.beginFill(0x888899, 0.55);
    g.drawCircle(0, h * 0.10, w * 0.40);
    g.endFill();
    // Flat top plate
    g.beginFill(0x888899, 0.70);
    g.drawRoundedRect(-w * 0.38, h * 0.02 - 6, w * 0.76, 8, 2);
    g.endFill();
    // Face plate (darker)
    g.beginFill(0x555566, 0.80);
    g.drawRoundedRect(-w * 0.32, h * 0.06, w * 0.64, h * 0.12, 3);
    g.endFill();
    // T-slit visor
    g.beginFill(0x111122, 0.90);
    g.drawRect(-w * 0.28, h * 0.09, w * 0.56, 3);   // horizontal slit
    g.drawRect(-1.5,      h * 0.06, 3,         h * 0.12); // vertical nose guard
    g.endFill();
    // Helmet rim highlight
    g.beginFill(0xccccdd, 0.25);
    g.drawRoundedRect(-w * 0.38, h * 0.02 - 6, w * 0.76, 3, 1);
    g.endFill();

    // â”€â”€ Arming sword (weapon side) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const sx  = dir * w * 0.44;
    const sx1 = sx  + dir * w * 0.60;
    const syM = h * 0.28;  // mid height of grip
    // Grip
    g.beginFill(0x5a3010);
    g.drawRect(Math.min(sx, sx1), syM, w * 0.60, 4);
    g.endFill();
    // Cross-guard
    const grdX = sx1 - dir * 3;
    g.beginFill(0xb0b0b0);
    g.drawRect(grdX - 2, syM - 5, 4, 14);
    g.endFill();
    // Blade â€” long straight double-edged
    const bladeX0 = sx1 + dir * 1;
    const bladeX1 = sx1 + dir * 16;
    g.beginFill(0xd0d0d8);
    g.drawPolygon([
      bladeX0,          syM - 1.5,
      bladeX0,          syM + 5.5,
      bladeX1,          syM + 2,
    ]);
    g.endFill();
    // Blade edge highlight
    g.beginFill(0xf0f0f8, 0.80);
    g.drawPolygon([
      bladeX0,          syM,
      bladeX1,          syM + 1,
      bladeX1 - dir*1,  syM - 1,
    ]);
    g.endFill();
    // Pommel (round counterweight at base of grip)
    g.beginFill(0xb0b0b0);
    g.drawCircle(sx, syM + 2, 4);
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
    // From bottom:  tracks (0â€“18%), lower hull (18â€“52%), upper hull (52â€“70%),
    //               turret (52â€“88%), cupola (88â€“100%).
    const trackTop    = h * 0.82;
    const hullLowTop  = h * 0.48;
    const hullHighTop = h * 0.30;
    const turretTop   = h * 0.12;
    const cupolaTop   = h * 0.00;

    const g = new PIXI.Graphics();

    // â”€â”€ Rubber track belt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Lower hull â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    g.beginFill(color, 0.85);
    g.drawRoundedRect(-w / 2, hullLowTop, w, trackTop - hullLowTop, 3);
    g.endFill();
    // Side skirt panels
    g.beginFill(0x000000, 0.18);
    g.drawRect(-w / 2,     hullLowTop, 6, trackTop - hullLowTop);
    g.drawRect(w / 2 - 6,  hullLowTop, 6, trackTop - hullLowTop);
    g.endFill();

    // â”€â”€ Upper hull â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Turret â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ Commander's cupola â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const cupolaCx = turretCx - dir * w * 0.06;
    const cupolaH  = turretTop - cupolaTop;
    g.beginFill(color);
    g.drawRoundedRect(cupolaCx - w * 0.10, cupolaTop, w * 0.20, cupolaH + 3, 4);
    g.endFill();
    g.lineStyle(1.5, 0x000000, 0.22);
    g.drawCircle(cupolaCx, cupolaTop + cupolaH * 0.5, w * 0.07);
    g.lineStyle(0);

    // â”€â”€ Gun barrel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // Body â€” olive drab jacket
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

    // Grenade launcher â€” thick tube at arm/shoulder height
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

    // Body â€” dark military jacket
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

    // Rocket launcher â€” shoulder-mounted tube, thicker than the grenadier's
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

  // â”€â”€ HP bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    if (Math.abs(ratio - this.lastDrawnHpRatio) < 0.005) return;
    this.lastDrawnHpRatio = ratio;
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
    this.randomJumpTimer = 1.5 + Math.random() * 2;  // next check in 1.5â€“3.5 s

    const sideDir = this.side === 'player' ? 1 : -1;
    if (sideDir * (this.x - homeTowerFrontX) < 120) return;  // too close to home
    // Defenders rarely break formation â€” random jumps make them drift off the
    // rally point and out of position. Heavily dampen the chance while on
    // defend duty.
    const chance = this._behavior === 'defend' ? 0.02 : 0.20;
    if (Math.random() < chance) this.jump(this.lastMoveDir, dt);
  }

  private tickLegs(dt: number) {
    if (!this.legL || !this.legR) return;

    const MAX_SWING = 0.42;   // radians â‰ˆ 24Â°
    const WALK_FREQ = 7.0;    // phase advance per second

    if (this.isAirborne) {
      // Tuck back on ascent, extend forward on descent â€” direction-aware
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
      // Idle: decay toward neutral â€” guard skips trig ops once legs are settled
      if (this.legL.rotation !== 0) {
        const nL = this.legL.rotation * 0.85;
        this.legL.rotation = Math.abs(nL) > 0.001 ? nL : 0;
      }
      if (this.legR.rotation !== 0) {
        const nR = this.legR.rotation * 0.85;
        this.legR.rotation = Math.abs(nR) > 0.001 ? nR : 0;
      }
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

  /** Refresh the PIXI container from (x, y). Public so external tick paths
   *  (e.g. the post-game-over physics-only loop) can update the visual after
   *  a syncFromBody-driven landing without going through update(). */
  syncVisual(): void { this.syncPosition(); }

  /** Shift this character by (dx, dy) â€” used to carry units that are standing
   *  on an animated block. Updates x, y, floorY, and the Matter body together
   *  so subsequent syncToBody / syncFromBody calls see a consistent state.
   *  Also drops the cached path because its walk-steps' floorY was anchored
   *  to the old surface position; the next behaviour tick will request fresh. */
  carryWith(dx: number, dy: number): void {
    if (this.isDead) return;
    if (dx === 0 && dy === 0) return;
    this.x      += dx;
    this.y      += dy;
    this.floorY += dy;
    Matter.Body.setPosition(this.body, {
      x: this.body.position.x + dx,
      y: this.body.position.y + dy,
    });
    this.clearPath();
  }

  // â”€â”€ Coin carry visual â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private showCoinCarry() {
    if (this.coinCarryGfx) return;
    const [outer, mid,, hi] = COIN_PALETTE[this.coinCarryKind];
    const g = new PIXI.Graphics();
    g.beginFill(outer);   g.drawCircle(0, 0, 7);   g.endFill();
    g.beginFill(mid);     g.drawCircle(0, 0, 5);   g.endFill();
    g.beginFill(hi, 0.8); g.drawCircle(-2, -2, 2); g.endFill();
    g.x = 0;
    g.y = 6;   // held low, around the character's arms/hands while carried
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
      vx: dir * COIN_THROW_VX, vy: -COIN_THROW_VY,  // 60Â° â€” vy â‰ˆ vx Ã— âˆš3
    };
    // No cooldown â€” character stays active in the field immediately
  }

  // â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Called by Game.end() when the match finishes. Stops all motion drivers,
   * cancels pending actions, and forces both animation layers to 'idle'.
   * The Game tick loop keeps running (so the sprites continue to render and
   * pan with the camera) but skips game logic, so freezing here is the only
   * chance to settle the character's visual state.
   */
  freezeForGameOver(): void {
    if (this.isDead) return;
    this.state              = 'marching';   // matches anim layers' idle fallback
    this.jumpVx             = 0;
    this.knockbackVx        = 0;
    this.attackTimer        = 0;
    this.attackFacingTimer  = 0;
    this.pendingMeleeSwing  = null;
    this.pendingBlast       = null;
    this.pendingHitJump     = false;
    this.path               = [];
    this.pathIdx            = 0;
    // Zero horizontal velocity but preserve vertical so a character mid-jump
    // or mid-fall continues their arc and lands naturally during the
    // post-game physics loop instead of restarting gravity from rest.
    Matter.Body.setVelocity(this.body, { x: 0, y: this.body.velocity.y });
    if (this.bodySprite) this.switchBodyAnimation('idle');
    if (this.legsSprite) this.switchLegsAnimation('idle');
  }

  takeDamage(dmg: number, killer?: Character) {
    // Always queue a label event (amount=0 â†' "Miss" in Game.ts)
    this.pendingDamages.push({ amount: dmg, x: this.x, y: this.y - this.config.height - 6 });
    if (dmg <= 0) return;  // miss â€” no HP change, no coin drop, no kill

    this.hp = Math.max(0, this.hp - dmg);
    this.drawBar();
    if (this.carryingCoin) this.dropCarriedCoin();
    // Defenders stay planted under fire â€” jumping mid-defence drags them off
    // the rally point and out of the defence zone.
    const hitJumpChance = this._behavior === 'defend' ? HIT_JUMP_CHANCE * 0.15 : HIT_JUMP_CHANCE;
    if (!this.isAirborne && Math.random() < hitJumpChance) this.pendingHitJump = true;
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
  /** Read-only â€” true while mid-jump or mid-fall. */
  get airborne()       { return this.isAirborne; }
  /** Read-only â€” y of the surface (ground / platform / block top) the character is standing on. */
  get currentFloorY()  { return this.floorY; }

  pauseAnimations()  { this.bodySprite?.stop(); this.legsSprite?.stop(); this.container.alpha = 1; }
  resumeAnimations() { this.bodySprite?.play(); this.legsSprite?.play(); }

  get frontX() {
    return this.side === 'player'
      ? this.x + this.config.width / 2
      : this.x - this.config.width / 2;
  }

  get bowY() { return this.y - this.config.height * 0.62; }

  /** Approximate horizontal velocity (px/s) â€” used by grenadier lead targeting. */
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
    return type === 'conscript' || type === 'warrior' || type === 'viking' || type === 'knight' || type === 'heavy' || type === 'shocktrooper';
  }

  update(ctx: UpdateContext) {
    if (this.isDead) return;

    this.attackTimer        = Math.max(0, this.attackTimer        - ctx.dt);
    this.evasiveJumpTimer   = Math.max(0, this.evasiveJumpTimer   - ctx.dt);
    this.attackFacingTimer  = Math.max(0, this.attackFacingTimer  - ctx.dt);
    this.tickPendingMeleeSwing(ctx);
    this.tickPendingBlast(ctx);

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
    this.tickSpeedStreaks(ctx.dt);

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

    // Block horizontal wall collision â€” character X is teleported by AI so physics
    // cannot stop side entry; clamp manually. Skip while airborne so jump arcs are
    // not interrupted (landing is handled by syncFromBody).
    if (!this.isAirborne) this.clampBlockWalls(ctx.blocks);
    this.tickStuck(ctx.dt);

    this.syncPosition();
  }

  // â”€â”€ Physics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Drop straight through the platform we're currently standing on.
   * Sets isAirborne and records dropFromY so syncFromBody ignores this
   * platform on the next landing pass â€” gravity then carries the character
   * down to the next surface (lower platform or ground).
   * No-op if the character is airborne, on the ground, or on a block (the
   * pathfinder only emits 'drop' steps for non-solid platforms, so a block
   * floor here means the character has drifted; the step will time out).
   */
  private dropFromPlatform(platforms: PlatformData[]): boolean {
    if (this.isAirborne) return false;
    if (this.floorY >= this.groundY) return false;
    // Verify we're actually on a platform (not a block at this y).
    const onPlat = platforms.some(p =>
      this.x >= p.x && this.x <= p.x + p.width && Math.abs(p.y - this.floorY) < 1,
    );
    if (!onPlat) return false;

    this.dropFromY  = this.floorY;
    this.isAirborne = true;
    this.jumpVx     = 0;
    // No velocity boost â€” gravity does the work.
    Matter.Body.setVelocity(this.body, { x: 0, y: 0 });
    return true;
  }

  private jump(dirX: number, _dt: number) {
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
      y: -JUMP_VELOCITY / 60,   // constant px/frame at 60 fps reference; immune to lag-spike dt amplification
    });
  }

  applyKnockback(vx: number, vy: number, _dt: number, decayFactor: number) {
    this.knockbackVx          = vx;
    this.knockbackDecayFactor = decayFactor;
    this.isAirborne           = true;
    this.jumpVx               = 0;
    this.clearPath();
    Matter.Body.setVelocity(this.body, {
      x: this.body.velocity.x,
      y: -Math.abs(vy) / 60,   // same fixed-fps convention as jump()
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
    // making char.y drift to this.groundY while floorY stays stale at platform height.
    const onPlatform = !this.isAirborne && this.floorY < this.groundY;
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
      // X-range check first: most characters are nowhere near any given block
      if (this.x <= b.x || this.x >= b.x + b.width) continue;
      // Standing on top of this block (or any higher surface): skip lateral clamp.
      if (this.floorY <= b.y) continue;
      if (charTop >= b.y + b.height) continue;
      this.x = this.x < b.x + b.width / 2 ? b.x : b.x + b.width;
      this.knockbackVx = 0;
      this.clampedCount++;
      // Clear the path so requestPath replans from the clamped position
      // (the new subsegment) and routes a jump over the block.
      this.clearPath();
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
      // Drop-through clears once feet are clear of the source platform â€” after
      // that, normal landing logic resumes (so lower platforms still catch us).
      if (this.dropFromY !== null && this.y > this.dropFromY + 5) {
        this.dropFromY = null;
      }

      // Platform/block landing: detect feet crossing the surface while falling (tunneling-safe).
      if (this.body.velocity.y >= 0) {
        for (const p of platforms) {
          // During an in-place drop, skip the platform we're dropping through
          // so it doesn't immediately re-snap our feet to its surface.
          if (this.dropFromY !== null && Math.abs(p.y - this.dropFromY) < 1) continue;
          if (this.x >= p.x && this.x <= p.x + p.width && prevFeetY <= p.y && this.y >= p.y) {
            this.y = p.y;
            Matter.Body.setPosition(this.body, { x: this.body.position.x, y: p.y - halfH });
            Matter.Body.setVelocity(this.body, { x: 0, y: 0 });
            this.isAirborne = false;
            this.jumpVx     = 0;
            this.floorY     = p.y;
            this.dropFromY  = null;
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
            this.dropFromY  = null;
            this.recordJumpOutcome(b.y);
            return;
          }
        }
      }

      // Ground landing: only when falling (vy â‰¥ 0) â€” prevents premature reset
      // on the tick a jump starts, when the body hasn't moved up yet.
      if (this.y >= this.groundY - 1 && this.body.velocity.y >= 0) {
        this.isAirborne = false;
        this.jumpVx     = 0;
        this.floorY     = this.groundY;
        this.y          = this.groundY;
        this.dropFromY  = null;
        this.recordJumpOutcome(this.groundY);
      }
    } else if (this.floorY < this.groundY) {
      // On elevated surface â€” detect walking off edge horizontally.
      // Match only the surface at this character's current floorY; a different
      // platform/block below that happens to overlap in x must not count, or the
      // character keeps walking at the higher floorY in mid-air.
      // Plain for-loops with early break — avoids two .some() closure
      // allocations per character per tick.
      let onSurface = false;
      const x = this.x, fy = this.floorY;
      for (let i = 0; i < platforms.length; i++) {
        const p = platforms[i];
        if (x >= p.x && x <= p.x + p.width && Math.abs(p.y - fy) < 1) { onSurface = true; break; }
      }
      if (!onSurface) {
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (x >= b.x && x <= b.x + b.width && Math.abs(b.y - fy) < 1) { onSurface = true; break; }
        }
      }
      if (!onSurface) this.isAirborne = true;
    }
  }

  // â”€â”€ Pathfinding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Request a fresh path to (toX, toFloorY) only when the target moved
   * far enough or the existing path has gone stale.
   */
  private requestPath(toX: number, toFloorY: number, navGraph: NavGraph, dt: number): void {
    // Quantise target to a 20 px grid so minor positional drift (e.g. an enemy
    // character drifting a few pixels) doesn't trigger a full path rebuild every tick.
    const qx = Math.round(toX / 20) * 20;
    const qy = Math.round(toFloorY);
    this.pathAge += dt;
    const navStale = navGraph.version !== this.pathNavVersion;
    // A fully-consumed path (pathIdx at the end) that did NOT leave the character
    // at the destination means the last plan couldn't be executed from here — the
    // classic case is a unit stranded on a platform whose only step was an
    // un-walkable cross-floor fallback. followPath bumps pathIdx past it without
    // moving, and the old `path.length > 0` reuse guard then kept handing back the
    // dead path forever. Force a fresh A* from the current position instead.
    // (Reuse still applies when the character is parked AT its goal, so harass /
    // defend units idling on a rally point don't thrash-rebuild every tick.)
    const consumedButNotArrived =
      this.pathIdx >= this.path.length &&
      (Math.abs(this.x - toX) > 12 || Math.abs(this.floorY - toFloorY) > 20);
    if (!navStale && this.pathAge < this.PATH_TTL && this.path.length > 0 && !consumedButNotArrived) {
      // Cheap path-reuse: same 20-px grid cell as the last request.
      if (qx === this.pathTargetQx && qy === this.pathTargetQy) return;
      // Hysteresis: harass/defend pass live moving-enemy positions every tick,
      // so the 20-px bucket flips every 100-250 ms even when the target is
      // effectively stable. Reuse the existing path when the new request is
      // within ~40 px horizontally and ~30 px vertically of the cached target —
      // the cached path's final walk step already covers drift within one
      // surface. Cuts harass/defend rebuild rate from ~5/s to ~1/s per char.
      if (Math.abs(toX - this.pathTargetQx) < 40 && Math.abs(toFloorY - this.pathTargetQy) < 30) return;
    }

    this.path         = navGraph.findPath(this.x, this.floorY, toX, toFloorY, this.moveSpeed);
    this.pathIdx      = 0;
    this.pathTargetQx = qx;
    this.pathTargetQy = qy;
    this.pathAge      = 0;
    this.pathNavVersion = navGraph.version;
    this.pathRebuildCount++;
    this.lastBuiltPath = this.path.slice();
  }

  /** Invalidate the current path (e.g. after a coin is picked up, target changes). */
  clearPath(): void {
    this.path           = [];
    this.pathIdx        = 0;
    this.pathTargetQx   = NaN;
    this.pathTargetQy   = NaN;
    this.pathNavVersion = -1;
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
   *
   * Steps that are "instant-complete" (walk within 10-px stop tolerance,
   * jump-target-already-reached, fall-landed, drop-landed, drop-init failed,
   * tanker hitting a jump step) just bump `pathIdx` and chain into the next
   * step in the same tick â€” otherwise a character that spawns 8 px from a
   * jump trigger would burn a tick on the walk-complete advance and only
   * jump on the *next* tick (looking like a delay before takeoff). Capped
   * at MAX_STEPS_PER_TICK iterations as a safety against pathological paths.
   */
  private followPath(dt: number, platforms: PlatformData[]): boolean {
    const MAX_STEPS_PER_TICK = 6;
    for (let iter = 0; iter < MAX_STEPS_PER_TICK; iter++) {
      if (this.pathIdx >= this.path.length) return true;
      const step = this.path[this.pathIdx];

      // â”€â”€ walk â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (step.action === 'walk') {
        // Already on a different surface (e.g. fell off mid-walk) â€” skip.
        if (!this.isAirborne && Math.abs(this.floorY - step.floorY) > 20) {
          this.pathIdx++;
          continue;
        }
        const dx = step.targetX - this.x;
        if (Math.abs(dx) <= 10) {
          this.pathIdx++;
          continue;  // try the next step (often a jump that should fire now)
        }
        if (!this.isAirborne) this.x += Math.sign(dx) * this.moveSpeed * dt;
        return false;
      }

      // â”€â”€ jump â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (step.action === 'jump') {
        if (this.config.type === 'tanker') {
          this.pathIdx++;
          continue;
        }
        // Already on the target surface â€” redundant step, advance.
        if (!this.isAirborne && Math.abs(this.floorY - step.floorY) < 20 && step.floorY < this.groundY - 10) {
          this.pathIdx++;
          continue;
        }
        // Source-floor guard: drifted off the floor the planner assumed.
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

      // â”€â”€ fall â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (step.action === 'fall') {
        if (!this.isAirborne && Math.abs(this.floorY - step.floorY) < 20) {
          this.pathIdx++;
          continue;
        }
        if (this.isAirborne) return false;
        const dx = step.targetX - this.x;
        if (Math.abs(dx) > 5) this.x += Math.sign(dx) * this.moveSpeed * dt;
        return false;
      }

      // â”€â”€ drop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // In-place fall through the current platform. Only emitted by the planner
      // when the character is on a non-solid platform and the destination
      // surface spans the character's current x.
      if (step.action === 'drop') {
        if (!this.isAirborne && Math.abs(this.floorY - step.floorY) < 20) {
          this.pathIdx++;
          continue;
        }
        if (this.isAirborne) return false;
        // dropFromPlatform fails if the character has drifted onto a block /
        // off the platform â€” skip so the outer behaviour can rebuild a path.
        if (!this.dropFromPlatform(platforms)) {
          this.pathIdx++;
          continue;
        }
        return false;
      }

      return true;  // unknown action â€” abort
    }
    return false;
  }

  // â”€â”€ Attacking behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private updateAttacking(ctx: UpdateContext) {
    const { dt, enemies, enemyTowerFrontX, enemyTowerY, onFire, navGraph, blocks } = ctx;
    if (this.isAirborne) return;   // don't change horizontal intent mid-air

    const dir         = this.side === 'player' ? 1 : -1;
    const distToTower = Math.abs(this.x - enemyTowerFrontX);

    // Reached the enemy tower — sit and pound it.
    if (distToTower <= this.config.attackRange) {
      this.state = 'fighting';
      this.attackTower(enemyTowerFrontX, enemyTowerY, onFire, ctx.onDamageTower);
      return;
    }

    // Opportunistic attack: fire at any enemy in range WITHOUT halting the advance.
    // (Attacking no longer stops to fight — movement is driven purely by the
    // behaviour; the attack is a free action layered on top.)
    const nearest = this.nearestEnemy(enemies, this.config.attackRange, blocks);
    if (nearest) this.attackEnemy(nearest, onFire);

    // Kiting is a movement nuance of the attack behaviour, not an attack gate:
    // a ranged unit backs away from a closing melee enemy (but never into its own tower).
    if (nearest && this.isRanged && Character.isMeleeType(nearest.config.type)
        && Math.abs(this.x - nearest.x) < RANGED_KITE_THRESHOLD) {
      this.state = 'marching';
      const retreatX = this.x - dir * this.moveSpeed * dt;
      this.x = dir > 0 ? Math.max(retreatX, ctx.homeTowerFrontX) : Math.min(retreatX, ctx.homeTowerFrontX);
      return;
    }

    // Advance toward the enemy tower. enemyTowerBaseFloorY matches the surface the
    // tower sits on (may be an elevated block, not this.groundY).
    this.state = 'marching';
    this.requestPath(enemyTowerFrontX, ctx.enemyTowerBaseFloorY, navGraph, dt);
    this.followPath(dt, ctx.platforms);
  }

  // â”€â”€ Rush behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Charge straight to the enemy tower, dodging enemy characters by jumping over
  // them. Fires at any enemy in range while moving â€” does not stop to engage.

  private updateRushing(ctx: UpdateContext) {
    const { dt, enemies, enemyTowerFrontX, enemyTowerY, onFire, blocks, navGraph } = ctx;
    if (this.isAirborne) return;

    const dir         = this.side === 'player' ? 1 : -1;
    const distToTower = Math.abs(this.x - enemyTowerFrontX);

    if (distToTower <= this.config.attackRange) {
      this.state = 'fighting';
      this.attackTower(enemyTowerFrontX, enemyTowerY, onFire, ctx.onDamageTower);
      return;
    }

    // Opportunistic attack: fire at any enemy in range without stopping movement
    const nearest = this.nearestEnemy(enemies, this.config.attackRange, blocks);
    if (nearest) this.attackEnemy(nearest, onFire);

    // Dodge enemies directly in front by jumping over them.
    const RUSH_DODGE_LOOKAHEAD = 90;
    const RUSH_FLOOR_TOL       = 25;
    const blocker = enemies.find(c =>
      !c.isDead &&
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
    this.requestPath(enemyTowerFrontX, ctx.enemyTowerBaseFloorY, navGraph, dt);
    this.followPath(dt, ctx.platforms);
  }

  // â”€â”€ Collecting behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private updateCollecting(ctx: UpdateContext) {
    const { dt, enemies, allies, coins, homeTowerFrontX, homeTowerBaseFloorY, onFire, onDepositCoin, navGraph, blocks } = ctx;

    // Attack any enemy that wanders into range without stopping movement
    if (!this.isAirborne) {
      const nearest = this.nearestEnemy(enemies, this.config.attackRange, blocks);
      if (nearest) this.attackEnemy(nearest, onFire);
    }

    // Evasive jump: 80% chance to leap over a blocking enemy while en route
    // Suppressed on platform â€” jumping from height would throw the character off
    if (!this.isAirborne && !this.isOnPlatform && this.evasiveJumpTimer <= 0) {
      const dirToTarget = this.carryingCoin
        ? Math.sign(homeTowerFrontX - this.x)
        : this.targetCoin ? Math.sign(this.targetCoin.x - this.x) : 0;
      if (dirToTarget !== 0) {
        const blocking = enemies.find(c =>
          !c.isDead &&
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
      // Vertical gap between the carrier's STANDING SURFACE and the home
      // tower's base surface. If the carrier is on a surface that sits
      // COIN_THROW_MAX_Y_GAP or more below the tower's base (e.g. on the
      // ground while the tower is elevated on a block), throwing would arc
      // the coin into the side of that block â€” keep carrying until they
      // reach a surface within range of the tower.
      // Using `this.floorY` (the snapped surface y) instead of `this.y`
      // avoids sub-pixel physics bounce making the gap fall just under
      // the threshold on grounded characters.
      const yGapBelowTower = this.floorY - homeTowerBaseFloorY;
      const tooLowToThrow  = yGapBelowTower >= COIN_THROW_MAX_Y_GAP;
      if (distToTower <= CHAR_DEPOSIT_DIST) {
        this.carryingCoin = false;
        this.removeCoinCarry();
        this.state = 'marching';
        onDepositCoin(this.coinCarryValue);
        this.earnAP(PROMO_COIN_AP);
        return;
      } else if (distToTower > COIN_THROW_MIN_DIST && !tooLowToThrow) {
        // Hold coin for COIN_THROW_HOLD_SEC before releasing the 45Â° throw
        if (this.coinThrowTimer < 0) {
          this.coinThrowTimer  = COIN_THROW_HOLD_SEC;
          this.throwFacingDir  = (homeTowerFrontX < this.x ? -1 : 1);
        }
        this.coinThrowTimer -= dt;
        this.state = 'returning';   // stand still while winding up
        if (this.coinThrowTimer > 0) return;
        // Timer expired â€” release throw, scan nearby for a new coin, fall through
        this.coinThrowTimer = -1;
        this.throwCarriedCoin(homeTowerFrontX);
        this.targetCoin = this.nearestCoin(coins, COIN_THROW_SCAN_RANGE);
        // carryingCoin is now false â€” fall through to pickup logic
      } else {
        this.coinThrowTimer = -1;  // moved close enough â€” cancel any pending windup
        this.state = 'returning';
        // Route to the tower's actual surface, not this.groundY â€” otherwise an
        // elevated tower causes carriers to path *under* it (to the ground)
        // and stall there without ever reaching the deposit x-strip.
        this.requestPath(homeTowerFrontX, homeTowerBaseFloorY, navGraph, dt);
        this.followPath(dt, ctx.platforms);
        return;
      }
    }

    if (this.targetCoin && (this.targetCoin.isDead || this.targetCoin.isPickedUp)) {
      this.targetCoin = null;
    }

    if (!this.targetCoin) {
      // Exclude coins already claimed by an ally collector so teammates spread out
      const claimed = new Set(
        allies
          .filter(c => c !== this && c.behavior === 'collecting' && c.claimedCoin)
          .map(c => c.claimedCoin!),
      );
      const free = coins.filter(c => !claimed.has(c));
      this.targetCoin = this.coinClosestToTower(free.length > 0 ? free : coins, homeTowerFrontX);
    }

    if (this.targetCoin) {
      // Navigate to the coin's settled floor level (coin.floorY is correct once settled,
      // falls back to this.groundY for in-flight coins which is fine â€” pathfinding adjusts en-route).
      this.requestPath(this.targetCoin.x, this.targetCoin.floorY, navGraph, dt);
      this.followPath(dt, ctx.platforms);

      this.state = 'collecting';

      if (this.isAirborne) return;   // horizontal position handled by physics

      // â”€â”€ Pickup check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const dist    = Math.abs(this.x - this.targetCoin.x);
      const yProx   = Math.abs(this.floorY - this.targetCoin.y);
      // Same surface: settled floorY match OR character is physically close in Y
      const sameSurface  = Math.abs(this.floorY - this.targetCoin.floorY) < 30 || yProx < 40;
      // Reachable: settled on any surface, near ground, or character is close in Y
      const coinReachable = this.targetCoin.isOnGround
        || this.targetCoin.y >= this.groundY - 30
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
      // No coins on field â€” drift toward center drop zone
      this.state = 'marching';
      const center = ctx.worldWidth / 2;
      if (Math.abs(this.x - center) > 40) {
        this.x += Math.sign(center - this.x) * this.moveSpeed * 0.5 * dt;
      }
    }
  }

  // â”€â”€ Harass behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private updateHarass(ctx: UpdateContext) {
    const { dt, enemies, allies, enemyTowerFrontX, homeTowerFrontX, onFire, blocks, navGraph } = ctx;
    if (this.isAirborne) return;

    const dir   = this.side === 'player' ? 1 : -1;
    const safeX = enemyTowerFrontX - dir * (TOWER_ATTACK_RANGE + HARASS_SAFETY_BUFFER);

    // Retreat is highest priority â€” back off before doing anything else
    if (dir * (this.x - safeX) > 0) {
      this.state = 'marching';
      this.x -= dir * this.moveSpeed * dt;
      // Still fire at enemies while retreating
      const target = this.nearestEnemy(enemies, this.config.attackRange, blocks);
      if (target) this.attackEnemy(target, onFire);
      return;
    }

    // Attack any enemy in range (no position change)
    const inRange = this.nearestEnemy(enemies, this.config.attackRange, blocks);
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
      // No valid in-range target this tick â€” release the fighting lock so the
      // movement branches below can correctly drive 'marching' (and so the
      // animation stops showing 'attack' while the character is walking).
      this.state = 'marching';
    }

    // Find the closest enemy (no range limit) to guide movement
    let closest: Character | null = null;
    let closestDist = Infinity;
    for (const c of enemies) {
      if (c.isDead) continue;
      const d = Math.abs(c.x - this.x);
      if (d < closestDist) { closestDist = d; closest = c; }
    }

    const clamp = (v: number) => dir > 0 ? Math.min(v, safeX) : Math.max(v, safeX);

    const charOnPlatform = this.floorY < this.groundY;

    if (closest) {
      const toEnemy = dir * (closest.x - this.x);

      // Closest enemy is on a platform and we're on the ground — use pathfinding
      // to navigate up. The old primitive froze when Math.sign(0) = 0 (same X, different floor).
      if (closest.isOnPlatform && !charOnPlatform) {
        this.requestPath(clamp(closest.x), closest.floorY, navGraph, dt);
        this.followPath(dt, ctx.platforms);
        this.state = 'marching';
      } else if (toEnemy > 0 && closestDist > this.config.attackRange * 0.8) {
        // Enemy is ahead and not yet in range â€” use pathfinding to navigate around blocks.
        // Pass the enemy's floor (not this.floorY): if the character is on a platform and the
        // enemy is on the ground/a different surface, using this.floorY snaps the destination
        // to the current platform's edge and the character can stall there.
        this.requestPath(clamp(closest.x), closest.floorY, navGraph, dt);
        this.followPath(dt, ctx.platforms);
        if (this.state !== 'fighting') this.state = 'marching';
      } else if (toEnemy <= 0) {
        if (!this.isRanged && closestDist <= this.config.attackRange * 4) {
          // Melee harass: pursue enemy that's behind rather than drifting away
          this.x -= dir * this.moveSpeed * dt;
          if (this.state !== 'fighting') this.state = 'marching';
        } else if (dir * (safeX - this.x) > 5) {
          // Ranged or enemy too far behind â€” use pathfinding to drift to safe line
          this.requestPath(safeX, this.floorY, navGraph, dt);
          this.followPath(dt, ctx.platforms);
          if (this.state !== 'fighting') this.state = 'marching';
        }
      } else if (Math.abs(closest.floorY - this.floorY) > 20) {
        // Enemy is in horizontal attack range but on a different floor (directly
        // above or below) â€” we can't actually hit them from here. Path toward
        // their floor so we either jump up onto their platform or walk off an
        // edge to drop down. Without this, the character holds position
        // indefinitely thinking it's already in range.
        this.requestPath(clamp(closest.x), closest.floorY, navGraph, dt);
        this.followPath(dt, ctx.platforms);
        if (this.state !== 'fighting') this.state = 'marching';
      }
      // else: enemy is ahead, in attack range, on same plane â€” hold position
    } else {
      // No enemies â€” use pathfinding to group up or rally near own tower
      const mate = this.nearestAlly(allies);
      const rallyX = mate ? mate.x : homeTowerFrontX + dir * 80;
      const dist   = Math.abs(this.x - rallyX);
      const thresh = mate ? 55 : 20;
      if (dist > thresh) {
        this.requestPath(rallyX, this.floorY, navGraph, dt);
        this.followPath(dt, ctx.platforms);
        this.state = 'marching';
      }
    }
  }

  // â”€â”€ Defend behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private updateDefending(ctx: UpdateContext) {
    const { dt, enemies, allies, homeTowerFrontX, onFire, blocks, navGraph } = ctx;
    if (this.isAirborne) return;

    const dir = this.side === 'player' ? 1 : -1;

    // Two zones around the home tower:
    //   â€¢ Defence zone  â€” narrow slab matching the tower's auto-fire range; this
    //     is where defenders idle when no threat is present.
    //   â€¢ Attack zone   â€” wider slab (DEFEND_PURSUIT_RANGE) used for *detection*
    //     and *pursuit clamp*. Any enemy here is a threat; the defender may step
    //     out of the defence zone to chase, but never beyond the attack zone.
    // The attack zone catches ranged enemies firing in from just outside the
    // defence zone â€” without it, defenders take chip damage they can't return.
    const defNearX = Math.min(homeTowerFrontX, homeTowerFrontX + dir * TOWER_ATTACK_RANGE);
    const defFarX  = Math.max(homeTowerFrontX, homeTowerFrontX + dir * TOWER_ATTACK_RANGE);
    const atkNearX = Math.min(homeTowerFrontX, homeTowerFrontX + dir * DEFEND_PURSUIT_RANGE);
    const atkFarX  = Math.max(homeTowerFrontX, homeTowerFrontX + dir * DEFEND_PURSUIT_RANGE);

    // Auto-attack: the nearest enemy within personal weapon range with a clean
    // shot (nearestEnemy applies LOS / canSnapHit gating). A defender always
    // fires at anything it can hit -- regardless of zone or whether another
    // defender has already claimed it.
    const target = this.nearestEnemy(enemies, this.config.attackRange, blocks);

    // Collect intruders already being pursued by other defenders so we don't
    // dog-pile on the same enemy *while other threats remain*. Each defender
    // exposes its pursuit target via claimedIntruder; we filter those out when
    // picking our own -- but fall back to a claimed enemy below when there is
    // nothing else to engage.
    const claimed = new Set<Character>();
    for (const c of allies) {
      if (c === this || c.isDead) continue;
      if (c.behavior !== 'defend') continue;
      const t = c.claimedIntruder;
      if (t) claimed.add(t);
    }

    // Pick an intruder to pursue, in priority order:
    //   1. the one we're already pursuing (if alive & still in the attack zone),
    //   2. the nearest *unclaimed* intruder in the attack zone,
    //   3. the nearest intruder inside the *defence zone* even if another
    //      defender already has it -- so a spare defender still engages an enemy
    //      that has penetrated the core zone rather than idling at rally.
    let intruder: Character | null = null;
    if (this.defendTargetIntruder && !this.defendTargetIntruder.isDead &&
        this.defendTargetIntruder.x >= atkNearX && this.defendTargetIntruder.x <= atkFarX) {
      intruder = this.defendTargetIntruder;
    } else {
      let minDist = Infinity;
      for (const c of enemies) {
        if (c.isDead) continue;
        if (c.x < atkNearX || c.x > atkFarX) continue;
        if (claimed.has(c)) continue;   // already covered by another defender
        const d = Math.abs(c.x - this.x);
        if (d < minDist) { minDist = d; intruder = c; }
      }
      // Fallback -- nothing unclaimed: engage an already-targeted enemy inside
      // the defence zone (gang up when it is the only threat present).
      if (!intruder) {
        let minClaimed = Infinity;
        for (const c of enemies) {
          if (c.isDead) continue;
          if (c.x < defNearX || c.x > defFarX) continue;
          const d = Math.abs(c.x - this.x);
          if (d < minClaimed) { minClaimed = d; intruder = c; }
        }
      }
    }

    // Engage: if any enemy is in weapon range, fire -- even when we have no
    // pursuit target. This is the automatic defence of the line.
    if (target) {
      if (intruder) { this.defendTargetIntruder = intruder; this.defendWasPursuing = true; }
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

    if (intruder) {
      this.defendTargetIntruder = intruder;
      this.defendWasPursuing    = true;

      // Intruder in zone but no clean shot -- pursue at the intruder's
      // elevation. Clamp to the *attack* zone so the defender can leave the
      // defence zone to engage, but never wanders past the pursuit boundary.
      const pursueX = Math.max(atkNearX, Math.min(atkFarX, intruder.x));
      this.state = 'marching';
      this.requestPath(pursueX, intruder.floorY, navGraph, dt);
      this.followPath(dt, ctx.platforms);
      return;
    }

    // No intruders â†' release our pursuit claim, regenerate the rally point if
    // we just got back from chasing, then return to it.
    this.defendTargetIntruder = null;
    if (this.defendWasPursuing || this.defendRallyX === null) {
      // Random spot inside the defence zone â€” keeps a group of defenders
      // spread out rather than stacked on a single rally x.
      this.defendRallyX      = defNearX + Math.random() * (defFarX - defNearX);
      this.defendWasPursuing = false;
    }
    const restX = this.defendRallyX;
    const delta = restX - this.x;
    if (Math.abs(delta) > 20) {
      this.state = 'marching';
      // Destination is always ground level â€” the home tower sits on this.groundY,
      // so the defence zone slab is on the ground regardless of what the
      // defender is currently standing on. Using this.floorY here would ask
      // the pathfinder for a surface at the destination x that doesn't exist
      // (e.g. character on a block top, rally point off the block) and the
      // returned path would be empty, freezing the defender in place.
      this.requestPath(restX, this.groundY, navGraph, dt);
      this.followPath(dt, ctx.platforms);
    } else {
      this.state = 'marching';
    }
  }

  // â”€â”€ Attack helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  private tickSpeedStreaks(dt: number): void {
    const isMoving = this.currentLegsAnim === 'walk' ? this.stillTimer < 0.15 : this.movingTimer > 0.05;
    if (this.powerUpSpeedMult <= 1 || !isMoving) { this.speedStreakTimer = 0; this.afterImageTimer = 0; return; }

    // Motion-blur streak lines.
    this.speedStreakTimer -= dt;
    if (this.speedStreakTimer <= 0) {
      this.speedStreakTimer = 0.05;
      spawnSpeedStreak(this.x, this.y, this.config.height, this.lastMoveDir);
    }

    // Afterimage ghost — a fading copy of the current sprite frames every 40–70 ms.
    this.afterImageTimer -= dt;
    if (this.afterImageTimer <= 0) {
      this.afterImageTimer = 0.04 + Math.random() * 0.03;  // 40–70 ms
      this.spawnAfterImageGhost();
    }
  }

  /** Drop a ghost copy of the current body+legs sprite frames (only for
   *  sprite-rendered characters; Graphics units have no frames to copy). */
  private spawnAfterImageGhost(): void {
    const parts: AfterImagePart[] = [];
    // Legs first so they sit behind the body inside the ghost, matching the live stack.
    for (const s of [this.legsSprite, this.bodySprite]) {
      if (!s) continue;
      parts.push({
        texture:  s.texture,
        x:        this.container.x + s.x,   // sprite world position
        y:        this.container.y + s.y,
        anchorX:  s.anchor.x,
        anchorY:  s.anchor.y,
        scaleX:   s.scale.x,                // carries the facing flip
        scaleY:   s.scale.y,
        rotation: s.rotation,
      });
    }
    spawnAfterImage(parts);
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
      // Promote: advance one rank and play the promotion animation.
      // At max rank (Captain) this is a no-op on rank, acting as a full heal instead.
      if (this.rank < 3) {
        this.ap   = PROMO_THRESHOLDS[this.rank];  // normalise AP so earnAP doesn't skip a threshold after forced promotion
        this.rank = (this.rank + 1) as 0 | 1 | 2 | 3;
        this.pendingPromotion = true;
        this.drawRankBadge();
        this.startPromoAnim();
      }
      // Always restore HP to the (possibly new) max.
      this.hp = this.maxHp;
      this.drawBar();
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
   * Forces the firing direction to horizontal â€” ranged units shoot sideways only,
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

  /**
   * Duration of the body anim in seconds, or 0 if the type has no sprite for it
   * (Graphics fallback). Used to hold the 'attack' body anim through one full
   * cycle and to time the melee wind-up.
   */
  private bodyAnimDuration(anim: BodyAnimName): number {
    const frames = this.spriteSet?.body[anim];
    if (!frames) return 0;
    const fps = getBodyAnimFps(this.tribe, this.config.type, anim);
    return frames.length / fps;
  }

  /**
   * Sets up the attack-facing + body-attack-hold timer and returns the wind-up
   * delay for melee swings (seconds until the hit lands). Ranged attacks fire
   * immediately and don't use the wind-up, but still get the longer facing
   * hold so the attack body anim plays through.
   */
  private beginAttack(): number {
    const animDur = this.bodyAnimDuration('attack');
    // Hold body on 'attack' for at least one full cycle (or 0.3s default if no sprite).
    this.attackFacingTimer = Math.max(this.attackFacingTimer, animDur > 0 ? animDur : 0.3);
    // Melee hit lands ~40% into the swing anim â€” feels like the moment of contact.
    return animDur > 0 ? animDur * 0.4 : 0.15;
  }

  /**
   * Advance the pending melee swing's wind-up timer. When it expires the swing
   * lands: apply damage to the target (or tower) if the target is still valid.
   * Targets that died or moved out of melee range simply waste the swing â€” no
   * homing â€” which matches how melee feels visually.
   */
  private tickPendingMeleeSwing(ctx: UpdateContext) {
    const swing = this.pendingMeleeSwing;
    if (!swing) return;
    swing.delay -= ctx.dt;
    if (swing.delay > 0) return;
    this.pendingMeleeSwing = null;
    if (this.isDead) return;
    if (swing.target) {
      if (swing.target.isDead) return;
      const reach = this.config.attackRange + this.config.width * 0.5 + swing.target.config.width * 0.5 + 8;
      if (Math.abs(swing.target.x - this.x) > reach) return;
      swing.target.takeDamage(swing.damage, swing.damage > 0 ? this : undefined);
      if (swing.damage > 0) {
        ctx.onMeleeHit?.(this.config.type, this.x);   // no sound on misses (damage === 0)
        spawnHitSpark(swing.target.x, swing.target.y - swing.target.config.height * 0.5);
        // Knockback the victim in the attack direction (relative x).
        if (this.config.knockback > 0 && !swing.target.isDead) {
          const dir = Math.sign(swing.target.x - this.x) || this.lastAttackDir;
          swing.target.applyKnockback(this.config.knockback * dir, ATTACK_KNOCKBACK_VY, ctx.dt, ctx.attackKnockbackDecay);
        }
      }
    } else if (swing.onTower) {
      swing.onTower(swing.damage);
      ctx.onMeleeHit?.(this.config.type, this.x);
      spawnHitSpark(this.x + this.lastAttackDir * this.config.attackRange, this.y - this.config.height * 0.5);
    }
  }

  /**
   * Resolve a queued shotgun blast (shock trooper). When the wind-up lands it
   * strikes EVERY live enemy in a short frontal cone — same horizontal reach as
   * attackRange, within a vertical band of ~config.height — dealing damage and
   * the same viking-style knockback to each. Visual-only timing; no projectile.
   */
  private tickPendingBlast(ctx: UpdateContext) {
    const blast = this.pendingBlast;
    if (!blast) return;
    blast.delay -= ctx.dt;
    if (blast.delay > 0) return;
    this.pendingBlast = null;
    if (this.isDead || blast.damage <= 0) return;   // damage 0 = crit miss → whole blast fizzles

    const dir   = blast.dir;
    const range = this.config.attackRange + this.config.width * 0.5;
    const back  = this.config.width * 0.5;           // allow point-blank / slightly behind
    const vBand = this.config.height;                // same-plane tolerance
    for (const e of ctx.enemies) {
      if (e.isDead) continue;
      const fwd = dir * (e.x - this.x);              // >= 0 when the enemy is in the firing direction
      if (fwd < -back || fwd > range) continue;
      if (Math.abs(e.floorY - this.floorY) > vBand) continue;
      e.takeDamage(blast.damage, this);
      spawnHitSpark(e.x, e.y - e.config.height * 0.5);
      if (this.config.knockback > 0 && !e.isDead) {
        e.applyKnockback(this.config.knockback * dir, ATTACK_KNOCKBACK_VY, ctx.dt, ctx.attackKnockbackDecay);
      }
    }
  }

  private attackEnemy(target: Character, onFire?: (r: FireRequest) => void) {
    if (this.attackTimer > 0) return;
    if (this.pendingMeleeSwing || this.pendingBlast) return;  // wait for the previous swing/blast to land
    const dirSign = Math.sign(target.x - this.x);
    if (dirSign !== 0) this.lastAttackDir = dirSign as 1 | -1;
    const windUp = this.beginAttack();
    const miss   = Math.random() < this.config.critical;
    const damage = miss ? 0 : this.effectiveAtk;
    if (this.config.type === 'shocktrooper') {
      // Shotgun: no projectile — queue a short-range blast that hits EVERY enemy in
      // the frontal cone when the wind-up lands (resolved in tickPendingMeleeSwing).
      this.pendingBlast = { damage, delay: windUp, dir: this.lastAttackDir };
      spawnMuzzleGlow(this.x + this.lastAttackDir * 16, this.bowY, this.lastAttackDir);
    } else if (this.config.type === 'conscript' || this.config.type === 'warrior' || this.config.type === 'viking' || this.config.type === 'knight' || this.config.type === 'heavy') {
      this.pendingMeleeSwing = { target, damage, delay: windUp };
      spawnSlashArc(this.x, this.y - this.config.height * 0.4, this.lastAttackDir, this.side);
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
        // Gun-wielders (rifleman / sniper / tanker) get a muzzle flash that
        // additively lights up the front of the body. Archers don't.
        if (this.projectileKind === 'bullet') {
          spawnMuzzleGlow(this.x + this.lastAttackDir * 18, this.bowY, this.lastAttackDir);
        }
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
    if (this.pendingMeleeSwing) return;  // wait for the previous swing to land
    const dirSign = Math.sign(towerFrontX - this.x);
    if (dirSign !== 0) this.lastAttackDir = dirSign as 1 | -1;
    const windUp = this.beginAttack();
    this.attackTimer = this.config.fireRate;
    if (Math.random() < this.config.critical) return;  // miss â€” silent, towers have no label system
    if (this.config.type === 'shocktrooper') {
      // Short-range shotgun blast on the tower (single target — one swing).
      this.pendingMeleeSwing = { target: null, damage: this.effectiveAtk, delay: windUp, onTower: onDamageTower };
      spawnMuzzleGlow(this.x + this.lastAttackDir * 16, this.bowY, this.lastAttackDir);
    } else if (this.config.type === 'warrior' || this.config.type === 'viking' || this.config.type === 'knight' || this.config.type === 'heavy') {
      this.pendingMeleeSwing = { target: null, damage: this.effectiveAtk, delay: windUp, onTower: onDamageTower };
      spawnSlashArc(this.x, this.y - this.config.height * 0.4, this.lastAttackDir, this.side);
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
        // Gun-wielders only â€” see attackEnemy for rationale.
        if (this.projectileKind === 'bullet') {
          spawnMuzzleGlow(this.x + this.lastAttackDir * 18, this.bowY, this.lastAttackDir);
        }
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
   * always return true â€” they aim freely.
   */
  private canSnapHit(target: Character): boolean {
    const t = this.config.type;
    if (t === 'conscript' || t === 'warrior' || t === 'viking' || t === 'knight' || t === 'heavy' || t === 'grenadier' || t === 'rocketeer' || t === 'shocktrooper') return true;
    // Horizontal-only fire â€” the projectile travels along the shooter's bowY
    // without arcing. A target is hittable only when its collision box
    // vertically spans the bow line (i.e. they're on roughly the same plane).
    return this.bowY >= target.y - target.collisionHeight && this.bowY <= target.y;
  }

  /**
   * Returns the nearest living enemy within `range` px.
   * Ranged characters additionally require an unobstructed line of sight through blocks.
   * Snap-firing types also require the snapped angle to actually land on the target â€”
   * otherwise the bullet would deterministically miss every shot.
   * Enemies more than 30 px below the shooter are excluded â€” projectiles cannot arc
   * downward and melee cannot swing through a platform floor.
   */
  /** `enemies` must already be filtered to characters on the other side. */
  private nearestEnemy(enemies: Character[], range: number, blocks: BlockData[] = []): Character | null {
    let best: Character | null = null;
    let minDistSq = Infinity;
    const rangeSq = range * range;
    for (const t of enemies) {
      if (t.isDead) continue;
      // Skip enemies that are meaningfully below â€” projectiles cannot fire downward,
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

  /** `allies` must already be filtered to characters on the same side (this character will skip itself). */
  private nearestAlly(allies: Character[]): Character | null {
    let best: Character | null = null;
    let minDist = Infinity;
    for (const c of allies) {
      if (c === this || c.isDead) continue;
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

  /** Coin closest to own tower front â€” prioritises easy-to-deposit coins. */
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
