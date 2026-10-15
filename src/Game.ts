import * as PIXI from 'pixi.js';
import Matter from 'matter-js';

export interface CpuStrategyInfo {
  stance:   'push' | 'economy' | 'defend';
  score:    number;   // composite score; positive = CPU winning
  unitAdv:  number;   // cpuStr − playerStr
  towerAdv: number;   // enemy tower ratio − player tower ratio
  coinAdv:  number;   // clamped coin balance delta
  decision: string;   // most recent significant action
}
import { Physics } from './Physics';
import { buildBackground, buildGround, buildTowerRangeMarkers, buildCoinBox, buildParallaxMountains } from './Background';
import { DEFAULT_MAP, loadMapWithOverride, type MapDefinition } from './maps';
import { getTowerTemplate } from './TribeTowerTemplates';
import { loadFittedTexture, unloadSkinTextures } from './SkinTextures';
import { Tower } from './Tower';
import { Character, RANK_NAMES, type CharacterConfig, type FireRequest, type UpdateContext } from './Character';
import { Projectile } from './Projectile';
import { Grenade } from './Grenade';
import { Rocket } from './Rocket';
import { CharacterHUD } from './CharacterHUD';
import { Coin, type CoinKind } from './Coin';
import { PowerUp, type PowerUpType } from './PowerUp';
import { Sheep } from './Sheep';
import { DamageLabel } from './DamageLabel';
import { Platform } from './Platform';
import { Block } from './Block';
import { Decor, DECOR_FRONT_Z } from './Decor';
import { pickName } from './names';
import { getSpriteSet, isSpriteSetReady, loadSpriteSet, setSpriteRenderer } from './SpriteRegistry';
import { tribeForSide, TRIBE_ROSTERS, getPlayerTribe, getEnemyTribe, setPlayerTribe, setEnemyTribe, type Tribe } from './Tribes';
import { getRenderScale } from './resolution';
import type { PlatformData } from './Platform';
import type { BlockData } from './Block';
import type { CollisionBoxData } from './CollisionBox';
import { NavGraph } from './Pathfinding';
import { Diagnostics } from './Diagnostics';
import {
  PLAYER_COLOR, ENEMY_COLOR,
  VIEWPORT_WIDTH, VIEWPORT_HEIGHT, GAME_HEIGHT, GAME_DURATION_SEC, GAME_ZOOM, CAMERA_MAX_PAN_DOWN,
  CAMERA_TOWER_BOTTOM_GAP, TEXTURE_GC_IDLE_SEC, CPU_SPRITE_RETRY_MS,
  TOWER_WIDTH,
  GROUND_Y, TOWER_HEIGHT, TOWER_HP,
  charConfig, charCost, charSpawnCooldown, charIsUnique,
  GRENADE_FUSE_S, GRENADE_SPLASH_R, GRENADE_GRAVITY, GRENADE_MAX_VX, GRENADE_SPLASH_MIN_FRAC,
  GRENADE_KNOCKBACK_MAX_VX, GRENADE_KNOCKBACK_MAX_VY, GRENADE_KNOCKBACK_DECAY, ATTACK_KNOCKBACK_DECAY,
  ROCKET_FUSE_S, ROCKET_SPLASH_R, ROCKET_GRAVITY, ROCKET_LAUNCH_VX, ROCKET_SPLASH_MIN_FRAC,
  ROCKET_HIT_RADIUS, ROCKET_KNOCKBACK_MAX_VX, ROCKET_KNOCKBACK_MAX_VY, ROCKET_KNOCKBACK_DECAY,
  CPU_SPAWN_MIN_MS, CPU_SPAWN_MAX_MS, CPU_FIRST_SPAWN_MAX,
  STARTING_COINS,
  PASSIVE_INCOME_RATE, LOW_BALANCE_THRESHOLD, LOW_BALANCE_INCOME_MULT,
  COIN_VALUE, KILL_REWARD, TOWER_KILL_REWARD, COIN_DROP_MIN_MS, COIN_DROP_MAX_MS,
  COIN_LIFETIME_S,
  BERSERK_DURATION_S, BERSERK_RATE_MULT, BERSERK_COOLDOWN_S, BERSERK_DELAY_MIN_S, BERSERK_DELAY_MAX_S,
  BERSERK_LAUNCH_MIN, BERSERK_LAUNCH_MAX, BERSERK_SPREAD_DEG, BERSERK_SHAKE_AMP, BERSERK_SHAKE_HZ,
  COIN_DROP_VX_MIN, COIN_DROP_VX_MAX, COIN_DROP_VY_MIN, COIN_DROP_VY_MAX,
  COIN_GRAVITY,
  SILVER_COIN_VALUE, SILVER_DROP_MIN_MS, SILVER_DROP_MAX_MS,
  BLUE_COIN_VALUE, BLUE_DROP_MIN_MS, BLUE_DROP_MAX_MS,
  CPU_PRESSURE_THRESHOLD,
  CPU_URGENT_MAX_FACTOR, CPU_COMFORT_MIN_FACTOR,
  CPU_NEUTRAL_MIN_FACTOR, CPU_NEUTRAL_MAX_FACTOR,
  CPU_RETREAT_HP_FRAC, CPU_RETREAT_RECOVER_FRAC, CPU_ENDGAME_SEC,
  CPU_DEFAULT_PROFILE, CPU_SPEND_DOWN_GAP_MS, CPU_REACTIVE_THREAT_DELTA,
  CPU_REACTIVE_MIN_GAP_MS, CPU_REACTIVE_BASELINE_TAU, type CpuProfile,
  CPU_STANCE_PUSH_ENTER, CPU_STANCE_PUSH_EXIT, CPU_STANCE_DEFEND_ENTER, CPU_STANCE_DEFEND_EXIT,
  CPU_STANCE_MIN_DWELL_SEC, CPU_STANCE_SCORE_TAU_SEC, CPU_RETREAT_HP_FRAC_RANGED, CPU_VAL_COUNTER_WEIGHT, CPU_VAL_SAME_TYPE_PENALTY,
  TOWER_ATTACK_RANGE, cpuProfileFeatures, type CpuFeature,
  WAVE_STAGE_OFFSET, WAVE_TANK_LEAD, WAVE_TANK_THRESHOLD, WAVE_MIN_UNITS, WAVE_MAX_HOLD_SEC,
  RUNNERS_OPENING, RUNNERS_OPENING_SEC, RUNNERS_ECONOMY, RUNNERS_PUSH, RUNNERS_DEFEND,
  RUNNERS_BERSERK_BONUS, RUNNERS_MAX,
  TRIBE_PU_COOLDOWN_SEC, TRIBE_PU_DURATION_SEC, TRIBE_PU_SPEED_MULT, TRIBE_PU_HEAL_PER_SEC,
  TRIBE_PU_PLAGUE_DAMAGE, TRIBE_PU_PLAGUE_TICKS, TRIBE_PU_PLAGUE_INTERVAL, TRIBE_PU_AGGRESSION_MULT,
  TRIBE_PU_PLAYER_DEFAULT, TRIBE_PU_IDS, TRIBE_POWER_UPS, type TribePowerUpId,
  CPU_VAL_RANGE_DIVISOR, CPU_VAL_HP_DIVISOR, CPU_VAL_SPLASH_PUSH_MULT, CPU_VAL_THREAT_NORM,
  POWERUP_DROP_INTERVAL, POWERUP_INDICATOR_LEAD, POWERUP_BODY_RADIUS,
  CHEAT_PLAYER_COIN_GRANT, CHEAT_CPU_COIN_GRANT,
  SHAKE_DECAY, SHAKE_MAX_OFFSET, SHAKE_GRENADE, SHAKE_ROCKET, SHAKE_FALLOFF_PX,
} from './constants';
import { playSoundAt, setViewport } from './AudioManager';
import { initVfx, initAfterImageLayer, tickVfx, clearVfx, spawnHitSpark, spawnExplosion, spawnDeathBurst } from './Vfx';

function spawnBoost(): number {
  return Math.min(Math.floor(Math.random() * 11), Math.floor(Math.random() * 11));
}

function withSpawnBoosts(cfg: CharacterConfig): CharacterConfig {
  return {
    ...cfg,
    hp:          cfg.hp          + spawnBoost(),
    speed:       cfg.speed       + spawnBoost(),
    attackRange: cfg.attackRange + spawnBoost(),
    attackPower: cfg.attackPower + spawnBoost(),
  };
}

const PARALLAX_FACTOR     = 0.15; // near background scrolls at 15 % of world camera speed
const PARALLAX_FACTOR_FAR = 0.05; // far background scrolls at 5 % — feels more distant

/** Seconds until the coin box next goes berserk: an optional cooldown plus a
 *  random wait, so players can't set a watch by it. */
function berserkDelay(afterCooldown: boolean): number {
  return (afterCooldown ? BERSERK_COOLDOWN_S : 0)
    + BERSERK_DELAY_MIN_S + Math.random() * (BERSERK_DELAY_MAX_S - BERSERK_DELAY_MIN_S);
}

/** Per-tribe cache for Game.runnerType. */
const runnerTypeCache = new Map<Tribe, CharacterConfig['id']>();

/** Close-combat styles — the units that form walls and waves (never type names). */
const isMeleeStyle = (c: Character): boolean =>
  c.config.attackStyle === 'melee' || c.config.attackStyle === 'blast';

/** Attribute-derived CPU valuation of a unit type — see Game.unitProfile(). */
interface UnitProfile {
  cost:     number;
  combat:   number;  // sqrt(sustained DPS × hp) — overall strength
  reach:    number;  // 1 + attackRange/CPU_VAL_RANGE_DIVISOR — standoff bonus
  tanky:    number;  // 1 + hp/CPU_VAL_HP_DIVISOR — frontline bonus
  splash:   boolean; // fires an AoE projectile (grenade/rocket)
  threat:   number;  // combat×reach normalized so a baseline warrior ≈ 1.0
  canFight: boolean; // attackPower > 0 (excludes pure-support types)
}
const unitProfileCache = new Map<string, UnitProfile>();

export class Game {
  readonly app: PIXI.Application;

  private parallaxGfx!:  PIXI.Container;
  private parallaxGfx2!: PIXI.Container;
  private rangeMarkers!: PIXI.Container;
  private devMode = false;
  private playerTower!: Tower;
  private enemyTower!:  Tower;
  // Cached tower AABBs, populated in build(). Both sides have identical shape
  // and are stable for the lifetime of the map, so rocket / AoE hot paths
  // read these instead of recomputing 4 subtractions per call.
  private playerTowerAABB!: { left: number; right: number; top: number; bottom: number };
  private enemyTowerAABB!:  { left: number; right: number; top: number; bottom: number };
  private characters:   Character[]  = [];
  private projectiles:  Projectile[] = [];
  private grenades:     Grenade[]    = [];
  private rockets:      Rocket[]     = [];
  private coins:        Coin[]       = [];
  private powerUps:     PowerUp[]    = [];
  private sheep:        Sheep | null = null;
  private unitLayer!:    PIXI.Container;
  private projLayer!:    PIXI.Container;
  private grenadeLayer!: PIXI.Container;
  private rocketLayer!:  PIXI.Container;
  private coinLayer!:    PIXI.Container;
  private sheepLayer!:   PIXI.Container;
  private powerUpLayer!: PIXI.Container;
  private vfxLayer!:     PIXI.Container;
  private labelLayer!:   PIXI.Container;
  private ricochetLayer!: PIXI.Container;  // shield-deflected projectiles — above units, labels, and towers
  private afterImageLayer!: PIXI.Container;  // speed-boost ghost trails — renders behind characters
  private frontDecorLayer!: PIXI.Container;  // decor with z >= DECOR_FRONT_Z — renders in front of characters
  private decorObjects:  Decor[]      = [];
  private damageLabels:  DamageLabel[] = [];

  private powerUpTimer    = 0;
  private readonly powerUpInterval = POWERUP_DROP_INTERVAL * 1000;

  // Drop indicator (screen-space)
  private powerUpIndicatorContainer!: PIXI.Container;
  private powerUpIndicatorGfx!:       PIXI.Graphics;
  private powerUpIndicatorText!:      PIXI.Text;
  private powerUpIndicatorActive      = false;
  private powerUpIndicatorX           = 0;
  private powerUpIndicatorTargetX     = 0;
  private powerUpIndicatorMoveTimer   = 0;
  private powerUpTypePreview: PowerUpType = 'heal';
  private powerUpLastCountdown        = -1;
  private mapDef:        MapDefinition = loadMapWithOverride(DEFAULT_MAP);
  private mapAssetUrls   = new Set<string>();  // skin textures the current scene may load — evicted on map switch, see reset()
  private platforms:     Platform[]    = [];
  private readonly platformData: PlatformData[] = [];
  private blocks:        Block[]       = [];
  // Parallel to `blocks` — Matter body for each block, so tickBlocks can
  // setPosition on the body each tick when the block animates.
  private blockBodies:   Matter.Body[] = [];
  private readonly blockData:    BlockData[]    = [];
  private physics!:      Physics;

  private world!:     PIXI.Container;
  private cameraX  = 0;
  private cameraY  = 0;
  // Default resting vertical scroll — anchors the player tower's bottom
  // CAMERA_TOWER_BOTTOM_GAP screen px above the canvas bottom. Computed in
  // build() (depends on the map's ground/tower Y) and reused by the pan clamp.
  private restCameraY = 0;
  // Screen shake — `trauma` (0..1) is added by blasts and bled off each tick;
  // the applied offset scales with trauma² so small hits barely register and
  // big ones punch. `shakeTime` drives the oscillation.
  private shakeTrauma = 0;
  private shakeTime   = 0;
  private readonly keysDown = new Set<string>();

  private navGraph!: NavGraph;

  readonly diagnostics = new Diagnostics();

  private get mapDurationSec(): number { return this.mapDef.durationSec ?? GAME_DURATION_SEC; }

  get currentMapId(): string   { return this.mapDef.id; }
  get elapsedSeconds(): number { return this.mapDurationSec - this.timeRemaining; }

  // Collision-box debug overlay (toggled with 'B')
  private collisionDebugLayer!: PIXI.Graphics;
  private showCollisionBoxes   = false;
  private staticCollisionBoxes: CollisionBoxData[] = [];

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.keysDown.add(e.key);
    }
    if (e.key === 'b' || e.key === 'B') {
      this.showCollisionBoxes = !this.showCollisionBoxes;
      this.collisionDebugLayer.visible = this.showCollisionBoxes;
    }
    if (e.key === 'k' || e.key === 'K') {
      this.coinBalance += CHEAT_PLAYER_COIN_GRANT;
      this.notifyCoins();
      this.diagnostics.noteEvent(this.elapsedSeconds, `Cheat K: player +${CHEAT_PLAYER_COIN_GRANT}`, {
        playerTotal: Math.floor(this.coinBalance),
        cpuTotal:    Math.floor(this.cpuCoinBalance),
      });
    }
    if (e.key === 'l' || e.key === 'L') {
      this.cpuCoinBalance += CHEAT_CPU_COIN_GRANT;
      this.notifyCpuCoins();
      this.diagnostics.noteEvent(this.elapsedSeconds, `Cheat L: CPU +${CHEAT_CPU_COIN_GRANT}`, {
        playerTotal: Math.floor(this.coinBalance),
        cpuTotal:    Math.floor(this.cpuCoinBalance),
      });
    }
    if (e.key === 'j' || e.key === 'J') {
      // Small chance of blue, matching the natural in-game odds that a freshly
      // dropped coin is blue: each kind drops on its own timer, so blue's share is
      // its rate / total rate (rate = 1 / average interval). ~3.8% with current config.
      const rate = (min: number, max: number) => 2 / (min + max);
      const blueRate = rate(BLUE_DROP_MIN_MS, BLUE_DROP_MAX_MS);
      const blueChance = blueRate /
        (rate(COIN_DROP_MIN_MS, COIN_DROP_MAX_MS) + rate(SILVER_DROP_MIN_MS, SILVER_DROP_MAX_MS) + blueRate);
      const blue = Math.random() < blueChance;
      this.spawnCoin(blue ? BLUE_COIN_VALUE : COIN_VALUE, blue ? 'blue' : 'gold');
      this.resetCoinDropTimer();
      this.diagnostics.noteEvent(this.elapsedSeconds, `Cheat J: forced ${blue ? 'blue' : 'gold'} coin drop`);
    }
  };
  private readonly onKeyUp = (e: KeyboardEvent) => { this.keysDown.delete(e.key); };

  // ── Mouse-drag camera pan ──────────────────────────────────────────────
  // Click-and-drag the canvas to move the map. Active during play and after
  // game over (tick keeps running so camera updates apply). Works alongside
  // ArrowLeft / ArrowRight which adjust cameraX directly each frame.
  private isDragging          = false;
  private dragStartClientX    = 0;
  private dragStartClientY    = 0;
  private dragStartCameraX    = 0;
  private dragStartCameraY    = 0;
  private dragCssScale        = 1;   // on-screen px per logical px, snapshotted at drag start

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;   // primary button only — don't fight right-click menus
    this.isDragging       = true;
    this.dragStartClientX = e.clientX;
    this.dragStartClientY = e.clientY;
    this.dragStartCameraX = this.cameraX;
    this.dragStartCameraY = this.cameraY;
    // The canvas is CSS-scaled to fit the window (fitGameToWindow), so 1 screen
    // px ≠ 1 logical px. Snapshot the scale once here (it can't change mid-drag,
    // only on resize) instead of forcing a layout reflow every pointermove.
    const c = this.app.view as HTMLCanvasElement;
    const rect = c.getBoundingClientRect();
    this.dragCssScale = rect.width > 0 ? rect.width / VIEWPORT_WIDTH : 1;
    c.style.cursor = 'grabbing';
    c.setPointerCapture?.(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.isDragging) return;
    // Inverse drag: dragging the map right/down (positive dx/dy) should shift
    // the camera left/up so the user feels they're sliding the world. Divide by
    // the snapshotted on-screen scale and by GAME_ZOOM so 1 screen px maps to 1 world px.
    const dx = (e.clientX - this.dragStartClientX) / this.dragCssScale;
    const dy = (e.clientY - this.dragStartClientY) / this.dragCssScale;
    this.cameraX = this.dragStartCameraX - dx / GAME_ZOOM;
    this.cameraY = this.dragStartCameraY + dy / GAME_ZOOM;
    // tick() runs the clamp on every frame, so we don't need to clamp here.
  };

  private readonly onPointerUp = () => {
    if (!this.isDragging) return;
    this.isDragging = false;
    (this.app.view as HTMLCanvasElement).style.cursor = 'grab';
  };

  private nextCharId  = 1;
  private freeCharIds: number[] = [];

  private coinBalance            = STARTING_COINS;
  private cpuCoinBalance         = STARTING_COINS;
  private lastNotifiedCoins      = -1;
  private lastNotifiedCpuCoins   = -1;
  private cpuSpawnTimer       = 0;
  private cpuSpawnInterval = 0;
  private coinDropTimer         = 0;
  private coinDropInterval      = 0;
  private silverDropTimer       = 0;
  private silverDropInterval    = 0;
  private blueDropTimer         = 0;
  private blueDropInterval      = 0;
  // Coin box berserk (see tickBerserk): seconds of the current burst left
  // (0 = idle), seconds until the next one, and the box art being shaken.
  private berserkRemaining      = 0;
  private berserkTimer          = berserkDelay(false);
  private berserkPhase          = 0;
  private coinBoxVisual: PIXI.Container | null = null;
  private isOver           = false;
  private isPaused         = false;

  // ── Purchase cooldowns (both sides) ───────────────────────────────────────
  // Per side: type → game-time (elapsedSeconds) at which the type can be
  // bought again, and the length of that lockout so the player's card can
  // draw a 0→1 recharge sweep. Armed on every buy (spawnPlayer / spawnCpuUnit)
  // and for both rosters at match start.
  private spawnReadyAt     = { player: new Map<string, number>(), enemy: new Map<string, number>() };
  private spawnCooldownLen = { player: new Map<string, number>(), enemy: new Map<string, number>() };

  // ── Match statistics (surfaced on the game-over screen) ──────────────────
  // Every enemy-side death counts as a player kill (all damage an enemy unit
  // can take is player-sourced) and vice versa.
  private matchStats = {
    playerKills:        0,   // enemy characters killed
    playerDeaths:       0,   // player characters lost
    playerSpawns:       0,   // characters the player fielded
    playerSpawnsByType: {} as Record<string, number>,
  };

  private readonly hud:               CharacterHUD;
  private readonly onGameOver:         (winner: 'player' | 'enemy', reason: 'tower' | 'timeout') => void;
  private readonly onCoinsChanged:     (amount: number) => void;
  private readonly onCpuCoinsChanged:  (amount: number) => void;
  private readonly onCpuCharsChanged:    (chars: { id: number; name: string; type: string; behavior: string }[]) => void;
  private readonly onCpuStrategyChanged: (info: CpuStrategyInfo) => void;
  private readonly onTimeChanged:        (seconds: number) => void;
  private readonly onEnemyTowerHpChanged:  (hp: number, maxHp: number) => void;
  private readonly onPlayerTowerHpChanged: (hp: number, maxHp: number) => void;
  private readonly onCoinBoxBerserk:       () => void;
  private readonly tickFn:               (dt: number) => void;

  private lastCpuCharsSig     = '';
  private lastCpuStrategySig  = '';
  private cpuStance: 'push' | 'economy' | 'defend' = 'economy';
  private playerStance: 'push' | 'economy' | 'defend' = 'economy';
  // Endgame all-in: set by assessCpuStance when the clock is inside
  // CPU_ENDGAME_SEC and the side is losing on tower HP. Behavior AI sends
  // EVERY unit to 'attacking' (no harass split, no retreats) and collect AI
  // recalls collectors — tower damage is the only thing that matters now.
  private cpuAllIn    = false;
  private playerAllIn = false;
  // Per-side decision profile — 'legacy' disables the tempo features
  // (spend-down follow-up buys, reactive spawn) so self-play can A/B them.
  // Persists across reset() so a harness can assign sides per match.
  private cpuProfiles: Record<'player' | 'enemy', CpuProfile> = {
    player: CPU_DEFAULT_PROFILE, enemy: CPU_DEFAULT_PROFILE,
  };
  private cpuFeatures: Record<'player' | 'enemy', ReadonlySet<CpuFeature>> = {
    player: cpuProfileFeatures(CPU_DEFAULT_PROFILE), enemy: cpuProfileFeatures(CPU_DEFAULT_PROFILE),
  };
  // Reactive spawn: the opponent's live field threat (from assessCpuStance)
  // and a slowly-relaxing baseline of it. A rise of CPU_REACTIVE_THREAT_DELTA
  // above the baseline — the player dumping their bank — triggers a buy now
  // instead of at the next timer tick.
  private oppThreat         = { player: 0, enemy: 0 };
  private oppThreatBaseline = { player: 0, enemy: 0 };
  // Match time (s) at which each side last changed stance — the hysteresis dwell.
  private stanceSince       = { player: 0, enemy: 0 };
  // EMA of the stance score per side (null until the first assessment).
  private scoreEma:      Record<'player' | 'enemy', number | null> = { player: null, enemy: null };
  private scoreTotalEma: Record<'player' | 'enemy', number | null> = { player: null, enemy: null };
  // Wave staging state per side (see tickWaveStaging): units already released
  // this push (they charge straight in) and when the current wave's first
  // unit reached the line.
  private readonly wave = {
    player: { released: new Set<Character>(), holdSince: null as number | null },
    enemy:  { released: new Set<Character>(), holdSince: null as number | null },
  };
  // Dedicated coin runners per side ('coinRunners'): always 'collecting',
  // exempt from the stance collector cap, re-bought when they die.
  private readonly runners = { player: new Set<Character>(), enemy: new Set<Character>() };
  // Dev: simulation steps per clock tick (>1 = fixed 60 Hz steps, used by the
  // self-play harness to run whole matches in seconds). While fast-forwarding
  // the clock is a Worker interval, not the rAF ticker: Chrome throttles rAF
  // and main-thread timers to 1 Hz when the tab is hidden or the window is
  // covered, which stalled a self-play run the moment the user alt-tabbed
  // away. Worker timers are exempt, so the batch keeps stepping; the ticker
  // then only renders whatever frames the browser still grants.
  private fastForward = 1;
  private ffWorker: Worker | null = null;
  // Power-up fetch assignments: one fetcher per settled power-up (first CPU
  // side to claim wins). Validated each collect-AI tick — entries drop when
  // the power-up is taken/expired or the fetcher dies.
  private readonly puFetchers = new Map<PowerUp, Character>();
  // ── Tribe power-ups ────────────────────────────────────────────────────────
  // One ability per side per match, manually triggered, 30 s cooldown. The
  // player's pick survives reset() (it's a meta choice from the squad screen);
  // the CPU re-picks each match in reset().
  private playerTribePU: TribePowerUpId = TRIBE_PU_PLAYER_DEFAULT;
  private cpuTribePU:    TribePowerUpId = TRIBE_PU_IDS[Math.floor(Math.random() * TRIBE_PU_IDS.length)];
  private playerTribePUCooldown = 0;   // seconds until re-usable (0 = ready)
  private cpuTribePUCooldown    = 0;
  // Vitality is a lasting effect — remaining seconds of the heal-over-time aura.
  private playerVitalityTimer = 0;
  private cpuVitalityTimer    = 0;
  // AI combat units currently retreating to heal (low HP). WeakSet so dead units
  // are GC'd automatically without manual cleanup.
  private readonly retreatingUnits = new WeakSet<Character>();
  private playerSpawnTimer    = 0;
  private playerSpawnInterval = 0;
  private cpuVsCpu            = false;
  private gameShark           = false;
  // Dev override: when set, the CPU (enemy) buys this unit type every spawn,
  // bypassing the stance-driven AI order. null = normal AI behavior.
  private cpuForcedType: CharacterConfig['id'] | null = null;
  private timeRemaining    = this.mapDurationSec;
  private lastNotifiedTime = -1;
  private cpuStrategyInfo: CpuStrategyInfo = {
    stance: 'economy', score: 0, unitAdv: 0, towerAdv: 0, coinAdv: 0, decision: '—',
  };
  private lastNotifiedEnemyTowerHp  = -1;
  private lastNotifiedPlayerTowerHp = -1;

  // Reusable arrays rebuilt each tick — avoids per-tick filter() allocations
  private readonly liveChars:  Character[] = [];
  private readonly playerLive: Character[] = [];
  private readonly enemyLive:  Character[] = [];
  private readonly liveCoins:  Coin[]      = [];

  // Reusable UpdateContext objects — one per side, mutated each tick to avoid
  // allocating a new object + 3 closures per character per frame.
  private playerCtx!: UpdateContext;
  private enemyCtx!:  UpdateContext;
  // Set immediately before c.update(ctx) so deposit/fire closures can reference the current char.
  private updateChar!: Character;

  // Throttle timers (ms)
  private notifyCpuCharsMs    = 0;
  private notifyCpuStrategyMs = 0;
  private cpuStanceMs         = 0;
  // Throttle for tickCpuCollectAI — runs at ~4 Hz instead of every frame.
  // Collector reassignment decisions don't need 60 Hz precision; carrying
  // collectors still tick their behavior every frame, so the throttle only
  // affects the assign/recall switches.
  private cpuCollectAIMs      = 0;
  private cullingFrame        = 0;

  // Performance: cached values recomputed at lower frequency than 60 fps
  private mapGroundY               = GROUND_Y;  // per-map ground surface Y; set in build()
  private cachedLowestPlatY        = GROUND_Y;  // lowest platform top; set in build()
  private cachedEnemyOppClustered  = false;      // player chars clustered; updated with stance
  private cachedPlayerOppClustered = false;      // enemy chars clustered (cpuVsCpu only)
  private navGraphRebuildTimer     = 0;          // ms since last rebuild; throttles animated-block rebuilds

  constructor(
    canvas:              HTMLCanvasElement,
    hudEl:               HTMLElement,
    onGameOver:          (winner: 'player' | 'enemy', reason: 'tower' | 'timeout') => void,
    onCoinsChanged:      (amount: number) => void,
    onCpuCoinsChanged:   (amount: number) => void,
    onCpuCharsChanged:    (chars: { id: number; name: string; type: string; behavior: string }[]) => void,
    onCpuStrategyChanged: (info: CpuStrategyInfo) => void,
    onTimeChanged:        (seconds: number) => void,
    onEnemyTowerHpChanged:  (hp: number, maxHp: number) => void,
    onPlayerTowerHpChanged: (hp: number, maxHp: number) => void,
    onCoinBoxBerserk:       () => void = () => {},
  ) {
    this.onGameOver              = onGameOver;
    this.onCoinsChanged          = onCoinsChanged;
    this.onCpuCoinsChanged       = onCpuCoinsChanged;
    this.onCpuCharsChanged       = onCpuCharsChanged;
    this.onCpuStrategyChanged    = onCpuStrategyChanged;
    this.onTimeChanged           = onTimeChanged;
    this.onEnemyTowerHpChanged   = onEnemyTowerHpChanged;
    this.onPlayerTowerHpChanged  = onPlayerTowerHpChanged;
    this.onCoinBoxBerserk        = onCoinBoxBerserk;
    this.hud            = new CharacterHUD(hudEl);
    this.tickFn         = (_dt) => {
      if (this.fastForward > 1) return;   // the fast-forward worker is stepping
      this.tick(this.app.ticker.deltaMS);
    };

    this.app = new PIXI.Application({
      view: canvas,
      width:  VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      resolution: getRenderScale(),  // backing-store density from the resolution setting
      autoDensity: true,             // keep the canvas's displayed CSS size at the logical size
      backgroundColor: 0x87ceeb,
      antialias: false,
    });

    // Sprite atlases only reach the GPU when first drawn; drop the GPU copy of
    // any base texture that hasn't been drawn for TEXTURE_GC_IDLE_SEC (an
    // enemy roster type the AI never buys, an anim nobody is playing). PIXI
    // re-uploads from the resident bitmap on the next draw. Default is 1 hour.
    const renderer = this.app.renderer;
    if ('textureGC' in renderer) {
      (renderer as PIXI.Renderer).textureGC.maxIdle = TEXTURE_GC_IDLE_SEC * 60;   // measured in frames
    }
    setSpriteRenderer(renderer);   // sprite atlases upload to the GPU as they're packed

    // Seed tribes from the initial map's defaults so build() reads the
    // correct tribe for each side. Mirrors the same logic in reset().
    setPlayerTribe(this.mapDef.playerTowerTribe ?? 'kattgard');
    setEnemyTribe(this.mapDef.enemyTowerTribe   ?? 'lapinor');

    this.build();
    this.mapAssetUrls = this.collectMapAssetUrls();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup',   this.onKeyUp);

    // Mouse-drag camera pan — listen on the canvas for the down event so a
    // drag that starts outside the canvas (e.g. on a HUD button) doesn't
    // accidentally pan; listen on window for move/up so a drag that leaves
    // the canvas still tracks until release.
    const canvasEl = this.app.view as HTMLCanvasElement;
    canvasEl.style.cursor = 'grab';
    canvasEl.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove',   this.onPointerMove);
    window.addEventListener('pointerup',     this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.resetSpawnTimerFirst('enemy');
    if (this.cpuVsCpu) this.resetSpawnTimerFirst('player');
    this.resetCoinDropTimer();
    this.resetSilverDropTimer();
    this.resetBlueDropTimer();
    this.app.ticker.add(this.tickFn);

    this.notifyCoins();
    this.notifyCpuCoins();
    this.notifyEnemyTowerHp();
    this.notifyPlayerTowerHp();
    this.onTimeChanged(this.mapDurationSec);
  }

  // ── Scene construction ───────────────────────────────────────────────────────

  private build() {
    const m = this.mapDef;
    this.mapGroundY = (m.worldHeight ?? GAME_HEIGHT) - (m.groundHeight ?? (GAME_HEIGHT - GROUND_Y));
    // Default vertical scroll: place the player tower's bottom (baseY)
    // CAMERA_TOWER_BOTTOM_GAP screen px above the canvas bottom. The base term
    // matches the ground anchor; the (mapGroundY − towerBaseY) correction keeps
    // the gap tied to the tower even when it sits on an elevated block.
    const playerTowerBaseY = m.playerTowerY ?? this.mapGroundY;
    this.restCameraY = (VIEWPORT_HEIGHT - CAMERA_TOWER_BOTTOM_GAP - this.mapGroundY) / GAME_ZOOM
                     + (this.mapGroundY - playerTowerBaseY);
    this.cameraY = this.restCameraY;
    const towerFaceL = m.playerTowerX + TOWER_WIDTH / 2;
    const towerFaceR = m.enemyTowerX  - TOWER_WIDTH / 2;

    this.world = new PIXI.Container();

    buildBackground(this.world, m.worldWidth);
    this.rangeMarkers = buildTowerRangeMarkers(this.world, m.playerTowerX, m.enemyTowerX);
    this.rangeMarkers.visible = this.devMode;
    this.coinBoxVisual = buildCoinBox(this.world, m.coinBox);

    // Scene-prop layer: platforms, blocks, and behind-character decor all share
    // ONE sortable container so their zIndex values order them in a single
    // space (matches the map builder's preview). Decor flagged "in front of
    // characters" (zIndex >= DECOR_FRONT_Z) is routed to frontDecorLayer below.
    const sceneLayer = new PIXI.Container();
    sceneLayer.sortableChildren = true;
    this.world.addChild(sceneLayer);

    // Build one Platform visual per map platform.
    this.platforms = m.platforms.map(p => new Platform(p));
    this.platformData.length = 0;
    for (const plat of this.platforms) {
      this.platformData.push(plat.data);
      sceneLayer.addChild(plat.container);
    }
    this.cachedLowestPlatY = this.platformData.reduce((minY, p) => Math.min(minY, p.y), this.mapGroundY);
    this.navGraphRebuildTimer = 0;

    // Build one Block visual per map block — same shared scene layer.
    this.blocks = m.blocks.map(b => new Block(b));
    this.blockData.length = 0;
    for (const blk of this.blocks) {
      this.blockData.push(blk.data);
      sceneLayer.addChild(blk.container);
    }

    this.physics = new Physics(m.worldWidth, m.playerTowerX, m.enemyTowerX, m.platforms, this.mapGroundY);
    this.blockBodies.length = 0;
    for (const blk of this.blocks) {
      const body = this.physics.createBlockBody(blk.data.x, blk.data.y, blk.data.width, blk.data.height);
      this.blockBodies.push(body);
    }

    this.coinLayer     = new PIXI.Container();
    this.sheepLayer    = new PIXI.Container();
    this.powerUpLayer  = new PIXI.Container();
    this.projLayer     = new PIXI.Container();
    this.grenadeLayer  = new PIXI.Container();
    this.rocketLayer   = new PIXI.Container();
    this.afterImageLayer = new PIXI.Container();  // behind characters — speed-boost ghosts
    this.unitLayer     = new PIXI.Container();
    this.vfxLayer      = new PIXI.Container();
    this.labelLayer    = new PIXI.Container();
    this.world.addChild(this.coinLayer);
    this.world.addChild(this.sheepLayer);
    this.world.addChild(this.powerUpLayer);
    this.world.addChild(this.projLayer);
    this.world.addChild(this.grenadeLayer);
    this.world.addChild(this.rocketLayer);
    this.world.addChild(this.afterImageLayer);
    this.world.addChild(this.unitLayer);
    // Foreground decor (zIndex >= DECOR_FRONT_Z) — renders above characters but below VFX/labels.
    this.frontDecorLayer = new PIXI.Container();
    this.frontDecorLayer.sortableChildren = true;
    this.world.addChild(this.frontDecorLayer);
    this.world.addChild(this.vfxLayer);
    this.world.addChild(this.labelLayer);
    initVfx(this.vfxLayer);
    initAfterImageLayer(this.afterImageLayer);

    // Decor objects — no physics body, not in the nav graph (collision-free).
    // zIndex >= DECOR_FRONT_Z → frontDecorLayer (in front of characters); otherwise
    // it sorts in the shared scene layer alongside platforms & blocks (behind characters).
    this.decorObjects = (m.decor ?? []).map(d => new Decor(d));
    for (const dec of this.decorObjects) {
      const layer = (dec.data.zIndex ?? 0) >= DECOR_FRONT_Z ? this.frontDecorLayer : sceneLayer;
      layer.addChild(dec.container);
    }

    this.playerTower = new Tower('player', m.playerTowerX, m.playerTowerY ?? this.mapGroundY, getPlayerTribe());
    this.enemyTower  = new Tower('enemy',  m.enemyTowerX,  m.enemyTowerY  ?? this.mapGroundY, getEnemyTribe());
    this.world.addChild(this.playerTower.container);
    this.world.addChild(this.enemyTower.container);
    // Ricochets sit above everything in play (including the towers, which are
    // added after the labels) so a deflected shot is never hidden mid-flight.
    this.ricochetLayer = new PIXI.Container();
    this.world.addChild(this.ricochetLayer);
    const towerTop = this.mapGroundY - TOWER_HEIGHT;
    this.playerTowerAABB = {
      left:  m.playerTowerX - TOWER_WIDTH / 2,
      right: m.playerTowerX + TOWER_WIDTH / 2,
      top:   towerTop,
      bottom: this.mapGroundY,
    };
    this.enemyTowerAABB = {
      left:  m.enemyTowerX - TOWER_WIDTH / 2,
      right: m.enemyTowerX + TOWER_WIDTH / 2,
      top:   towerTop,
      bottom: this.mapGroundY,
    };

    // Navigation graph — built from current platforms; rebuild whenever map changes.
    this.navGraph = new NavGraph();
    this.navGraph.build(this.platformData, m.playerTowerX, m.enemyTowerX, this.blockData, this.mapGroundY);

    // Tower physics bodies — solid, block character movement.
    this.physics.createTowerBody(this.playerTower.collisionCenterX, this.playerTower.collisionWidth);
    this.physics.createTowerBody(this.enemyTower.collisionCenterX,  this.enemyTower.collisionWidth);

    // Register static collision boxes for the debug overlay. Towers read
    // their rect from the active tribe template so the outline reflects
    // whatever the user configured in the Tribe Tower Skins modal.
    const pCol = this.playerTower.collisionRect;
    const eCol = this.enemyTower.collisionRect;
    this.staticCollisionBoxes = [
      {
        x: pCol.x, y: pCol.y,
        width: pCol.w, height: pCol.h,
        type: 'solid', label: 'Player Tower',
      },
      {
        x: eCol.x, y: eCol.y,
        width: eCol.w, height: eCol.h,
        type: 'solid', label: 'Enemy Tower',
      },
      // Platforms and blocks intentionally excluded — they're drawn live in
      // drawCollisionDebug() so animated surfaces' overlay follows the body.
      {
        x: m.coinBox.x - m.coinBox.width / 2, y: m.coinBox.y,
        width: m.coinBox.width, height: m.coinBox.height,
        type: 'passthrough' as const, label: 'Coin Box',
      },
    ];

    // Ground plane — sorts within the shared scene z-space (platforms/blocks/
    // decor) via groundZ, so decor can be layered in front of or behind it.
    const groundContainer = buildGround(sceneLayer, m.worldWidth, m.groundSkin, m.groundSkinTileW, m.groundSkinTileH, this.mapGroundY, m.worldHeight ?? GAME_HEIGHT);
    groundContainer.zIndex = m.groundZ ?? 0;

    // Debug overlay — drawn on top of everything in world space.
    this.collisionDebugLayer = new PIXI.Graphics();
    this.collisionDebugLayer.visible = false;
    this.world.addChild(this.collisionDebugLayer);

    // Zoom: scale the whole world container; anchor world.y so the map ground
    // surface stays at a fixed screen position, keeping the horizon visually stable.
    this.world.scale.set(GAME_ZOOM);
    this.world.y = this.mapGroundY * (1 - GAME_ZOOM) + this.cameraY * GAME_ZOOM;

    // Parallax backdrop layers — both sit on app.stage before the world so they
    // render behind all world content.  Width covers the viewport plus the
    // maximum horizontal shift each layer can reach at full camera travel.
    const maxCameraX    = m.worldWidth - VIEWPORT_WIDTH / GAME_ZOOM;
    const parallaxWide  = Math.ceil(VIEWPORT_WIDTH + maxCameraX * PARALLAX_FACTOR);
    const parallaxWide2 = Math.ceil(VIEWPORT_WIDTH + maxCameraX * PARALLAX_FACTOR_FAR);

    // Far layer (behind everything) — optional image, no procedural fallback.
    this.parallaxGfx2 = new PIXI.Container();
    if (m.backgroundSkin2) {
      loadFittedTexture(m.backgroundSkin2, parallaxWide2, m.backgroundSkin2H ?? this.mapGroundY, false)
        .then(tex => {
          const sprite = new PIXI.Sprite(tex);
          sprite.y      = m.backgroundSkin2Y ?? 0;
          sprite.width  = parallaxWide2;
          sprite.height = m.backgroundSkin2H ?? this.mapGroundY;
          this.parallaxGfx2.addChild(sprite);
        })
        .catch(err => console.warn('[map] far background skin failed to load — layer skipped', err));
    }
    this.app.stage.addChild(this.parallaxGfx2);

    // Near layer — image skin or procedural mountains.
    this.parallaxGfx = new PIXI.Container();
    if (m.backgroundSkin) {
      loadFittedTexture(m.backgroundSkin, parallaxWide, m.backgroundSkinH ?? this.mapGroundY, false)
        .then(tex => {
          const sprite = new PIXI.Sprite(tex);
          sprite.y      = m.backgroundSkinY ?? 0;
          sprite.width  = parallaxWide;
          sprite.height = m.backgroundSkinH ?? this.mapGroundY;
          this.parallaxGfx.addChild(sprite);
        })
        .catch(err => {
          console.warn('[map] background skin failed to load — using procedural mountains', err);
          this.parallaxGfx.addChild(buildParallaxMountains(parallaxWide));
        });
    } else {
      this.parallaxGfx.addChild(buildParallaxMountains(parallaxWide));
    }
    this.app.stage.addChild(this.parallaxGfx);

    this.app.stage.addChild(this.world);

    // Sheep — spawns at a random x within the playable field
    const sheepLeft  = towerFaceL + 150;
    const sheepRight = towerFaceR - 150;
    const sheepX     = sheepLeft + Math.random() * (sheepRight - sheepLeft);
    this.sheep = new Sheep(sheepX, this.physics, towerFaceL, towerFaceR);
    this.sheepLayer.addChild(this.sheep.container);

    // World-space drop indicator (moves across the map, above all other layers)
    this.powerUpIndicatorContainer = new PIXI.Container();
    this.powerUpIndicatorGfx       = new PIXI.Graphics();
    this.powerUpIndicatorText       = new PIXI.Text('', {
      fontFamily: 'Arial Black, Arial',
      fontSize:   20,
      fontWeight: 'bold',
      fill:       0xffffff,
      align:      'center',
      stroke:     0x000000,
      strokeThickness: 3,
    } as Partial<PIXI.ITextStyle>);
    this.powerUpIndicatorText.anchor.set(0.5, 0.5);
    this.powerUpIndicatorText.y = 28;
    this.powerUpIndicatorContainer.addChild(this.powerUpIndicatorGfx);
    this.powerUpIndicatorContainer.addChild(this.powerUpIndicatorText);
    this.powerUpIndicatorContainer.y   = 5;   // fixed at top of screen
    this.powerUpIndicatorContainer.visible = false;
    this.app.stage.addChild(this.powerUpIndicatorContainer);  // screen space — sticks to camera top

    // Pre-build one UpdateContext per side. Stable fields are set here; dt and
    // tower frontX/Y values are patched each tick — no per-character allocation needed.
    this.playerCtx = {
      dt: 0,
      enemies:          this.enemyLive,
      allies:           this.playerLive,
      enemyTowerFrontX:     this.enemyTower.frontX,
      enemyTowerY:          this.enemyTower.baseY - TOWER_HEIGHT * 0.5,
      enemyTowerBaseFloorY: this.enemyTower.baseY,
      homeTowerFrontX:      this.playerTower.frontX,
      homeTowerBaseFloorY:  this.playerTower.baseY,
      worldWidth:           this.mapDef.worldWidth,
      coins:                this.liveCoins,
      platforms:            this.platformData,
      blocks:               this.blockData,
      navGraph:             this.navGraph,
      onFire:               (req) => this.fireProjectile(req),
      onDamageTower:        (dmg) => this.enemyTower.takeDamage(dmg),
      siege:                true,   // patched each tick in patchCtx()
      coinBoxX:             this.mapDef.coinBox.x,
      smartCollect:         true,   // patched each tick in patchCtx()
      onMeleeHit:       (unitType, x) => playSoundAt(unitType === 'conscript' ? 'punch' : 'sword_slash', x),
      attackKnockbackDecay: 1,   // patched each tick in patchCtx()
      onDepositCoin:    (value) => {
        this.coinBalance += value;
        this.notifyCoins();
        const c = this.updateChar;
        this.diagnostics.noteEvent(this.elapsedSeconds,
          `Coin deposit: #${c.id} ${c.name} (${c.side}) +${value}`, {
            playerTotal: Math.floor(this.coinBalance),
            cpuTotal:    Math.floor(this.cpuCoinBalance),
          });
      },
    };
    this.enemyCtx = {
      dt: 0,
      enemies:          this.playerLive,
      allies:           this.enemyLive,
      enemyTowerFrontX:     this.playerTower.frontX,
      enemyTowerY:          this.playerTower.baseY - TOWER_HEIGHT * 0.5,
      enemyTowerBaseFloorY: this.playerTower.baseY,
      homeTowerFrontX:      this.enemyTower.frontX,
      homeTowerBaseFloorY:  this.enemyTower.baseY,
      worldWidth:           this.mapDef.worldWidth,
      coins:                this.liveCoins,
      platforms:            this.platformData,
      blocks:               this.blockData,
      navGraph:             this.navGraph,
      onFire:               (req) => this.fireProjectile(req),
      onDamageTower:        (dmg) => this.playerTower.takeDamage(dmg),
      siege:                true,   // patched each tick in patchCtx()
      coinBoxX:             this.mapDef.coinBox.x,
      smartCollect:         true,   // patched each tick in patchCtx()
      onMeleeHit:       (unitType, x) => playSoundAt(unitType === 'conscript' ? 'punch' : 'sword_slash', x),
      attackKnockbackDecay: 1,   // patched each tick in patchCtx()
      onDepositCoin:    (value) => {
        this.cpuCoinBalance += value;
        const c = this.updateChar;
        this.diagnostics.noteEvent(this.elapsedSeconds,
          `Coin deposit: #${c.id} ${c.name} (${c.side}) +${value}`, {
            playerTotal: Math.floor(this.coinBalance),
            cpuTotal:    Math.floor(this.cpuCoinBalance),
          });
      },
    };
  }

  private readonly TYPE_COLORS: Record<PowerUpType, number> = {
    heal:    0x44dd88,
    speed:   0x44aaff,
    attack:  0xff8833,
    promote: 0xf0e040,
  };

  private buildDropIndicatorGfx() {
    const color = this.TYPE_COLORS[this.powerUpTypePreview];
    const g     = this.powerUpIndicatorGfx;
    const bw = 68, bh = 44;
    g.clear();

    // Dark pill background
    g.beginFill(0x0d0d22, 0.92);
    g.drawRoundedRect(-bw / 2, 0, bw, bh, 10);
    g.endFill();

    // Colored border
    g.lineStyle(2.5, color, 1);
    g.drawRoundedRect(-bw / 2, 0, bw, bh, 10);
    g.lineStyle(0);

    // Small type icon (left side of pill)
    g.beginFill(color, 0.9);
    if (this.powerUpTypePreview === 'heal') {
      g.drawRect(-26, 18, 4, 12); g.drawRect(-29, 21, 10, 6);   // cross
    } else if (this.powerUpTypePreview === 'speed') {
      g.drawPolygon([-28, 17, -23, 26, -27, 26, -22, 35, -16, 22, -21, 22, -17, 14]); // bolt
    } else if (this.powerUpTypePreview === 'attack') {
      g.drawPolygon([-22, 15, -19, 20, -21, 20, -21, 34, -25, 34, -25, 20, -27, 20]); // arrow up
    } else {
      // promote: small 5-pointed star centred at (-22, 25)
      const cx = -22, cy = 25, R = 8, r = 3.5, pts = 5;
      const verts: number[] = [];
      for (let i = 0; i < pts * 2; i++) {
        const ang = (i * Math.PI / pts) - Math.PI / 2;
        const rad = i % 2 === 0 ? R : r;
        verts.push(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
      }
      g.drawPolygon(verts);
    }
    g.endFill();

    // Stem line from box to arrowhead
    g.lineStyle(2, color, 0.8);
    g.moveTo(0, bh);
    g.lineTo(0, bh + 14);
    g.lineStyle(0);

    // Arrowhead
    g.beginFill(color, 1);
    g.drawPolygon([0, bh + 26, -10, bh + 14, 10, bh + 14]);
    g.endFill();
  }

  // ── Spawn ────────────────────────────────────────────────────────────────────

  /** Returns false if the player cannot afford this unit, the type is still
   *  on its purchase cooldown, or it is a special character already alive. */
  spawnPlayer(type: CharacterConfig['id']): boolean {
    if (this.isOver) return false;
    const playerTribe = getPlayerTribe();
    const cost = charCost(playerTribe, type);
    if (this.coinBalance < cost) return false;
    if (this.spawnCooldown('player', type).remaining > 0) return false;
    if (this.isUniqueDeployed('player', type)) return false;

    this.coinBalance -= cost;
    this.notifyCoins();
    this.armSpawnCooldown('player', type);

    const config  = withSpawnBoosts(charConfig(playerTribe, type));
    // Offset by half the character body width so the unit's tower-side edge
    // (not centre) sits at the tribe's configured spawn point — keeps the
    // body from overlapping the tower physics box.
    const spawnX  = this.playerTower.spawnX + config.width / 2;
    const c = new Character('player', spawnX, this.playerTower.spawnY, config, this.allocateCharId(), pickName(), this.physics, getSpriteSet(tribeForSide('player'), type), this.mapGroundY);
    this.characters.push(c);
    this.unitLayer.addChild(c.container);
    this.hud.add(c);
    this.recordPlayerSpawn(type);
    return true;
  }

  /** True when `type` is a special (unique) character and `side` already has a
   *  living one — its card stays locked until that instance dies. */
  isUniqueDeployed(side: 'player' | 'enemy', type: string): boolean {
    if (!charIsUnique(tribeForSide(side), type)) return false;
    return this.characters.some(c => c.side === side && !c.isDead && c.config.id === type);
  }

  /** Lock a type for `side` for its configured cooldown. Keyed on game time
   *  so the lockout pauses with the match and tracks fast-forward. Called on
   *  every purchase (either side), and for both rosters at match start
   *  (reset()) so every type begins the match recharging. */
  private armSpawnCooldown(side: 'player' | 'enemy', type: string) {
    const cooldown = charSpawnCooldown(tribeForSide(side), type);
    if (cooldown <= 0) return;
    this.spawnReadyAt[side].set(type, this.elapsedSeconds + cooldown);
    this.spawnCooldownLen[side].set(type, cooldown);
  }

  /** Purchase-cooldown state of a type for `side`: seconds left (0 when
   *  ready) and the recharge fraction 0→1 (drives the player card's sweep). */
  spawnCooldown(side: 'player' | 'enemy', type: string): { remaining: number; frac: number } {
    const readyAt = this.spawnReadyAt[side].get(type);
    if (readyAt === undefined) return { remaining: 0, frac: 1 };
    const remaining = Math.max(0, readyAt - this.elapsedSeconds);
    if (remaining <= 0) { this.spawnReadyAt[side].delete(type); return { remaining: 0, frac: 1 }; }
    const len = this.spawnCooldownLen[side].get(type) ?? remaining;
    return { remaining, frac: len > 0 ? 1 - remaining / len : 1 };
  }

  /** Player-card convenience for the spawn bar (main.ts). */
  playerSpawnCooldown(type: string): { remaining: number; frac: number } {
    return this.spawnCooldown('player', type);
  }

  private recordPlayerSpawn(type: string) {
    this.matchStats.playerSpawns++;
    this.matchStats.playerSpawnsByType[type] = (this.matchStats.playerSpawnsByType[type] ?? 0) + 1;
  }

  /** Read-only match-stats snapshot for the game-over screen, with the
   *  player's most-spawned type resolved (null when nothing was spawned). */
  get stats(): {
    playerKills: number; playerDeaths: number; playerSpawns: number;
    mostSpawnedType: string | null; mostSpawnedCount: number;
  } {
    const s = this.matchStats;
    let mostSpawnedType: string | null = null;
    let mostSpawnedCount = 0;
    for (const [type, n] of Object.entries(s.playerSpawnsByType)) {
      if (n > mostSpawnedCount) { mostSpawnedCount = n; mostSpawnedType = type; }
    }
    return {
      playerKills:  s.playerKills,
      playerDeaths: s.playerDeaths,
      playerSpawns: s.playerSpawns,
      mostSpawnedType, mostSpawnedCount,
    };
  }

  get paused() { return this.isPaused; }

  /** Re-apply the current resolution setting to the renderer's backing store.
   *  Logical size and the canvas's displayed CSS size are unchanged — only the
   *  pixel density changes, so the HTML UI overlays stay aligned. */
  applyResolution(): void {
    this.app.renderer.resolution = getRenderScale();
    this.app.renderer.resize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
  }

  togglePause() {
    if (this.isOver) return;
    this.isPaused = !this.isPaused;
    for (const c of this.characters) {
      if (this.isPaused) c.pauseAnimations();
      else               c.resumeAnimations();
    }
  }

  toggleDevMode() {
    this.devMode = !this.devMode;
    this.rangeMarkers.visible = this.devMode;
    return this.devMode;
  }

  /** Multiply game speed by `s` (1 = normal, 0.2 = slow-mo). Hooks into the
   *  PIXI ticker's speed so `deltaMS` reports a fraction of the real frame
   *  delta — every dt-driven sub-system (physics, characters, timers) slows
   *  proportionally without needing its own time-scale knob. */
  setTimeScale(s: number): void {
    this.app.ticker.speed = Math.max(0.01, s);
  }

  /** Live (non-dead) player-side characters. Snapshot is rebuilt each tick
   *  in `tick()`, so consumers should re-read this rather than caching. */
  get playerCharacters(): readonly Character[] { return this.playerLive; }

  /** Dev-only: when enabled, the player side is also driven by the CPU AI. */
  setCpuVsCpu(enabled: boolean): void {
    if (this.cpuVsCpu === enabled) return;
    this.cpuVsCpu = enabled;
    if (enabled) this.resetSpawnTimerFirst('player');
  }

  isCpuVsCpu(): boolean { return this.cpuVsCpu; }

  /** Dev: which decision profile a CPU-driven side uses (see cpu.tempo). */
  setCpuProfile(side: 'player' | 'enemy', profile: CpuProfile): void {
    this.cpuProfiles[side] = profile;
    this.cpuFeatures[side] = cpuProfileFeatures(profile);
  }
  getCpuProfile(side: 'player' | 'enemy'): CpuProfile { return this.cpuProfiles[side]; }

  /** Dev: run `steps` fixed 60 Hz simulation steps per 60 Hz clock tick (1 =
   *  real time, driven by the rAF ticker). Above 1 a Worker interval clocks
   *  the simulation so it survives a hidden tab or covered window; each batch
   *  is capped at 50 ms of work so rendering and input still get a turn. */
  setFastForward(steps: number): void {
    this.fastForward = Math.max(1, Math.floor(steps));
    if (this.fastForward > 1 && !this.ffWorker) {
      const src = 'setInterval(() => postMessage(0), 1000 / 60)';
      this.ffWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.ffWorker.onmessage = () => {
        const start = performance.now();
        for (let i = 0; i < this.fastForward; i++) {
          this.tick(1000 / 60);
          if (performance.now() - start > 50) break;
        }
      };
    } else if (this.fastForward === 1 && this.ffWorker) {
      this.ffWorker.terminate();
      this.ffWorker = null;
    }
  }

  /** Current tower HP of both sides — read by the self-play harness at game over. */
  get towerHp(): { player: number; enemy: number } {
    return { player: this.playerTower.hp, enemy: this.enemyTower.hp };
  }

  /** Dev: force the CPU (enemy) to purchase a specific unit type every spawn,
   *  bypassing its stance-driven AI order. Pass null to restore normal AI. */
  setCpuForcedType(type: CharacterConfig['id'] | null): void { this.cpuForcedType = type; }
  getCpuForcedType(): CharacterConfig['id'] | null { return this.cpuForcedType; }

  /** Dev cheat: when ON the player's coin balance is pinned to 9999. */
  setGameShark(on: boolean): void { this.gameShark = on; }

  // ── Tribe power-ups ──────────────────────────────────────────────────────────

  /** Set the player's tribe power-up (squad-selection screen). Persists across
   *  reset() — it's a meta choice, not per-match state. */
  setPlayerTribePowerUp(id: TribePowerUpId): void { this.playerTribePU = id; }

  /** Player-side state for the activation button UI. `frac` is the recharge
   *  progress 0→1 (1 = fully charged) driving the circumference ring. */
  get playerTribePowerUp(): { id: TribePowerUpId; cooldown: number; ready: boolean; frac: number } {
    return {
      id:       this.playerTribePU,
      cooldown: Math.ceil(this.playerTribePUCooldown),
      ready:    this.playerTribePUCooldown <= 0 && !this.isOver,
      frac:     Math.max(0, Math.min(1, 1 - this.playerTribePUCooldown / TRIBE_PU_COOLDOWN_SEC)),
    };
  }

  /** CPU-side state for the dev bar. */
  get cpuTribePowerUp(): { id: TribePowerUpId; cooldown: number; ready: boolean } {
    return {
      id:       this.cpuTribePU,
      cooldown: Math.ceil(this.cpuTribePUCooldown),
      ready:    this.cpuTribePUCooldown <= 0 && !this.isOver,
    };
  }

  /** Activate a side's tribe power-up — affects ALL of that side's live
   *  characters (Plague: all enemy characters). Returns false while cooling
   *  down or after game over. */
  activateTribePowerUp(side: 'player' | 'enemy'): boolean {
    if (this.isOver || this.isPaused) return false;
    const cooldown = side === 'player' ? this.playerTribePUCooldown : this.cpuTribePUCooldown;
    if (cooldown > 0) return false;

    const id  = side === 'player' ? this.playerTribePU : this.cpuTribePU;
    const own = side === 'player' ? this.playerLive : this.enemyLive;
    const opp = side === 'player' ? this.enemyLive  : this.playerLive;
    switch (id) {
      case 'speed':
        for (const c of own) c.applyTribeSpeed(TRIBE_PU_SPEED_MULT, TRIBE_PU_DURATION_SEC);
        break;
      case 'vitality':
        if (side === 'player') this.playerVitalityTimer = TRIBE_PU_DURATION_SEC;
        else                   this.cpuVitalityTimer    = TRIBE_PU_DURATION_SEC;
        break;
      case 'plague':
        for (const c of opp) c.applyPlague(TRIBE_PU_PLAGUE_DAMAGE, TRIBE_PU_PLAGUE_TICKS, TRIBE_PU_PLAGUE_INTERVAL);
        break;
      case 'aggression':
        for (const c of own) c.applyTribeAggression(TRIBE_PU_AGGRESSION_MULT, TRIBE_PU_DURATION_SEC);
        break;
    }
    if (side === 'player') this.playerTribePUCooldown = TRIBE_PU_COOLDOWN_SEC;
    else                   this.cpuTribePUCooldown    = TRIBE_PU_COOLDOWN_SEC;
    if (side === 'enemy') this.cpuStrategyInfo.decision = `✨ Tribe power: ${TRIBE_POWER_UPS[id].name}`;
    playSoundAt('level_up', side === 'player' ? this.mapDef.playerTowerX : this.mapDef.enemyTowerX);
    return true;
  }

  /** Dev (Game Shark): apply flat damage to a tower. Tower death is picked up
   *  by the regular end-of-tick check; HP notifications are debounced there too. */
  cheatDamageTower(side: 'player' | 'enemy', dmg: number): void {
    if (this.isOver) return;
    (side === 'player' ? this.playerTower : this.enemyTower).takeDamage(dmg);
  }

  /** Dev (Game Shark): skip the match clock forward. The countdown display and
   *  the timeout end-of-match check both run in the regular tick, so a skip
   *  past zero simply ends the match on the next frame. */
  cheatSkipClock(seconds: number): void {
    if (this.isOver) return;
    this.timeRemaining = Math.max(0, this.timeRemaining - seconds);
  }

  /** Dev: immediately drop a power-up of the given type at a random map position. */
  forceDropPowerUp(type: PowerUpType): void {
    const innerLeft  = this.mapDef.playerTowerX + TOWER_WIDTH / 2 + 60;
    const innerRight = this.mapDef.enemyTowerX  - TOWER_WIDTH / 2 - 60;
    const px = innerLeft + Math.random() * (innerRight - innerLeft);
    const pu = new PowerUp(px, type, this.physics, this.mapGroundY);
    this.powerUps.push(pu);
    this.powerUpLayer.addChild(pu.container);
  }

  /** Add screen-shake trauma. If `worldX` is given, the amount fades for blasts
   *  that detonate off the sides of the viewport so off-screen booms don't
   *  jolt the camera as hard as on-screen ones. */
  private addShake(amount: number, worldX?: number): void {
    let a = amount;
    if (worldX !== undefined) {
      const viewL = this.cameraX;
      const viewR = this.cameraX + VIEWPORT_WIDTH / GAME_ZOOM;
      if (worldX < viewL || worldX > viewR) {
        const off = worldX < viewL ? viewL - worldX : worldX - viewR;
        a *= Math.max(0, 1 - off / SHAKE_FALLOFF_PX);
      }
    }
    this.shakeTrauma = Math.min(1, this.shakeTrauma + a);
  }

  // ── CPU strategic assessment ─────────────────────────────────────────────────

  /** Attribute-derived valuation of a unit type — computed from the live
   *  charConfig/charCost, so editing a unit's stats in gameConfig automatically
   *  reshapes both the threat assessment and the buy order. Cached per
   *  (tribe, type): configs are `as const` and immutable at runtime. */
  private static unitProfile(tribe: Tribe, type: string): UnitProfile {
    const key = `${tribe}/${type}`;
    let p = unitProfileCache.get(key);
    if (p) return p;

    const cfg  = charConfig(tribe, type);
    const cost = charCost(tribe, type);

    // Sustained DPS: rounds per trigger (burst), magazine reload downtime,
    // poison damage-over-time per hit, and miss chance all folded in.
    const roundsPerTrigger = cfg.burstCount ?? 1;
    const poisonPerHit     = (cfg.poisonDamage ?? 0) * (cfg.poisonTicks ?? 0);
    const damagePerTrigger = cfg.attackPower * roundsPerTrigger + poisonPerHit;
    const magazine         = (cfg.shotsBeforeCooldown ?? 0) > 0 && (cfg.cooldownSec ?? 0) > 0;
    const triggersPerSec   = magazine
      ? cfg.shotsBeforeCooldown! / (cfg.shotsBeforeCooldown! * cfg.fireRate + cfg.cooldownSec!)
      : 1 / cfg.fireRate;
    const dps = damagePerTrigger * triggersPerSec * (1 - cfg.critical);

    // Effective HP folds in shield block: an expected (blockChance × blockPercent)
    // fraction of incoming damage never lands, so durability scales by its inverse.
    const blockFactor = 1 - (cfg.blockChance ?? 0) * (cfg.blockPercent ?? 0);
    const effHp = cfg.hp / Math.max(0.2, blockFactor);

    // combat: overall strength (damage output × durability, geometric mean so
    // neither stat alone dominates). reach/tanky: soft bonuses for standoff
    // range and frontline hp. threat: combat×reach normalized ≈ 1.0 baseline.
    const combat = Math.sqrt(dps * effHp);
    const reach  = 1 + cfg.attackRange / CPU_VAL_RANGE_DIVISOR;
    const tanky  = 1 + effHp / CPU_VAL_HP_DIVISOR;
    p = {
      cost,
      combat,
      reach,
      tanky,
      splash: cfg.attackStyle === 'grenade' || cfg.attackStyle === 'rocket',
      threat: combat * reach / CPU_VAL_THREAT_NORM,
      canFight: cfg.attackPower > 0,
    };
    unitProfileCache.set(key, p);
    return p;
  }

  private assessCpuStance(self: 'player' | 'enemy', selfChars: Character[], oppChars: Character[]): 'push' | 'economy' | 'defend' {
    const selfTower = self === 'enemy' ? this.enemyTower : this.playerTower;
    const oppTower  = self === 'enemy' ? this.playerTower : this.enemyTower;
    const selfCoins = self === 'enemy' ? this.cpuCoinBalance : this.coinBalance;
    const oppCoins  = self === 'enemy' ? this.coinBalance    : this.cpuCoinBalance;

    // Per-unit threat is derived from live config attributes (DPS × hp × range,
    // cached per tribe/type) — editing a unit's stats in gameConfig reshapes the
    // assessment automatically. Scaled by the unit's current HP fraction.
    // Collectors are discounted: the opponent's heavily (0.15 — they can't be
    // redirected at us), our own moderately (0.5 — they're off the front line
    // right now but CAN be recalled; counting them at full strength made the
    // AI push with a smaller real army than it believed it had).
    const threat = (chars: Character[], side: 'player' | 'enemy', collectingMult: number) => {
      const tribe = tribeForSide(side);
      let s = 0;
      for (const c of chars) {
        const behaviorMult = c.behavior === 'collecting' ? collectingMult : 1.0;
        s += (c.hp / c.maxHp) * Game.unitProfile(tribe, c.config.id).threat * behaviorMult;
      }
      return s;
    };

    const oppSide: 'player' | 'enemy' = self === 'enemy' ? 'player' : 'enemy';
    const oppStr  = threat(oppChars,  oppSide, 0.15);
    const selfStr = threat(selfChars, self,    0.5);
    this.oppThreat[self] = oppStr;   // read by checkReactiveSpawn
    const unitAdv   = selfStr - oppStr;
    const towerAdv  = (selfTower.hp / TOWER_HP) - (oppTower.hp / TOWER_HP);
    const coinAdv   = Math.min(1, Math.max(-1, (selfCoins - oppCoins) / 120));
    const score     = unitAdv * 1.5 + towerAdv * 2.5 + coinAdv * 0.5;
    // Same score with own collectors at FULL weight. The ×0.5 discount above
    // is right for deciding to push (collectors aren't on the front line) but
    // wrong for deciding to defend: defending RECALLS them, so a defend
    // threshold that counts them at half strength feeds back on itself —
    // draft two collectors → score drops → defend → recall → score recovers →
    // economy → draft again, one switch per dwell window. stableStance judges
    // the defend thresholds on this total instead.
    const scoreTotal = (threat(selfChars, self, 1.0) - oppStr) * 1.5 + towerAdv * 2.5 + coinAdv * 0.5;

    // Store intermediate values for the dev panel — only from the canonical CPU (enemy) perspective
    if (self === 'enemy') {
      this.cpuStrategyInfo.score    = score;
      this.cpuStrategyInfo.unitAdv  = unitAdv;
      this.cpuStrategyInfo.towerAdv = towerAdv;
      this.cpuStrategyInfo.coinAdv  = coinAdv;
    }

    // ── Endgame (time-aware) ──────────────────────────────────────────────────
    // At timeout the winner is decided purely by tower HP — and the enemy side
    // loses ties. Once the clock is inside CPU_ENDGAME_SEC the mid-game score
    // is irrelevant:
    //  • behind on tower HP → ALL-IN push. Towers never heal, so defending can
    //    only preserve a losing deficit — razing or out-chipping the opponent
    //    tower is the only path to victory. This deliberately overrides even
    //    the critical-own-tower defend below (turtling at 20% HP while behind
    //    just converts a possible loss into a certain one).
    //  • ahead on tower HP → protect the lead and run out the clock (unless
    //    the opponent tower is critical — then finish it).
    const losingOnTowers = self === 'enemy'
      ? selfTower.hp <= oppTower.hp   // enemy loses ties
      : selfTower.hp <  oppTower.hp;
    const endgame = this.timeRemaining <= CPU_ENDGAME_SEC;
    const allIn   = endgame && losingOnTowers;
    if (self === 'enemy') this.cpuAllIn = allIn;
    else                  this.playerAllIn = allIn;

    const prev = self === 'enemy' ? this.cpuStance : this.playerStance;
    const now  = this.elapsedSeconds;
    let stance: 'push' | 'economy' | 'defend';
    if (endgame) {
      stance = allIn || oppTower.hp / TOWER_HP < 0.28 ? 'push' : 'defend';
    }
    // Critical tower overrides
    else if (selfTower.hp / TOWER_HP < 0.28) stance = 'defend';
    else if (oppTower.hp / TOWER_HP < 0.28)  stance = 'push';
    else if (this.cpuFeatures[self].has('stableStance')) {
      // Smooth the score first (this runs every 0.5 s): spawns, deaths and
      // collector drafts swing the raw score by ±0.75 within a few seconds,
      // which the dwell alone only slowed to one switch per window.
      const k    = 1 - Math.exp(-0.5 / CPU_STANCE_SCORE_TAU_SEC);
      const ema0 = this.scoreEma[self];
      const s  = ema0 === null ? score      : ema0 + (score - ema0) * k;            // front-line score → push thresholds
      const emaT0 = this.scoreTotalEma[self];
      const sT = emaT0 === null ? scoreTotal : emaT0 + (scoreTotal - emaT0) * k;   // total score → defend thresholds
      this.scoreEma[self]      = s;
      this.scoreTotalEma[self] = sT;
      // Hysteresis relative to the current stance (see gameConfig.cpu.stance):
      // a stance is left at a smaller |score| than it was entered at, and no
      // non-critical switch happens inside the dwell window.
      if (prev === 'push') {
        stance = sT < CPU_STANCE_DEFEND_ENTER ? 'defend' : s < CPU_STANCE_PUSH_EXIT ? 'economy' : 'push';
      } else if (prev === 'defend') {
        stance = s > CPU_STANCE_PUSH_ENTER ? 'push' : sT > CPU_STANCE_DEFEND_EXIT ? 'economy' : 'defend';
      } else {
        stance = s > CPU_STANCE_PUSH_ENTER ? 'push' : sT < CPU_STANCE_DEFEND_ENTER ? 'defend' : 'economy';
      }
      if (stance !== prev && now - this.stanceSince[self] < CPU_STANCE_MIN_DWELL_SEC) stance = prev;
    }
    else if (score > CPU_STANCE_PUSH_ENTER)   stance = 'push';
    else if (score < CPU_STANCE_DEFEND_ENTER) stance = 'defend';
    else                                      stance = 'economy';
    if (stance !== prev) this.stanceSince[self] = now;

    if (self === 'enemy') this.cpuStrategyInfo.stance = stance;
    return stance;
  }

  /** Returns true if 3+ characters in `chars` sit within 80 px of any single one. */
  private isCharsClustered(chars: Character[]): boolean {
    const RADIUS    = 80;
    const THRESHOLD = 3;
    for (const c of chars) {
      let count = 0;
      for (const other of chars) {
        if (Math.abs(c.x - other.x) <= RADIUS && ++count >= THRESHOLD) return true;
      }
    }
    return false;
  }

  private spawnCpu(self: 'player' | 'enemy', selfChars: Character[], oppChars: Character[]) {
    if (this.isOver) return;

    const cpuTribe  = tribeForSide(self);
    const cost$     = (type: string) => charCost(cpuTribe, type);
    const stance    = self === 'enemy' ? this.cpuStance : this.playerStance;
    // Unit-count pressure drives the spawn cadence. With dedicated runners in
    // play (coinRunners) count FIGHTERS only — two runners otherwise read as
    // two extra soldiers and the side eases off its combat buys.
    const fighters  = (cs: Character[]) => cs.reduce((n, c) => n + (c.behavior !== 'collecting' ? 1 : 0), 0);
    const pressure  = this.cpuFeatures[self].has('coinRunners')
      ? fighters(oppChars) - fighters(selfChars)
      : oppChars.length - selfChars.length;
    const balance   = self === 'enemy' ? this.cpuCoinBalance : this.coinBalance;
    // spawnX is computed per unit type (width varies) — see cpuSpawnX below
    const spawnY    = self === 'enemy' ? this.enemyTower.spawnY : this.playerTower.spawnY;

    // Dev override: force the CPU (enemy) to buy a specific type, bypassing the
    // stance AI and roster filter entirely. Saves toward it when it can't afford.
    if (self === 'enemy' && this.cpuForcedType) {
      const type = this.cpuForcedType;
      const cost = cost$(type);
      if (this.cpuCoinBalance >= cost) {
        if (this.spriteSetPending(self, cpuTribe, type)) return;
        this.cpuCoinBalance -= cost;
        const c = this.spawnCpuUnit(self, type, spawnY);
        this.cpuStrategyInfo.decision = `Forced ${type} #${c.id}`;
      } else {
        this.cpuStrategyInfo.decision = `Saving (forced ${type}) — need ${cost} (have ${Math.floor(this.cpuCoinBalance)})`;
      }
      this.resetSpawnTimer(self, pressure);
      return;
    }

    // ── Coin runners first ('coinRunners') ────────────────────────────────
    // Cheap, fast collectors are the best coins-per-coin investment there is
    // and they only pay off if they exist before the drops do.
    if (this.tryBuyRunner(self, pressure)) return;

    // ── Attribute-driven buy order ────────────────────────────────────────────
    // Score every combat unit in the tribe's roster from its derived profile
    // (live config stats — no hardcoded type lists), sort best-first, then buy
    // the first affordable. Editing a unit's stats or cost in gameConfig
    // automatically re-ranks it; new roster types participate with no AI change.
    //
    // Stance shaping:
    //   push    — raw strength × standoff range; AoE types boosted when the
    //             opponents are clustered (splash value is real, not nominal)
    //   defend  — outnumbered: durability-weighted wall to hold the line;
    //             steady: cost-efficient standoff damage (√cost divisor keeps a
    //             mid-price skew without letting cheap spam dominate)
    //   economy — investment quality: strength × reach², favouring standoff
    //             units that survive to fight again; the buy-first-affordable
    //             walk yields the old "invest when rich, filler when broke" tiering

    // Opponent cluster result is pre-computed every 500 ms alongside the stance
    // assessment — no need to run the O(n²) scan here on every spawn call.
    const opponentsClustered = self === 'enemy'
      ? this.cachedEnemyOppClustered
      : this.cachedPlayerOppClustered;

    const stanceScore = (p: UnitProfile): number => {
      if (stance === 'push') {
        const splashMult = opponentsClustered && p.splash ? CPU_VAL_SPLASH_PUSH_MULT : 1;
        return p.combat * p.reach * splashMult;
      }
      if (stance === 'defend') {
        return pressure >= 3
          ? p.combat * p.tanky
          : p.combat * p.reach * p.tanky / Math.sqrt(p.cost);
      }
      return p.combat * p.reach * p.reach; // economy
    };

    // counterComp: weigh each candidate by the opponent's live mix — standoff
    // range against a melee-heavy field, durability against a ranged-heavy
    // one — and discourage stacking one type however well it scores.
    const counter   = this.cpuFeatures[self].has('counterComp');
    const diversity = this.cpuFeatures[self].has('typeDiversity');
    let meleeShare = 0, rangedShare = 0;
    const ownCount = new Map<string, number>();
    if (counter) {
      let n = 0;
      for (const c of oppChars) {
        if (c.behavior === 'collecting') continue;
        n++;
        const s = c.config.attackStyle;
        if (s === 'melee' || s === 'blast')       meleeShare++;
        else if (s === 'arrow' || s === 'bullet') rangedShare++;
      }
      if (n > 0) { meleeShare /= n; rangedShare /= n; }
    }
    if (diversity) for (const c of selfChars) ownCount.set(c.config.id, (ownCount.get(c.config.id) ?? 0) + 1);
    const shape = (type: string, p: UnitProfile): number =>
      (counter   ? 1 + CPU_VAL_COUNTER_WEIGHT * (meleeShare * (p.reach - 1) + rangedShare * (p.tanky - 1)) : 1)
      * (diversity ? Math.max(0.4, 1 - CPU_VAL_SAME_TYPE_PENALTY * (ownCount.get(type) ?? 0)) : 1);

    const order: { type: CharacterConfig['id']; cost: number; score: number }[] = [];
    let lockedOut = 0;   // roster types skipped only because of a purchase cooldown
    for (const type of TRIBE_ROSTERS[cpuTribe]) {
      const p = Game.unitProfile(cpuTribe, type);
      if (!p.canFight || !Number.isFinite(p.cost)) continue; // skip support / unpriced types
      if (this.isUniqueDeployed(self, type)) continue;       // special character already on the field
      if (this.spawnCooldown(self, type).remaining > 0) { lockedOut++; continue; }  // same per-type cooldown the player has
      order.push({ type: type as CharacterConfig['id'], cost: p.cost, score: stanceScore(p) * shape(type, p) });
    }
    order.sort((a, b) => b.score - a.score);

    for (const { type, cost } of order) {
      if (balance < cost) continue;
      if (this.spriteSetPending(self, cpuTribe, type)) return;
      if (self === 'enemy') {
        this.cpuCoinBalance -= cost;
      } else {
        this.coinBalance -= cost;
        this.notifyCoins();
      }
      const c = this.spawnCpuUnit(self, type, spawnY);
      if (self === 'enemy')  this.cpuStrategyInfo.decision = `Spawned ${type} #${c.id}`;
      this.scheduleFollowUpBuy(self, pressure, balance - cost, order, stance);
      return;
    }
    if (self === 'enemy') {
      const needCost = order.reduce((m, o) => Math.min(m, o.cost), Infinity);
      this.cpuStrategyInfo.decision = order.length === 0 && lockedOut > 0
        ? `Waiting — ${lockedOut} type${lockedOut === 1 ? '' : 's'} on purchase cooldown`
        : `Saving — need ${needCost} (have ${Math.floor(this.cpuCoinBalance)})`;
    }
    // Everything affordable is cooling down: re-check soon rather than parking
    // the purse for a full 7–15 s timer tick.
    if (order.length === 0 && lockedOut > 0 && this.cpuFeatures[self].has('tempo')) this.setSpawnInterval(self, CPU_SPEND_DOWN_GAP_MS);
    else this.resetSpawnTimer(self, pressure);
  }

  /** The tribe's best collector: the roster unit with the most move speed per
   *  coin of cost (the conscript on both tribes). Cached per tribe. */
  private static runnerType(tribe: Tribe): CharacterConfig['id'] {
    let cached = runnerTypeCache.get(tribe);
    if (cached) return cached;
    let best: string = TRIBE_ROSTERS[tribe][0];
    let bestScore = -Infinity;
    for (const type of TRIBE_ROSTERS[tribe]) {
      const cfg = charConfig(tribe, type);
      const cost = charCost(tribe, type);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      const score = cfg.speed / cost;
      if (score > bestScore) { bestScore = score; best = type; }
    }
    cached = best as CharacterConfig['id'];
    runnerTypeCache.set(tribe, cached);
    return cached;
  }

  /** Runners a side wants right now: a bigger opening squad, then per stance,
   *  plus one while the coin box is berserk; none during the endgame all-in. */
  private desiredRunners(self: 'player' | 'enemy'): number {
    if (!this.cpuFeatures[self].has('coinRunners')) return 0;
    const allIn  = self === 'enemy' ? this.cpuAllIn : this.playerAllIn;
    if (allIn) return 0;
    const stance = self === 'enemy' ? this.cpuStance : this.playerStance;
    const base = this.elapsedSeconds < RUNNERS_OPENING_SEC ? RUNNERS_OPENING
      : stance === 'push' ? RUNNERS_PUSH : stance === 'defend' ? RUNNERS_DEFEND : RUNNERS_ECONOMY;
    return Math.min(RUNNERS_MAX, base + (this.berserkRemaining > 0 ? RUNNERS_BERSERK_BONUS : 0));
  }

  /** Buy a runner if the side is short of them and can afford one. Returns
   *  true when it bought (or is waiting on the runner's sprites) — the caller
   *  skips the stance buy order this tick either way. */
  private tryBuyRunner(self: 'player' | 'enemy', pressure: number): boolean {
    const runners = this.runners[self];
    for (const r of runners) if (r.isDead) runners.delete(r);
    const want = this.desiredRunners(self);
    if (runners.size >= want) return false;
    // Soldiers first when the line is breaking: outnumbered on fighters, or
    // the tower is critical, the stance order gets the coins.
    const selfTower = self === 'enemy' ? this.enemyTower : this.playerTower;
    if (pressure >= CPU_PRESSURE_THRESHOLD || selfTower.hp / TOWER_HP < 0.28) return false;
    const tribe = tribeForSide(self);
    const type  = Game.runnerType(tribe);
    const cost  = charCost(tribe, type);
    const balance = self === 'enemy' ? this.cpuCoinBalance : this.coinBalance;
    if (balance < cost) return false;    // let the stance order try its fillers
    if (this.spawnCooldown(self, type).remaining > 0) return false;   // runner type cooling down — same deal
    if (this.spriteSetPending(self, tribe, type)) return true;
    if (self === 'enemy') this.cpuCoinBalance -= cost;
    else { this.coinBalance -= cost; this.notifyCoins(); }
    const spawnY = self === 'enemy' ? this.enemyTower.spawnY : this.playerTower.spawnY;
    const c = this.spawnCpuUnit(self, type, spawnY);
    c.behavior = 'collecting';
    runners.add(c);
    if (self === 'enemy') this.cpuStrategyInfo.decision = `🏃 Runner ${type} #${c.id} (${runners.size}/${want})`;
    // Another runner still owed → chain quickly; otherwise the normal cadence.
    if (runners.size < want && this.cpuFeatures[self].has('tempo')) this.setSpawnInterval(self, CPU_SPEND_DOWN_GAP_MS);
    else this.resetSpawnTimer(self, pressure);
    return true;
  }

  /** After a buy: spend down a flush purse instead of parking it for the next
   *  7–15 s timer tick. push / defend / all-in re-buy anything affordable
   *  shortly; economy only chains when the TOP-ranked pick is still affordable
   *  (fillers remain timer-paced, so "invest when rich" tiering survives).
   *  'legacy' profile keeps the one-buy-per-tick cadence. */
  private scheduleFollowUpBuy(
    self: 'player' | 'enemy', pressure: number, balanceAfter: number,
    order: { cost: number }[], stance: 'push' | 'economy' | 'defend',
  ) {
    const allIn = self === 'enemy' ? this.cpuAllIn : this.playerAllIn;
    const feat  = this.cpuFeatures[self];
    if (!feat.has('tempo') || order.length === 0) {
      this.resetSpawnTimer(self, pressure);
      return;
    }
    let cheapest = Infinity;
    for (const o of order) cheapest = Math.min(cheapest, o.cost);
    // reactionReserve: in economy keep one cheap unit's cost back, so the
    // reactive buy has something to spend when the opponent dumps a bank.
    const reserve   = feat.has('reactionReserve') ? cheapest : 0;
    const threshold = stance === 'economy' && !allIn ? order[0].cost + reserve : cheapest;
    if (balanceAfter >= threshold) this.setSpawnInterval(self, CPU_SPEND_DOWN_GAP_MS);
    else                           this.resetSpawnTimer(self, pressure);
  }

  /** Reactive spawn (stance cadence, `dtSec` apart): buy immediately when the
   *  opponent's field threat jumps well above its relaxed baseline — the
   *  player just spent a bank on units and the answer shouldn't wait for a
   *  timer. The baseline is an EMA with CPU_REACTIVE_BASELINE_TAU so a steady
   *  trickle doesn't keep tripping it; a trigger re-bases to the live value. */
  private checkReactiveSpawn(self: 'player' | 'enemy', selfChars: Character[], oppChars: Character[], dtSec: number) {
    const cur  = this.oppThreat[self];
    const base = this.oppThreatBaseline[self];
    const sinceSpawn = self === 'enemy' ? this.cpuSpawnTimer : this.playerSpawnTimer;
    const armed = this.cpuFeatures[self].has('tempo') && !this.isOver
      && cur - base >= CPU_REACTIVE_THREAT_DELTA && sinceSpawn >= CPU_REACTIVE_MIN_GAP_MS;
    if (armed) {
      this.oppThreatBaseline[self] = cur;
      this.spawnCpu(self, selfChars, oppChars);
      // spawnCpu wrote its own decision; prefix it so the dev log shows the trigger.
      if (self === 'enemy') this.cpuStrategyInfo.decision = `⚡ +${(cur - base).toFixed(1)} threat → ${this.cpuStrategyInfo.decision}`;
      return;
    }
    this.oppThreatBaseline[self] = base + (cur - base) * (1 - Math.exp(-dtSec / CPU_REACTIVE_BASELINE_TAU));
  }

  /** CPU sprite sets load on first demand (only the player's loadout is
   *  preloaded — see main.ts matchSpriteKeys), so resident texture memory
   *  tracks the types a side actually fields. When the AI has settled on
   *  `type` but its sheets aren't resident yet, kick the load and re-check
   *  shortly instead of buying something else — the buy decision must not
   *  depend on load state. Returns true when the spawn was deferred. */
  private spriteSetPending(self: 'player' | 'enemy', tribe: Tribe, type: CharacterConfig['id']): boolean {
    if (isSpriteSetReady(tribe, type)) return false;
    void loadSpriteSet(tribe, type);
    if (self === 'enemy') this.cpuStrategyInfo.decision = `Loading ${type} sprites…`;
    this.setSpawnInterval(self, CPU_SPRITE_RETRY_MS);
    return true;
  }

  /** Construct a CPU-side Character of `type` at the side's tower spawn point and
   *  register it with the world. Shared by the AI spawn loop and the dev forced-type
   *  override. Does not deduct coins or reset the spawn timer — the caller owns that. */
  private spawnCpuUnit(self: 'player' | 'enemy', type: CharacterConfig['id'], spawnY: number): Character {
    const cpuConfig = withSpawnBoosts(charConfig(tribeForSide(self), type));
    // Place the unit's tower-side body edge (not centre) at the tribe's
    // configured spawn point so it never overlaps the tower physics body.
    const towerSpawnX = self === 'enemy' ? this.enemyTower.spawnX : this.playerTower.spawnX;
    const cpuSpawnX   = self === 'enemy'
      ? towerSpawnX - cpuConfig.width / 2
      : towerSpawnX + cpuConfig.width / 2;
    const c = new Character(self, cpuSpawnX, spawnY, cpuConfig, this.allocateCharId(), pickName(), this.physics, getSpriteSet(tribeForSide(self), type), this.mapGroundY);
    this.characters.push(c);
    this.unitLayer.addChild(c.container);
    // Every CPU buy (stance order, runner, dev forced type) goes through here,
    // so this is where the side's per-type purchase cooldown is armed.
    this.armSpawnCooldown(self, type);
    if (self === 'player') {
      this.hud.add(c);
      this.recordPlayerSpawn(type);   // CPU-vs-CPU mode drives the player side
    }
    return c;
  }

  private allocateCharId(): number {
    return this.freeCharIds.length > 0 ? this.freeCharIds.shift()! : this.nextCharId++;
  }

  private releaseCharId(id: number) {
    const i = this.freeCharIds.findIndex(x => x > id);
    if (i === -1) this.freeCharIds.push(id);
    else          this.freeCharIds.splice(i, 0, id);
  }

  private spawnCoin(value: number, kind: CoinKind, dt = 1 / 60) {
    const cb        = this.mapDef.coinBox;
    const wallL     = this.mapDef.playerTowerX - TOWER_WIDTH / 2;
    const wallR     = this.mapDef.enemyTowerX  + TOWER_WIDTH / 2;
    // Aim vxMax so a coin spread by spreadDeg lands on the lowest platform (rough target).
    // cachedLowestPlatY is set once in build() — sufficient precision for spread physics.
    const lowestPlatY = this.cachedLowestPlatY;
    const fallH     = lowestPlatY - (cb.y + cb.height);
    const spreadRad = cb.spreadDeg * (Math.PI / 180);
    const vxMax     = Math.tan(spreadRad) * Math.sqrt(Math.max(1, fallH) * COIN_GRAVITY / 2);
    let vx = (Math.random() * 2 - 1) * vxMax;
    let vy = 0;
    let y  = cb.y + cb.height;   // normal: released from the underside, falls out
    if (this.berserkRemaining > 0) {
      // Berserk: fired UP out of the top of the box in a fan (negative vy is up).
      const ang   = (Math.random() * 2 - 1) * BERSERK_SPREAD_DEG * (Math.PI / 180);
      const speed = BERSERK_LAUNCH_MIN + Math.random() * (BERSERK_LAUNCH_MAX - BERSERK_LAUNCH_MIN);
      vx = Math.sin(ang) * speed;
      vy = -Math.cos(ang) * speed;
      y  = cb.y - 12;              // just above the lid so the arc starts clear of the box art
    }
    const coin = new Coin(cb.x, COIN_LIFETIME_S, value, kind, vx, vy, y, this.physics, dt, wallL, wallR, this.mapGroundY, this.mapDef.coinSkins?.[kind]);
    this.coins.push(coin);
    this.coinLayer.addChild(coin.container);
  }

  // ── Coin box berserk ───────────────────────────────────────────────────────
  // Idle → (random wait) → berserk for BERSERK_DURATION_S → cooldown + random
  // wait → … While berserk the box art vibrates and spawnCoin launches coins
  // out of the top. Returns the ms to advance the gold/silver drop clocks by
  // this tick (BERSERK_RATE_MULT× while active).
  private tickBerserk(dt: number, deltaMS: number): number {
    if (this.berserkRemaining > 0) {
      this.berserkRemaining -= dt;
      this.berserkPhase     += dt;
      const box = this.coinBoxVisual;
      if (box) {
        const w = this.berserkPhase * Math.PI * 2 * BERSERK_SHAKE_HZ;
        box.x = Math.sin(w) * BERSERK_SHAKE_AMP + (Math.random() - 0.5) * BERSERK_SHAKE_AMP;
        box.y = Math.cos(w * 1.31) * BERSERK_SHAKE_AMP * 0.6;
      }
      if (this.berserkRemaining <= 0) this.stopBerserk(true);
      return deltaMS * BERSERK_RATE_MULT;
    }
    this.berserkTimer -= dt;
    if (this.berserkTimer <= 0) this.startBerserk();
    return deltaMS;
  }

  private startBerserk() {
    this.berserkRemaining = BERSERK_DURATION_S;
    this.berserkPhase     = 0;
    this.diagnostics.noteEvent(this.elapsedSeconds, 'Coin box berserk');
    this.onCoinBoxBerserk();   // main.ts: "COINS BERSERK" banner fly-through
  }

  /** End the burst; `schedule` arms the next one after the cooldown. */
  private stopBerserk(schedule: boolean) {
    this.berserkRemaining = 0;
    if (this.coinBoxVisual) { this.coinBoxVisual.x = 0; this.coinBoxVisual.y = 0; }
    if (schedule) this.berserkTimer = berserkDelay(true);
  }

  /** Dev: trigger a berserk burst now (Game Shark). */
  cheatBerserk(): void {
    if (this.isOver || this.berserkRemaining > 0) return;
    this.startBerserk();
  }

  get isCoinBoxBerserk(): boolean { return this.berserkRemaining > 0; }

  // ── Timers ───────────────────────────────────────────────────────────────────

  private setSpawnInterval(self: 'player' | 'enemy', interval: number) {
    if (self === 'enemy') {
      this.cpuSpawnInterval = interval;
      this.cpuSpawnTimer    = 0;
    } else {
      this.playerSpawnInterval = interval;
      this.playerSpawnTimer    = 0;
    }
  }

  private resetSpawnTimerFirst(self: 'player' | 'enemy') {
    this.setSpawnInterval(self, Math.random() * CPU_FIRST_SPAWN_MAX);
  }

  private resetSpawnTimer(self: 'player' | 'enemy', pressure = 0) {
    // Endgame all-in: spawn at the urgent floor regardless of unit-count
    // pressure — a losing side with MORE units than the opponent would
    // otherwise read as "comfortable" and hoard coins it can never spend.
    const allIn = self === 'enemy' ? this.cpuAllIn : this.playerAllIn;
    const [min, max] =
      allIn || pressure >= CPU_PRESSURE_THRESHOLD
                                          ? [CPU_SPAWN_MIN_MS,                         CPU_SPAWN_MIN_MS * CPU_URGENT_MAX_FACTOR  ] :
      pressure <= -CPU_PRESSURE_THRESHOLD ? [CPU_SPAWN_MAX_MS * CPU_COMFORT_MIN_FACTOR, CPU_SPAWN_MAX_MS                          ] :
                                            [CPU_SPAWN_MIN_MS * CPU_NEUTRAL_MIN_FACTOR, CPU_SPAWN_MAX_MS * CPU_NEUTRAL_MAX_FACTOR ];
    // Stance modifier: defend and push both need units urgently
    const stance     = self === 'enemy' ? this.cpuStance : this.playerStance;
    const stanceMult = stance === 'push' ? 0.70 : stance === 'defend' ? 0.72 : 1.0;
    this.setSpawnInterval(self, (min + Math.random() * (max - min)) * stanceMult);
  }

  private resetCoinDropTimer() {
    const range = COIN_DROP_MAX_MS - COIN_DROP_MIN_MS;
    this.coinDropInterval = COIN_DROP_MIN_MS + Math.random() * range;
    this.coinDropTimer    = 0;
  }

  private resetSilverDropTimer() {
    const range = SILVER_DROP_MAX_MS - SILVER_DROP_MIN_MS;
    this.silverDropInterval = SILVER_DROP_MIN_MS + Math.random() * range;
    this.silverDropTimer    = 0;
  }

  private resetBlueDropTimer() {
    const range = BLUE_DROP_MAX_MS - BLUE_DROP_MIN_MS;
    this.blueDropInterval = BLUE_DROP_MIN_MS + Math.random() * range;
    this.blueDropTimer    = 0;
  }

  /**
   * Animate each block AND each platform that has an `anim` definition, sync
   * its Matter body to the new position, and carry any character standing on
   * it so units ride the surface instead of being left hovering. Called from
   * both the normal tick loop and the post-game-over loop so animations
   * continue to play while the player reviews the field.
   */
  private patchCtx(ctx: UpdateContext, home: Tower, enemy: Tower, dt: number): void {
    ctx.dt                   = dt;
    ctx.enemyTowerFrontX     = enemy.frontX;
    ctx.enemyTowerY          = enemy.centerY;
    ctx.enemyTowerBaseFloorY = enemy.baseY;
    ctx.homeTowerFrontX      = home.frontX;
    ctx.homeTowerBaseFloorY  = home.baseY;
    ctx.worldWidth           = this.mapDef.worldWidth;
    // Siege is always on for the human player; a CPU-driven side follows its
    // profile so self-play can A/B it (the player side is CPU-driven only in
    // CPU-vs-CPU mode).
    ctx.siege = ctx === this.playerCtx
      ? (!this.cpuVsCpu || this.cpuFeatures.player.has('siege'))
      : this.cpuFeatures.enemy.has('siege');
    ctx.smartCollect = ctx === this.playerCtx
      ? (!this.cpuVsCpu || this.cpuFeatures.player.has('smartCollect'))
      : this.cpuFeatures.enemy.has('smartCollect');
  }

  /**
   * Carry any character or settled coin that sat on a surface which just
   * moved. Compared against the PRE-MOVE surface top so characters whose
   * floorY hasn't been updated yet are still matched correctly. Hoisted
   * out of tickBlocks so the closure isn't allocated every tick.
   */
  private carryStanders(newX: number, newY: number, width: number, dx: number, dy: number) {
    const oldTop  = newY - dy;
    const oldLeft = newX - dx;
    const right   = oldLeft + width;
    for (const c of this.characters) {
      if (c.isDead || c.airborne) continue;
      if (Math.abs(c.currentFloorY - oldTop) > 1) continue;
      if (c.x < oldLeft || c.x > right) continue;
      c.carryWith(dx, dy);
    }
    for (const coin of this.coins) {
      if (coin.isDead || coin.isPickedUp || !coin.isOnGround) continue;
      if (Math.abs(coin.floorY - oldTop) > 1) continue;
      if (coin.x < oldLeft || coin.x > right) continue;
      coin.carryWith(dx, dy);
    }
  }

  private tickBlocks(dt: number): void {
    let anyMoved = false;

    for (let i = 0; i < this.blocks.length; i++) {
      const blk = this.blocks[i];
      const { dx, dy } = blk.update(dt);
      if (dx === 0 && dy === 0) continue;
      anyMoved = true;

      Matter.Body.setPosition(this.blockBodies[i], {
        x: blk.data.x + blk.data.width  / 2,
        y: blk.data.y + blk.data.height / 2,
      });
      this.carryStanders(blk.data.x, blk.data.y, blk.data.width, dx, dy);
    }

    const platformBodies = this.physics.platformBodies;
    for (let i = 0; i < this.platforms.length; i++) {
      const plat = this.platforms[i];
      const { dx, dy } = plat.update(dt);
      if (dx === 0 && dy === 0) continue;
      anyMoved = true;

      Matter.Body.setPosition(platformBodies[i], {
        x: plat.data.x + plat.data.width  / 2,
        y: plat.data.y + plat.data.height / 2,
      });
      this.carryStanders(plat.data.x, plat.data.y, plat.data.width, dx, dy);
    }

    // Any animated surface that actually moved this tick invalidates the NavGraph.
    // Throttle to ~30 rebuilds/s (every 33 ms) so the O(n²) edge pass doesn't
    // run 60× per second during continuous animation. When movement stops, do
    // one final rebuild to sync the navGraph to the at-rest geometry.
    if (anyMoved) {
      this.navGraphRebuildTimer += dt * 1000;
      if (this.navGraphRebuildTimer >= 33) {
        this.navGraphRebuildTimer = 0;
        this.navGraph.build(this.platformData, this.mapDef.playerTowerX, this.mapDef.enemyTowerX, this.blockData, this.mapGroundY);
      }
    } else if (this.navGraphRebuildTimer > 0) {
      this.navGraphRebuildTimer = 0;
      this.navGraph.build(this.platformData, this.mapDef.playerTowerX, this.mapDef.enemyTowerX, this.blockData, this.mapGroundY);
    }
  }

  /**
   * Lightweight tick that runs once the match is over. Skips AI, combat,
   * spawning, income, power-ups, and tower fire — keeps only:
   *   • Coin-box drop timers + visuals (so the field stays alive while the
   *     player pans around to review the match)
   *   • Character physics step + landing (so any character that was airborne
   *     when the game ended falls and lands on the nearest surface instead of
   *     hovering mid-air)
   *   • Coin culling so finished coins disappear normally
   */
  private tickGameOver(dt: number, deltaMS: number): void {
    // Coin drops keep firing.
    this.coinDropTimer += deltaMS;
    if (this.coinDropTimer >= this.coinDropInterval) {
      this.spawnCoin(COIN_VALUE, 'gold');
      this.resetCoinDropTimer();
    }
    this.silverDropTimer += deltaMS;
    if (this.silverDropTimer >= this.silverDropInterval) {
      this.spawnCoin(SILVER_COIN_VALUE, 'silver');
      this.resetSilverDropTimer();
    }
    this.blueDropTimer += deltaMS;
    if (this.blueDropTimer >= this.blueDropInterval) {
      this.spawnCoin(BLUE_COIN_VALUE, 'blue');
      this.resetBlueDropTimer();
    }

    // Coin physics + visuals
    for (const coin of this.coins) coin.update(dt, this.platformData, this.blockData);
    for (const coin of this.coins) {
      if (!coin.isDead && !coin.isPickedUp && !coin.isOnGround) this.physics.updatePlatformPassthrough(coin.body);
    }

    // Animate moving blocks (and carry any units still standing on them).
    this.tickBlocks(dt);

    // Step the physics world so airborne characters fall and land. Characters
    // were already frozen in end() (motion zeroed, anims to idle), so this is
    // just gravity completing their descent — no AI, no horizontal movement.
    this.liveChars.length = 0;
    for (const c of this.characters) if (!c.isDead) this.liveChars.push(c);
    for (const c of this.liveChars) c.syncToBody(dt);
    this.physics.step(dt);
    for (const c of this.liveChars) {
      c.syncFromBody(this.platformData, this.blockData);
      c.syncVisual();
    }

    // Cull dead coins so the layer doesn't grow indefinitely while the
    // game-over screen is up.
    let wi = 0;
    for (let ri = 0; ri < this.coins.length; ri++) {
      const coin = this.coins[ri];
      if (coin.isDead) { this.coinLayer.removeChild(coin.container); coin.destroy(); }
      else             { this.coins[wi++] = coin; }
    }
    this.coins.length = wi;

    this.updateCulling();
  }

  // ── Tick ─────────────────────────────────────────────────────────────────────

  private tick(deltaMS: number) {
    const dt = Math.min(deltaMS / 1000, 1 / 30);  // cap at 33 ms — prevents physics explosion on lag spikes

    // Camera — runs even when the game is over so the player can review the field
    const CAMERA_SPEED = 500; // px/s
    if (this.keysDown.has('ArrowLeft'))  this.cameraX -= CAMERA_SPEED * dt;
    if (this.keysDown.has('ArrowRight')) this.cameraX += CAMERA_SPEED * dt;
    if (this.keysDown.has('ArrowUp'))    this.cameraY += CAMERA_SPEED * dt;
    if (this.keysDown.has('ArrowDown'))  this.cameraY -= CAMERA_SPEED * dt;
    this.cameraX = Math.max(0, Math.min(this.mapDef.worldWidth - VIEWPORT_WIDTH / GAME_ZOOM, this.cameraX));
    // Y: positive cameraY = scrolled up (world Y=0 toward canvas top); negative = scrolled down.
    // world.y = zoom_anchor + cameraY*GAME_ZOOM, so larger cameraY raises the world on screen.
    // Pan limits come from the map when it defines cameraTopY / cameraBottomY
    // (world-space Y the view may reveal at its top / bottom edge); otherwise:
    //   max up   — world Y=0 at canvas top
    //   max down — world bottom (worldHeight) at canvas bottom, further
    //              restricted by CAMERA_MAX_PAN_DOWN below the resting view.
    const worldH  = (this.mapDef.worldHeight ?? GAME_HEIGHT) as number;
    const anchor  = this.mapGroundY * (GAME_ZOOM - 1) / GAME_ZOOM;
    const topY    = this.mapDef.cameraTopY;
    const bottomY = this.mapDef.cameraBottomY;
    const camYMax = topY !== undefined ? anchor - topY : Math.max(0, anchor);
    let   camYMin: number;
    if (bottomY !== undefined) {
      // Explicit map bound replaces the CAMERA_MAX_PAN_DOWN heuristic.
      camYMin = VIEWPORT_HEIGHT / GAME_ZOOM - bottomY + anchor;
    } else {
      const camYMinWorld = Math.min(0, VIEWPORT_HEIGHT / GAME_ZOOM - worldH + anchor);
      camYMin = Math.max(camYMinWorld, this.restCameraY - CAMERA_MAX_PAN_DOWN / GAME_ZOOM);
    }
    // Degenerate config guard (range narrower than one viewport): pin to the top bound.
    camYMin = Math.min(camYMin, camYMax);
    this.cameraY  = Math.max(camYMin, Math.min(camYMax, this.cameraY));
    this.world.x        = -this.cameraX * GAME_ZOOM;
    this.world.y        = this.mapGroundY * (1 - GAME_ZOOM) + this.cameraY * GAME_ZOOM;
    // Screen shake — decay trauma, then add a quick oscillating offset to the
    // world transform (parallax bg stays put so the foreground reads as jolted).
    this.shakeTime  += dt;
    this.shakeTrauma = Math.max(0, this.shakeTrauma - SHAKE_DECAY * dt);
    if (this.shakeTrauma > 0) {
      const mag = SHAKE_MAX_OFFSET * this.shakeTrauma * this.shakeTrauma;
      this.world.x += mag * Math.sin(this.shakeTime * 47 + 1.3);
      this.world.y += mag * 0.6 * Math.sin(this.shakeTime * 41 + 4.7);
    }
    this.parallaxGfx.x   = -this.cameraX * PARALLAX_FACTOR;
    this.parallaxGfx2.x  = -this.cameraX * PARALLAX_FACTOR_FAR;
    setViewport(this.cameraX, this.cameraX + VIEWPORT_WIDTH / GAME_ZOOM);

    if (this.isOver)   { this.tickGameOver(dt, deltaMS); return; }
    if (this.isPaused) { this.updateCulling(); return; }

    if (this.gameShark && this.coinBalance < 9999) this.coinBalance += 9999 - this.coinBalance;
    const playerRate = this.coinBalance    < LOW_BALANCE_THRESHOLD ? PASSIVE_INCOME_RATE * LOW_BALANCE_INCOME_MULT : PASSIVE_INCOME_RATE;
    const cpuRate    = this.cpuCoinBalance < LOW_BALANCE_THRESHOLD ? PASSIVE_INCOME_RATE * LOW_BALANCE_INCOME_MULT : PASSIVE_INCOME_RATE;
    this.coinBalance    += playerRate * dt;
    this.cpuCoinBalance += cpuRate    * dt;
    this.notifyCoins();
    this.notifyCpuCoins();
    this.notifyCpuCharsMs    += deltaMS;
    this.notifyCpuStrategyMs += deltaMS;
    if (this.notifyCpuCharsMs    >= 200) { this.notifyCpuCharsMs    = 0; this.notifyCpuChars(); }
    if (this.notifyCpuStrategyMs >= 150) { this.notifyCpuStrategyMs = 0; this.notifyCpuStrategy(); }
    this.notifyEnemyTowerHp();
    this.notifyPlayerTowerHp();

    // Rebuild live arrays into pre-allocated buffers — avoids filter() allocations each tick
    this.liveChars.length = 0; this.playerLive.length = 0; this.enemyLive.length = 0;
    for (const c of this.characters) {
      if (!c.isDead) {
        this.liveChars.push(c);
        (c.side === 'player' ? this.playerLive : this.enemyLive).push(c);
      }
    }
    const liveChars = this.liveChars;

    // Tribe power-ups: tick down cooldowns; Vitality is a heal-over-time aura
    // on every live character of the side (also catches units spawned mid-effect).
    this.playerTribePUCooldown = Math.max(0, this.playerTribePUCooldown - dt);
    this.cpuTribePUCooldown    = Math.max(0, this.cpuTribePUCooldown    - dt);
    if (this.playerVitalityTimer > 0) {
      this.playerVitalityTimer -= dt;
      for (const c of this.playerLive) c.heal(TRIBE_PU_HEAL_PER_SEC * dt);
    }
    if (this.cpuVitalityTimer > 0) {
      this.cpuVitalityTimer -= dt;
      for (const c of this.enemyLive) c.heal(TRIBE_PU_HEAL_PER_SEC * dt);
    }

    // Throttle stance assessment to every 500 ms — frame-perfect precision not needed.
    // Also refresh the opponent-cluster cache here: same cadence, avoids a per-spawn O(n²) scan.
    this.cpuStanceMs += deltaMS;
    if (this.cpuStanceMs >= 500) {
      this.cpuStanceMs = 0;
      this.cpuStance = this.assessCpuStance('enemy', this.enemyLive, this.playerLive);
      if (this.cpuVsCpu) this.playerStance = this.assessCpuStance('player', this.playerLive, this.enemyLive);
      this.cachedEnemyOppClustered  = this.isCharsClustered(this.playerLive);
      if (this.cpuVsCpu) this.cachedPlayerOppClustered = this.isCharsClustered(this.enemyLive);
      this.checkReactiveSpawn('enemy', this.enemyLive, this.playerLive, 0.5);
      if (this.cpuVsCpu) this.checkReactiveSpawn('player', this.playerLive, this.enemyLive, 0.5);
    }

    // CPU auto-spawn (uses liveChars for strategic decisions)
    this.cpuSpawnTimer += deltaMS;
    if (this.cpuSpawnTimer >= this.cpuSpawnInterval) {
      this.spawnCpu('enemy', this.enemyLive, this.playerLive);
    }

    // CPU vs CPU: drive the player side with a second AI instance
    if (this.cpuVsCpu) {
      this.playerSpawnTimer += deltaMS;
      if (this.playerSpawnTimer >= this.playerSpawnInterval) {
        this.spawnCpu('player', this.playerLive, this.enemyLive);
      }
    }

    // Coin drop — gold and silver clocks run BERSERK_RATE_MULT× faster while
    // the box is berserk; blue keeps its own rare schedule.
    const dropMs = this.tickBerserk(dt, deltaMS);
    this.coinDropTimer += dropMs;
    if (this.coinDropTimer >= this.coinDropInterval) {
      this.spawnCoin(COIN_VALUE, 'gold');
      this.resetCoinDropTimer();
    }

    // Silver coin drop
    this.silverDropTimer += dropMs;
    if (this.silverDropTimer >= this.silverDropInterval) {
      this.spawnCoin(SILVER_COIN_VALUE, 'silver');
      this.resetSilverDropTimer();
    }

    // Blue coin drop — rare jackpot
    this.blueDropTimer += deltaMS;
    if (this.blueDropTimer >= this.blueDropInterval) {
      this.spawnCoin(BLUE_COIN_VALUE, 'blue');
      this.resetBlueDropTimer();
    }

    // Power-up drop (every 40 s) with 20 s lead-up indicator
    this.powerUpTimer += deltaMS;
    const timeUntilDrop = this.powerUpInterval - this.powerUpTimer;

    if (timeUntilDrop <= POWERUP_INDICATOR_LEAD * 1000) {
      const innerLeft  = this.mapDef.playerTowerX + TOWER_WIDTH / 2 + 60;
      const innerRight = this.mapDef.enemyTowerX  - TOWER_WIDTH / 2 - 60;

      // First frame entering the 20 s window: choose type + seed indicator position
      if (!this.powerUpIndicatorActive) {
        this.powerUpIndicatorActive    = true;
        const types: PowerUpType[]     = ['heal', 'speed', 'attack', 'promote'];
        this.powerUpTypePreview        = types[Math.floor(Math.random() * types.length)];
        this.powerUpIndicatorX         = innerLeft + Math.random() * (innerRight - innerLeft);
        this.powerUpIndicatorTargetX   = this.powerUpIndicatorX;
        this.powerUpIndicatorMoveTimer = 0;
        this.powerUpLastCountdown      = -1;
        this.buildDropIndicatorGfx();
        this.powerUpIndicatorContainer.visible = true;
      }

      // Random drift across map: pick a new world-X target every 1.2 – 2.4 s
      this.powerUpIndicatorMoveTimer += dt;
      if (this.powerUpIndicatorMoveTimer >= 1.2 + Math.random() * 1.2) {
        this.powerUpIndicatorMoveTimer  = 0;
        this.powerUpIndicatorTargetX    = innerLeft + Math.random() * (innerRight - innerLeft);
      }
      // Smooth slide toward target (world space)
      this.powerUpIndicatorX += (this.powerUpIndicatorTargetX - this.powerUpIndicatorX) * Math.min(1, dt * 2 / 9);
      // Convert to screen space so the indicator sticks to the camera top edge.
      // Clamp so it stays visible even when the drop point is scrolled off-screen.
      const screenX = (this.powerUpIndicatorX - this.cameraX) * GAME_ZOOM;
      this.powerUpIndicatorContainer.x = Math.max(20, Math.min(VIEWPORT_WIDTH - 20, screenX));

      // Countdown text (update only when integer second changes)
      const secs = Math.max(0, Math.ceil(timeUntilDrop / 1000));
      if (secs !== this.powerUpLastCountdown) {
        this.powerUpLastCountdown    = secs;
        this.powerUpIndicatorText.text = `${secs}s`;
      }
    } else {
      // Outside the 20 s window — hide
      if (this.powerUpIndicatorActive) {
        this.powerUpIndicatorActive = false;
        this.powerUpIndicatorContainer.visible = false;
      }
    }

    if (this.powerUpTimer >= this.powerUpInterval) {
      this.powerUpTimer           = 0;
      this.powerUpIndicatorActive = false;
      this.powerUpIndicatorContainer.visible = false;

      // Spawn at indicator world position (already in world coords)
      const innerLeft  = this.mapDef.playerTowerX + TOWER_WIDTH / 2 + 60;
      const innerRight = this.mapDef.enemyTowerX  - TOWER_WIDTH / 2 - 60;
      const px  = Math.max(innerLeft, Math.min(innerRight, this.powerUpIndicatorX));
      const pu  = new PowerUp(px, this.powerUpTypePreview, this.physics, this.mapGroundY);
      this.powerUps.push(pu);
      this.powerUpLayer.addChild(pu.container);
    }

    // Update and pick up power-ups
    for (const pu of this.powerUps) {
      pu.update(dt, this.platformData, this.blockData);
      if (pu.isDead || pu.isPickedUp) continue;
      const idx = pu.tryPickup(liveChars);
      if (idx !== -1) {
        liveChars[idx].applyPowerUp(pu.type);
        pu.collect();
      }
    }

    // Update coins
    for (const coin of this.coins) coin.update(dt, this.platformData, this.blockData);

    // Update sheep
    if (this.sheep) this.sheep.update(dt);

    this.liveCoins.length = 0;
    for (const c of this.coins) { if (!c.isDead) this.liveCoins.push(c); }
    const liveCoins = this.liveCoins;

    // Throttle the collect-AI assign/recall pass; ~4 Hz is plenty for the
    // strategic decision and removes a per-tick `.filter()` + closure × 2 sides.
    this.cpuCollectAIMs += deltaMS;
    const runCollectAI = this.cpuCollectAIMs >= 250;
    if (runCollectAI) this.cpuCollectAIMs = 0;
    if (runCollectAI) this.tickCpuCollectAI('enemy', this.enemyLive, liveCoins);
    this.tickCpuBehaviorAI('enemy', this.enemyLive, this.playerLive);
    if (this.cpuVsCpu) {
      if (runCollectAI) this.tickCpuCollectAI('player', this.playerLive, liveCoins);
      this.tickCpuBehaviorAI('player', this.playerLive, this.enemyLive);
    }

    // Animate moving blocks (and carry any units still standing on them) BEFORE
    // characters' AI runs so each character's tick sees its post-carry x/y.
    this.tickBlocks(dt);

    // Update characters — reuse pre-allocated ctx objects; patch only the fields
    // that change each tick to eliminate per-character object + closure allocation.
    // Per-frame precompute shared by every melee swing / shotgun blast this tick.
    const attackKnockbackDecay = Math.exp(-ATTACK_KNOCKBACK_DECAY * dt);
    this.patchCtx(this.playerCtx, this.playerTower, this.enemyTower, dt);
    this.patchCtx(this.enemyCtx,  this.enemyTower,  this.playerTower, dt);
    this.playerCtx.attackKnockbackDecay = attackKnockbackDecay;
    this.enemyCtx.attackKnockbackDecay  = attackKnockbackDecay;

    for (const c of liveChars) {
      this.updateChar = c;
      c.update(c.side === 'player' ? this.playerCtx : this.enemyCtx);
    }

    // Physics step: push AI positions → engine → read results back
    for (const c of liveChars) c.syncToBody(dt);
    // Skip settled (isOnGround) coins — their bodies are static, can't rise,
    // so the mask flip is a no-op every tick. Matches the existing power-up
    // filter on the line below.
    for (const coin of this.coins) if (!coin.isDead && !coin.isPickedUp && !coin.isOnGround) this.physics.updatePlatformPassthrough(coin.body);
    for (const pu of this.powerUps) if (!pu.isDead && !pu.isPickedUp && !pu.isOnGround) this.physics.updatePlatformPassthrough(pu.body);
    if (this.sheep) this.physics.updatePlatformPassthrough(this.sheep.body);
    this.physics.step(dt);
    for (const c of liveChars) c.syncFromBody(this.platformData, this.blockData);

    // Guard the call so the input object isn't allocated every frame when
    // diagnostics is off (the default) — tick() itself also early-outs.
    if (this.diagnostics.isActive()) {
      this.diagnostics.tick({
        time:      this.mapDurationSec - this.timeRemaining,
        chars:     liveChars,
        platforms: this.platformData,
        blocks:    this.blockData,
      });
    }

    // Tower hit shake (visual only) + tower fire — inline both branches; no
    // per-tick closure or object spread.
    this.playerTower.tickShake(dt);
    this.enemyTower.tickShake(dt);
    const shotP = this.playerTower.tryFire(dt, this.enemyLive);
    if (shotP) this.fireProjectile({
      sx: shotP.sx, sy: shotP.sy, tx: shotP.tx, ty: shotP.ty, damage: shotP.damage,
      side: 'player', projectileKind: 'arrow',
    });
    const shotE = this.enemyTower.tryFire(dt, this.playerLive);
    if (shotE) this.fireProjectile({
      sx: shotE.sx, sy: shotE.sy, tx: shotE.tx, ty: shotE.ty, damage: shotE.damage,
      side: 'enemy', projectileKind: 'arrow',
    });

    // Spawn coins dropped or thrown by characters (scan all — some may have just died)
    for (const c of this.characters) {
      if (!c.pendingCoinDrop) continue;
      const { x, y, value: dropValue, kind: dropKind, vx: throwVx, vy: throwVy } = c.pendingCoinDrop;
      const isThrow = throwVx !== undefined;
      c.pendingCoinDrop = null;
      const vx    = throwVx  ?? (Math.random() < 0.5 ? 1 : -1) * (COIN_DROP_VX_MIN + Math.random() * (COIN_DROP_VX_MAX - COIN_DROP_VX_MIN));
      const vy    = throwVy  ?? -(COIN_DROP_VY_MIN + Math.random() * (COIN_DROP_VY_MAX - COIN_DROP_VY_MIN));
      const wallL = this.mapDef.playerTowerX - TOWER_WIDTH / 2;
      const wallR = this.mapDef.enemyTowerX  + TOWER_WIDTH / 2;
      const coin  = new Coin(x, COIN_LIFETIME_S, dropValue, dropKind, vx, vy, y, this.physics, dt, wallL, wallR, this.mapGroundY, this.mapDef.coinSkins?.[dropKind]);
      this.coins.push(coin);
      this.coinLayer.addChild(coin.container);
      if (!c.isDead && !isThrow) c.recoverCoin(coin);
    }

    // Spawn damage labels from pending events
    for (const c of liveChars) {
      const color = c.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
      for (const ev of c.pendingDamages) {
        // A hit that would print as 0 (a miss, or damage that rounds away) reads
        // as "Missed" — a floating zero looks like a bug.
        const label = ev.text
          ? new DamageLabel(ev.x, ev.y, 0, ev.color ?? 0x999999, ev.text)   // custom word (e.g. "Blocked")
          : Math.round(ev.amount) <= 0
            ? new DamageLabel(ev.x, ev.y, 0, 0x999999, 'Missed')
            : new DamageLabel(ev.x, ev.y, ev.amount, ev.color ?? color);   // poison ticks carry their own green
        this.damageLabels.push(label);
        this.labelLayer.addChild(label.container);
      }
      c.pendingDamages.length = 0;

      if (c.pendingPromotion) {
        c.pendingPromotion = false;
        playSoundAt('level_up', c.x);
        const label = new DamageLabel(c.x, c.y - c.config.height - 14, 0, color, RANK_NAMES[c.rank]);
        this.damageLabels.push(label);
        this.labelLayer.addChild(label.container);
      }
    }

    // Update damage labels
    for (const label of this.damageLabels) label.update(dt);

    // Update projectiles
    for (const p of this.projectiles) {
      const wasAlive = !p.isDead;
      p.update(dt, liveChars, this.playerTower, this.enemyTower, this.blockData);
      const impact = p.consumeImpact();
      if (impact) spawnHitSpark(impact.x, impact.y);
      // A deflected shot is the payoff of a block — lift it to the topmost
      // world layer so it isn't lost behind the units it bounces through.
      if (p.consumeRicochetStart()) this.ricochetLayer.addChild(p.container);
      // Startle the sheep when a projectile lands within 55 px of it
      if (wasAlive && p.isDead && this.sheep && Math.abs(p.x - this.sheep.x) <= 55) {
        this.sheep.reactToHit(p.x);
      }
    }

    // Update rockets + process AoE explosions (proximity hit → detonate)
    const rocketKnockbackDecay = Math.exp(-ROCKET_KNOCKBACK_DECAY * dt);
    const rocketHitRadiusSq    = ROCKET_HIT_RADIUS * ROCKET_HIT_RADIUS;
    for (const r of this.rockets) {
      r.update(dt, this.platformData, this.blockData);
      // Detonate on enemy character contact (proximity sphere).
      // Squared-distance avoids Math.hypot()'s square root on every check.
      if (!r.isDead) {
        for (const c of liveChars) {
          if (c.side === r.side) continue;
          const charCenterY = c.y - c.config.height * 0.5;
          const dx = c.x - r.x, dy = charCenterY - r.y;
          if (dx * dx + dy * dy <= rocketHitRadiusSq) {
            r.triggerHit();
            break;
          }
        }
      }
      // Detonate on enemy tower contact (AABB) — read the cached struct
      if (!r.isDead) {
        const tab = r.side === 'player' ? this.enemyTowerAABB : this.playerTowerAABB;
        if (r.x >= tab.left && r.x <= tab.right && r.y >= tab.top) {
          r.triggerHit();
        }
      }
      const ex = r.consumeExplosion();
      if (ex) {
        playSoundAt('rocket_explosion', ex.x);
        spawnExplosion(ex.x, ex.y, ex.radius);
        this.addShake(SHAKE_ROCKET, ex.x);
        this.processAoE(
          ex, r.side,
          ROCKET_SPLASH_MIN_FRAC,
          ROCKET_KNOCKBACK_MAX_VX, ROCKET_KNOCKBACK_MAX_VY,
          rocketKnockbackDecay,
          dt, liveChars,
        );
      }
    }

    // Update grenades + process AoE explosions
    const knockbackDecayFactor = Math.exp(-GRENADE_KNOCKBACK_DECAY * dt);
    for (const g of this.grenades) {
      g.update(dt, this.platformData, this.blockData);
      const ex = g.consumeExplosion();
      if (ex) {
        playSoundAt('grenade_explosion', ex.x);
        spawnExplosion(ex.x, ex.y, ex.radius);
        this.addShake(SHAKE_GRENADE, ex.x);
        this.processAoE(
          ex, g.side,
          GRENADE_SPLASH_MIN_FRAC,
          GRENADE_KNOCKBACK_MAX_VX, GRENADE_KNOCKBACK_MAX_VY,
          knockbackDecayFactor,
          dt, liveChars,
        );
      }
    }

    // Tick short-lived VFX (slash arcs, hit sparks) after combat resolution
    tickVfx(dt);

    // Cull dead entities — in-place to avoid allocating new arrays each tick
    { let wi = 0;
      for (let ri = 0; ri < this.characters.length; ri++) {
        const c = this.characters[ri];
        if (c.isDead) {
          // Mega Man death: the body is removed outright and the burst plays in
          // its place, so the pellets have to be spawned before the container goes.
          spawnDeathBurst(c.x, c.y - c.config.height * 0.5, c.side);
          this.unitLayer.removeChild(c.container);
          this.releaseCharId(c.id);
          const reward = c.killedBy === 'tower' ? TOWER_KILL_REWARD : KILL_REWARD;
          c.destroy();
          if (c.side === 'enemy') { this.coinBalance += reward; this.notifyCoins(); this.matchStats.playerKills++; }
          else                    { this.cpuCoinBalance += reward; this.notifyCpuCoins(); this.matchStats.playerDeaths++; }
        } else { this.characters[wi++] = c; }
      }
      this.characters.length = wi; }
    { let wi = 0;
      for (let ri = 0; ri < this.projectiles.length; ri++) {
        const p = this.projectiles[ri];
        if (p.isDead) { p.container.parent?.removeChild(p.container); p.destroy(); }  // projLayer, or ricochetLayer after a deflection
        else          { this.projectiles[wi++] = p; }
      }
      this.projectiles.length = wi; }
    { let wi = 0;
      for (let ri = 0; ri < this.grenades.length; ri++) {
        const g = this.grenades[ri];
        if (g.isDead) { this.grenadeLayer.removeChild(g.container); g.destroy(); }
        else          { this.grenades[wi++] = g; }
      }
      this.grenades.length = wi; }
    { let wi = 0;
      for (let ri = 0; ri < this.rockets.length; ri++) {
        const r = this.rockets[ri];
        if (r.isDead) { this.rocketLayer.removeChild(r.container); r.destroy(); }
        else          { this.rockets[wi++] = r; }
      }
      this.rockets.length = wi; }
    { let wi = 0;
      for (let ri = 0; ri < this.coins.length; ri++) {
        const coin = this.coins[ri];
        if (coin.isDead) { this.coinLayer.removeChild(coin.container); coin.destroy(); }
        else             { this.coins[wi++] = coin; }
      }
      this.coins.length = wi; }
    { let wi = 0;
      for (let ri = 0; ri < this.powerUps.length; ri++) {
        const pu = this.powerUps[ri];
        if (pu.isDead) { this.powerUpLayer.removeChild(pu.container); pu.destroy(); }
        else           { this.powerUps[wi++] = pu; }
      }
      this.powerUps.length = wi; }
    { let wi = 0;
      for (let ri = 0; ri < this.damageLabels.length; ri++) {
        const l = this.damageLabels[ri];
        if (l.isDead) { this.labelLayer.removeChild(l.container); l.destroy(); }
        else          { this.damageLabels[wi++] = l; }
      }
      this.damageLabels.length = wi; }

    this.cullingFrame++;
    if (this.cullingFrame % 3 === 0) this.hud.update();

    // Collision-box debug overlay
    if (this.showCollisionBoxes) this.drawCollisionDebug(liveChars);

    // Countdown
    this.timeRemaining -= dt;
    const displaySecs = Math.max(0, Math.floor(this.timeRemaining));
    if (displaySecs !== this.lastNotifiedTime) {
      this.lastNotifiedTime = displaySecs;
      this.onTimeChanged(displaySecs);
    }
    if (this.timeRemaining <= 0) {
      const winner = this.playerTower.hp >= this.enemyTower.hp ? 'player' : 'enemy';
      this.end(winner, 'timeout');
      return;
    }

    if (this.enemyTower.isDead)       this.end('player', 'tower');
    else if (this.playerTower.isDead) this.end('enemy',  'tower');

    if (this.cullingFrame % 2 === 0) this.updateCulling();
  }

  // ── Viewport culling ─────────────────────────────────────────────────────────

  private updateCulling() {
    const viewL  = this.cameraX - 100;
    const viewR  = this.cameraX + VIEWPORT_WIDTH / GAME_ZOOM + 100;
    const inView = (x: number) => x >= viewL && x <= viewR;

    for (const c  of this.characters)   c.setCulled(!inView(c.x));  // also gates sprite playback
    for (const c  of this.coins)        c.container.visible  = inView(c.x);
    for (const p  of this.projectiles)  p.container.visible  = inView(p.x);
    for (const g  of this.grenades)     g.container.visible  = inView(g.x);
    for (const r  of this.rockets)      r.container.visible  = inView(r.x);
    for (const pu of this.powerUps)     pu.container.visible = inView(pu.x);
    for (const l  of this.damageLabels) l.container.visible  = inView(l.container.x);
    if (this.sheep) this.sheep.container.visible = inView(this.sheep.x);
  }

  // ── Collision debug overlay ──────────────────────────────────────────────────

  private drawCollisionDebug(chars: Character[]) {
    const g = this.collisionDebugLayer;
    g.clear();

    // Static boxes: towers (solid=red), platform & coin box (passthrough=yellow)
    for (const box of this.staticCollisionBoxes) {
      const color = box.type === 'solid' ? 0xff3333 : 0xffdd00;
      g.lineStyle(2, color, 0.85);
      g.beginFill(color, 0.08);
      g.drawRect(box.x, box.y, box.width, box.height);
      g.endFill();
    }

    // Platforms (passthrough=yellow) drawn live so animated platforms follow.
    for (const plat of this.platforms) {
      g.lineStyle(2, 0xffdd00, 0.85);
      g.beginFill(0xffdd00, 0.08);
      g.drawRect(plat.data.x, plat.data.y, plat.data.width, plat.data.height);
      g.endFill();
    }

    // Blocks (solid=red) drawn live from this.blocks so animated blocks follow.
    for (const blk of this.blocks) {
      g.lineStyle(2, 0xff3333, 0.85);
      g.beginFill(0xff3333, 0.08);
      g.drawRect(blk.data.x, blk.data.y, blk.data.width, blk.data.height);
      g.endFill();
    }

    // Coins: circular collision bodies (radius 10)
    for (const coin of this.coins) {
      if (coin.isDead || coin.isPickedUp) continue;
      g.lineStyle(1.5, 0xffd700, 0.9);
      g.beginFill(0xffd700, 0.12);
      g.drawCircle(coin.x, coin.y, 10);
      g.endFill();
    }

    // Per-character: collision box + pathfinding path
    for (const c of chars) {
      const charColor = c.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;

      // Collision box (actual physics body extent, which can be taller than the visible sprite)
      g.lineStyle(1.5, 0x44ff88, 0.75);
      g.beginFill(0x44ff88, 0.06);
      g.drawRect(c.x - c.config.width / 2, c.y - c.collisionHeight, c.config.width, c.collisionHeight);
      g.endFill();

      // Path visualization
      const { steps, currentIdx } = c.debugPath;
      if (steps.length === 0) continue;

      // Trace the remaining steps as connected segments
      let prevX = c.x;
      let prevY = c.y;   // character feet

      for (let i = currentIdx; i < steps.length; i++) {
        const step    = steps[i];
        const isCur   = i === currentIdx;
        const stepColor = step.action === 'jump' ? 0x00eeff
                        : step.action === 'fall' ? 0xff8800
                        : step.action === 'drop' ? 0xff44ff
                        : charColor;
        const alpha   = isCur ? 1.0 : 0.45;
        const thick   = isCur ? 2.0 : 1.0;

        g.lineStyle(thick, stepColor, alpha);

        // Jump trigger marker
        if (step.action === 'jump' && step.jumpTriggerX !== undefined) {
          const tx = step.jumpTriggerX;
          const ty = prevY;
          // Dashed segment to trigger x
          g.lineStyle(1, stepColor, alpha * 0.6);
          g.moveTo(prevX, prevY);
          g.lineTo(tx, ty);
          // Arc to landing point
          g.lineStyle(thick, stepColor, alpha);
          const peakY = ty - 90;
          const midX  = (tx + step.targetX) / 2;
          g.moveTo(tx, ty);
          g.quadraticCurveTo(midX, peakY, step.targetX, step.floorY);
          prevX = step.targetX;
          prevY = step.floorY;
          continue;
        }

        // Walk or fall: straight line
        g.moveTo(prevX, prevY);
        g.lineTo(step.targetX, step.floorY);
        prevX = step.targetX;
        prevY = step.floorY;
      }

      // Waypoint dots for each remaining step
      for (let i = currentIdx; i < steps.length; i++) {
        const step  = steps[i];
        const isCur = i === currentIdx;
        const dotColor = step.action === 'jump' ? 0x00eeff
                       : step.action === 'fall' ? 0xff8800
                       : step.action === 'drop' ? 0xff44ff
                       : charColor;
        g.lineStyle(0);
        g.beginFill(dotColor, isCur ? 1.0 : 0.5);
        g.drawCircle(step.targetX, step.floorY, isCur ? 5 : 3);
        g.endFill();

        // Jump trigger dot
        if (step.action === 'jump' && step.jumpTriggerX !== undefined) {
          g.beginFill(0xffffff, isCur ? 0.9 : 0.4);
          g.drawCircle(step.jumpTriggerX, step.floorY, isCur ? 4 : 2);
          g.endFill();
        }
      }
    }

    // ── Spawn-point markers ──────────────────────────────────────────────────
    // Draw a cross + circle at each tower's spawn point so map-builder
    // placement issues are immediately visible when B is pressed.
    const drawSpawnMarker = (sx: number, sy: number, color: number, label: string) => {
      const R = 8, ARM = 14;
      // Filled circle
      g.lineStyle(2, color, 1.0);
      g.beginFill(color, 0.25);
      g.drawCircle(sx, sy, R);
      g.endFill();
      // Cross arms
      g.lineStyle(2, color, 1.0);
      g.moveTo(sx - ARM, sy); g.lineTo(sx + ARM, sy);
      g.moveTo(sx, sy - ARM); g.lineTo(sx, sy + ARM);
      // Label
      const style = new PIXI.TextStyle({ fontSize: 11, fill: color, fontWeight: 'bold', stroke: 0x000000, strokeThickness: 3 });
      const text  = new PIXI.Text(`SPAWN ${label}`, style);
      text.x = sx + R + 3;
      text.y = sy - 8;
      g.addChild(text);
    };

    drawSpawnMarker(this.playerTower.spawnX, this.playerTower.spawnY, PLAYER_COLOR, 'P');
    drawSpawnMarker(this.enemyTower.spawnX,  this.enemyTower.spawnY,  ENEMY_COLOR,  'E');
  }

  /**
   * Apply AoE splash damage, knockback, tower damage, and sheep startle from a
   * single explosion event. Used by both grenades and rockets so the logic lives
   * in exactly one place.
   *
   * @param ex         Explosion descriptor from consumeExplosion()
   * @param sourceSide Side that fired — enemies of this side take damage
   * @param splashMinFrac   Minimum damage fraction at blast edge (0–1)
   * @param knockbackMaxVx  Max horizontal knockback velocity (px/s)
   * @param knockbackMaxVy  Max vertical knockback velocity (px/s)
   * @param knockbackDecay  Pre-computed decay factor: Math.exp(-decay * dt)
   * @param dt         Frame delta time (seconds)
   * @param liveChars  All living characters this tick
   */
  private processAoE(
    ex: { x: number; y: number; radius: number; damage: number; shooter: Character | null },
    sourceSide: 'player' | 'enemy',
    splashMinFrac: number,
    knockbackMaxVx: number,
    knockbackMaxVy: number,
    knockbackDecay: number,
    dt: number,
    liveChars: Character[],
  ): void {
    // Squared-distance early-reject: most enemies are outside the blast radius
    // on any given explosion, and Math.hypot is ~3-5× slower than dx*dx+dy*dy
    // because of its overflow protection. Only pay the sqrt for the hits.
    const radiusSq = ex.radius * ex.radius;
    for (const c of liveChars) {
      if (c.side === sourceSide) continue;
      const dx = c.x - ex.x;
      const dy = c.y - ex.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > radiusSq) continue;
      const dist = Math.sqrt(d2);
      // Damage falls off linearly from full at the centre to splashMinFrac at the edge
      const frac = 1 - (dist / ex.radius) * (1 - splashMinFrac);
      c.takeDamage(Math.round(ex.damage * frac), ex.shooter ?? undefined);
      // Knockback: outward from blast centre, stronger at closer range
      const kFrac = 1 - dist / ex.radius;
      const len   = dist || 1;
      c.applyKnockback(
        (dx / len) * knockbackMaxVx * kFrac,
        (dy / len) * knockbackMaxVy * kFrac,
        dt,
        knockbackDecay,
      );
    }
    // Tower damage: use closest point on the cached tower AABB to the blast centre
    const targetTower = sourceSide === 'player' ? this.enemyTower : this.playerTower;
    const tab         = sourceSide === 'player' ? this.enemyTowerAABB : this.playerTowerAABB;
    const nearX = Math.max(tab.left, Math.min(tab.right,  ex.x));
    const nearY = Math.max(tab.top,  Math.min(tab.bottom, ex.y));
    const tdx = nearX - ex.x, tdy = nearY - ex.y;
    if (tdx * tdx + tdy * tdy <= radiusSq) {
      targetTower.takeDamage(ex.damage);
    }
    if (this.sheep) {
      const sdx = this.sheep.x - ex.x, sdy = this.sheep.y - ex.y;
      const sheepR = ex.radius + 20;
      if (sdx * sdx + sdy * sdy <= sheepR * sheepR) this.sheep.reactToHit(ex.x);
    }
  }

  private notifyCoins() {
    const floored = Math.floor(this.coinBalance);
    if (floored !== this.lastNotifiedCoins) {
      this.lastNotifiedCoins = floored;
      this.onCoinsChanged(floored);
    }
  }

  private notifyCpuCoins() {
    const floored = Math.floor(this.cpuCoinBalance);
    if (floored !== this.lastNotifiedCpuCoins) {
      this.lastNotifiedCpuCoins = floored;
      this.onCpuCoinsChanged(floored);
    }
  }

  private notifyCpuStrategy() {
    const i = this.cpuStrategyInfo;
    const sig = `${i.stance}|${i.score.toFixed(1)}|${i.unitAdv.toFixed(1)}|${i.towerAdv.toFixed(2)}|${i.coinAdv.toFixed(2)}|${i.decision}`;
    if (sig === this.lastCpuStrategySig) return;
    this.lastCpuStrategySig = sig;
    this.onCpuStrategyChanged({ ...i });
  }

  private notifyEnemyTowerHp() {
    const hp = Math.ceil(this.enemyTower.hp);
    if (hp === this.lastNotifiedEnemyTowerHp) return;
    this.lastNotifiedEnemyTowerHp = hp;
    this.onEnemyTowerHpChanged(hp, TOWER_HP);
  }

  private notifyPlayerTowerHp() {
    const hp = Math.ceil(this.playerTower.hp);
    if (hp === this.lastNotifiedPlayerTowerHp) return;
    this.lastNotifiedPlayerTowerHp = hp;
    this.onPlayerTowerHpChanged(hp, TOWER_HP);
  }

  private notifyCpuChars() {
    // Walk the prepooled enemyLive array once. Build a change-detection signature
    // by string-concatenation in a single pass (no intermediate filter/map array).
    // Collapse behavior to the same 3 buckets the dev panel renders
    // ('Collect' | 'Harass' | 'Attack' — defend / rush / attacking all show as
    // 'Attack'), so stance-driven defend↔attacking flips across the whole
    // roster don't force a wasted innerHTML rewrite on the consumer side.
    let sig = '';
    for (const c of this.enemyLive) {
      const bucket = c.behavior === 'collecting' ? 'C'
                   : c.behavior === 'harass'     ? 'H'
                   : 'A';
      sig += c.id + ':' + bucket + ',';
    }
    if (sig === this.lastCpuCharsSig) return;
    this.lastCpuCharsSig = sig;
    // Only allocate the snapshot array on the change path.
    const snapshot = new Array<{ id: number; name: string; type: string; behavior: string }>(this.enemyLive.length);
    for (let i = 0; i < this.enemyLive.length; i++) {
      const c = this.enemyLive[i];
      snapshot[i] = { id: c.id, name: c.name, type: c.config.id, behavior: c.behavior };
    }
    this.onCpuCharsChanged(snapshot);
  }

  // ── CPU collect AI ───────────────────────────────────────────────────────────

  private tickCpuCollectAI(self: 'player' | 'enemy', selfChars: Character[], liveCoins: Coin[]) {
    const stance     = self === 'enemy' ? this.cpuStance : this.playerStance;
    const allIn      = self === 'enemy' ? this.cpuAllIn  : this.playerAllIn;
    const noteDecision = (msg: string) => { if (self === 'enemy') this.cpuStrategyInfo.decision = msg; };

    // Runners: keep them on the job (the behaviour AI never touches collecting
    // units, but a retreat or a dev command could); all-in releases them.
    const runners = this.runners[self];
    for (const r of runners) if (r.isDead) runners.delete(r);
    for (const r of runners) {
      if (allIn) { r.behavior = 'attacking'; runners.delete(r); }
      else if (r.behavior !== 'collecting') r.behavior = 'collecting';
    }
    const collectors = selfChars.filter(c => c.behavior === 'collecting' && !runners.has(c));

    // Desired collector count by stance — carrying collectors always finish
    // their run. Endgame all-in wants zero: coins can't flip a tower-HP
    // deficit in the final stretch, but another attacker might.
    const baseWanted =
      stance === 'push'   ? 1 :
      stance === 'defend' ? (selfChars.length >= 3 ? 1 : 0) : 2;
    // blueCoinPriority: a blue coin is worth ~7 gold — always worth one runner.
    const jackpot = this.cpuFeatures[self].has('blueCoinPriority') && liveCoins.some(c => c.value >= BLUE_COIN_VALUE);
    // Runners count toward the total, so combat units are only drafted to
    // collect when the runners alone don't cover the stance's wanted count.
    const wantedCollectors = allIn ? 0 : Math.max(0, Math.max(baseWanted, jackpot ? 1 : 0) - runners.size);

    // Recall excess non-carrying collectors — track count inline, no inner filter
    let activeCount = collectors.length;
    if (activeCount > wantedCollectors) {
      for (const c of collectors) {
        if (activeCount <= wantedCollectors) break;
        if (!c.isCarryingCoin) {
          c.behavior = 'attacking';
          activeCount--;
          noteDecision(`← Recalled #${c.id} (${c.config.id})`);
        }
      }
    }

    if (liveCoins.length > 0) {
      if (activeCount < wantedCollectors) {
        // Draft the unengaged unit closest to a coin. 'attacking' marchers and
        // 'harass' units holding at the safe line are both eligible — in defend
        // stance NOBODY has behavior 'attacking' (melee → defend, ranged →
        // harass), so without the harass fallback a turtling CPU never collects
        // a single coin and starves its own economy. Tankers and heavies are
        // too valuable for collection runs.
        let best: Character | null = null;
        let minDist = Infinity;
        for (const c of selfChars) {
          if (c.config.id === 'tanker' || c.config.id === 'heavy') continue;
          const eligible =
            (c.behavior === 'attacking' && c.state === 'marching') ||
            (c.behavior === 'harass'    && c.state !== 'fighting');
          if (!eligible) continue;
          for (const coin of liveCoins) {
            const d = Math.abs(c.x - coin.x);
            if (d < minDist) { minDist = d; best = c; }
          }
        }
        if (best) {
          best.behavior = 'collecting';
          noteDecision(`→ Collect #${best.id} (${best.config.id})`);
        }
      }
    } else {
      for (const c of collectors) {
        if (!c.isCarryingCoin) {
          c.behavior = 'attacking';
          noteDecision(`← Attack #${c.id} (${c.config.id})`);
        }
      }
    }

    // ── Power-up fetch ─────────────────────────────────────────────────────────
    // Power-up pickup is proximity-only, so free heals / permanent attack
    // boosts otherwise sit unclaimed unless someone happens to walk by. Route
    // the closest unengaged unit through each settled power-up.
    // Validate existing assignments first (target taken/expired, fetcher died
    // or already arrived).
    for (const [pu, ch] of this.puFetchers) {
      const targetGone = pu.isDead || pu.isPickedUp;
      if (targetGone && !ch.isDead) ch.fetchX = null;
      if (targetGone || ch.isDead || ch.fetchX === null) this.puFetchers.delete(pu);
    }
    if (!allIn) {
      for (const pu of this.powerUps) {
        if (pu.isDead || pu.isPickedUp || !pu.isOnGround) continue;
        if (this.puFetchers.has(pu)) continue;
        // Nearest eligible unit: not already fetching, not on a coin run, not
        // mid-fight. Heal is wasted on a healthy unit — only near-full-HP
        // rosters skip it; otherwise prefer whoever is closest AND injured.
        const isHeal = pu.type === 'heal';
        let best: Character | null = null;
        let minDist = Infinity;
        for (const c of selfChars) {
          if (c.fetchX !== null || c.behavior === 'collecting' || c.state === 'fighting') continue;
          if (isHeal && c.hp >= c.maxHp * 0.9) continue;
          const d = Math.abs(c.x - pu.x);
          if (d < minDist) { minDist = d; best = c; }
        }
        if (best) {
          best.fetchX      = pu.x;
          best.fetchFloorY = this.surfaceYUnderPowerUp(pu);
          this.puFetchers.set(pu, best);
          noteDecision(`🎁 Fetch ${pu.type} #${best.id} (${best.config.id})`);
        }
      }
    }
  }

  /** Floor level a settled power-up rests on — a platform/block top whose span
   *  contains it and whose height matches the resting position, else ground. */
  private surfaceYUnderPowerUp(pu: PowerUp): number {
    const restY = pu.y + POWERUP_BODY_RADIUS;   // body centre → bottom edge
    for (const p of this.platformData) {
      if (pu.x >= p.x && pu.x <= p.x + p.width && Math.abs(restY - p.y) < 25) return p.y;
    }
    for (const b of this.blockData) {
      if (pu.x >= b.x && pu.x <= b.x + b.width && Math.abs(restY - b.y) < 25) return b.y;
    }
    return this.mapGroundY;
  }

  // ── CPU behaviour AI ─────────────────────────────────────────────────────────

  private tickCpuBehaviorAI(self: 'player' | 'enemy', selfChars: Character[], oppChars: Character[]) {
    const stance    = self === 'enemy' ? this.cpuStance : this.playerStance;
    const allIn     = self === 'enemy' ? this.cpuAllIn  : this.playerAllIn;
    const noteDecision = (msg: string) => { if (self === 'enemy') this.cpuStrategyInfo.decision = msg; };

    // ── Tribe power-up auto-use ────────────────────────────────────────────────
    // Fire the side's ability when it pays off (cooldown gating lives in
    // activateTribePowerUp): buffs want a committed army, Vitality wants
    // wounded units, Plague wants targets. Runs before the all-in early-return
    // so a last-stand charge goes in buffed.
    {
      const puReady = (self === 'enemy' ? this.cpuTribePUCooldown : this.playerTribePUCooldown) <= 0;
      if (puReady) {
        const pu = self === 'enemy' ? this.cpuTribePU : this.playerTribePU;
        let fire = false;
        if (pu === 'speed' || pu === 'aggression') {
          fire = (stance === 'push' || allIn) && selfChars.length >= 3;
        } else if (pu === 'vitality') {
          let wounded = 0;
          for (const c of selfChars) if (c.hp < c.maxHp * 0.6) wounded++;
          fire = wounded >= 2;
        } else {   // plague
          fire = oppChars.length >= 3;
        }
        if (fire) this.activateTribePowerUp(self);
      }
    }

    // ── Endgame all-in ─────────────────────────────────────────────────────────
    // Losing on tower HP with the clock running out: every unit attacks the
    // tower directly. No harass (it holds outside tower range and deals zero
    // tower damage), no low-HP retreats (a unit healing at base contributes
    // nothing to flipping the HP deficit before timeout), no power-up detours.
    // rushFinisher: 'rush' charges straight at the tower and jumps blockers
    // instead of pathing around and trading with a wall — the right gait for
    // the last 75 s behind on tower HP and for finishing an undefended tower.
    const feat = this.cpuFeatures[self];
    const charge: 'rush' | 'attacking' = feat.has('rushFinisher') ? 'rush' : 'attacking';
    if (allIn) {
      this.tickWaveStaging(self, selfChars, false, 0, isMeleeStyle);
      for (const c of selfChars) {
        c.fetchX = null;   // abandon power-up fetches — tower damage only
        if (c.behavior === 'collecting') continue;  // collect AI recalls these
        if (c.behavior !== charge) {
          c.behavior = charge;
          noteDecision(`⚔ ALL-IN #${c.id} (${c.config.id}) — endgame`);
        }
      }
      return;
    }

    // Push finisher: with the opposition's field army (near-)wiped there is
    // nobody left to harass — harass units would idle at the safe line dealing
    // zero tower damage while the window to raze the tower closes. Send the
    // ranged line in with everyone else until new defenders appear.
    const oppCombat = oppChars.reduce((n, c) => n + (c.behavior !== 'collecting' ? 1 : 0), 0);
    const finisher  = stance === 'push' && oppCombat <= 1;

    // Attribute-driven role split (no type-name lists): close-combat styles
    // form the defensive wall / charge in pushes; snap-fire ranged styles
    // harass from safety. AoE (grenade/rocket) keeps its current behavior in
    // pushes and harasses on defence, same as before.
    const isMelee = isMeleeStyle;
    const isRangedUnit = (c: Character) =>
      c.config.attackStyle === 'arrow' || c.config.attackStyle === 'bullet';

    // ── Low-HP retreat (highest priority) ─────────────────────────────────────
    // A combat unit that drops to critical HP falls back to 'defend', pulling it
    // toward its own tower where the safe-zone passive regen heals it. It holds
    // that retreat (skipped by the stance logic below) until healed past the
    // recover threshold — hysteresis prevents it from bouncing straight back into
    // the fight at 1 HP. Collectors are left alone (they finish their coin run).
    // smartRetreat: ranged units are pulled earlier (one more volley kills a
    // 70–100 HP unit), and nobody starts a retreat from inside the enemy
    // tower's range — the walk home kills it anyway, so it commits.
    const smartRetreat   = feat.has('smartRetreat');
    const oppTowerFrontX = self === 'enemy' ? this.playerTower.frontX : this.enemyTower.frontX;
    for (const c of selfChars) {
      if (c.behavior === 'collecting') continue;
      const hpFrac = c.hp / c.maxHp;
      if (this.retreatingUnits.has(c)) {
        if (hpFrac >= CPU_RETREAT_RECOVER_FRAC) {
          this.retreatingUnits.delete(c);          // recovered — stance logic resumes control
        } else if (c.behavior !== 'defend') {
          c.behavior = 'defend';                    // keep falling back while healing
        }
      } else if (c.behavior === 'attacking' || c.behavior === 'harass' || c.behavior === 'rush') {
        const threshold = smartRetreat && isRangedUnit(c) ? CPU_RETREAT_HP_FRAC_RANGED : CPU_RETREAT_HP_FRAC;
        const committed = smartRetreat && Math.abs(c.x - oppTowerFrontX) <= TOWER_ATTACK_RANGE;
        if (hpFrac < threshold && !committed) {
          this.retreatingUnits.add(c);
          c.behavior = 'defend';
          noteDecision(`🚑 Retreat #${c.id} (${c.config.id}) — critical HP`);
        }
      }
    }

    if (stance === 'defend') {
      // Melee units form the defensive wall at home tower; ranged units harass from safety.
      for (const c of selfChars) {
        if (c.behavior === 'collecting') continue;
        if (this.retreatingUnits.has(c)) continue;   // healing at base — leave it alone
        if (isMelee(c)) {
          if (c.behavior !== 'defend') {
            c.behavior = 'defend';
            noteDecision(`🛡 Defend wall #${c.id} (${c.config.id})`);
          }
        } else {
          if (c.behavior !== 'harass') {
            c.behavior = 'harass';
            noteDecision(`↯ Harass #${c.id} (${c.config.id})`);
          }
        }
      }
    } else if (stance === 'push') {
      // Push: ranged units harass (advance safely), melee units charge. In
      // finisher mode the harass split is suspended — everyone attacks.
      for (const c of selfChars) {
        if (c.behavior === 'collecting') continue;
        if (this.retreatingUnits.has(c)) continue;   // healing at base — leave it alone
        const want: 'rush' | 'attacking' = finisher ? charge : 'attacking';
        if (c.behavior === 'defend' || (c.behavior === 'rush' && !finisher)) {
          // Lift lingering defend assignments, and stand rushers down once
          // the finisher window closes (new defenders appeared).
          c.behavior = !finisher && isRangedUnit(c) ? 'harass' : want;
          noteDecision(`⇒ Push #${c.id} (${c.config.id})`);
        } else if (!finisher && isRangedUnit(c) && c.behavior !== 'harass') {
          c.behavior = 'harass';
          noteDecision(`↯ Harass push #${c.id} (${c.config.id})`);
        } else if ((finisher || isMelee(c)) && c.behavior !== want) {
          c.behavior = want;
          noteDecision(finisher ? `⚔ Finish tower #${c.id} (${c.config.id})` : `⇒ Attack #${c.id} (${c.config.id})`);
        }
      }
    } else {
      // Economy: recall all harassers and defenders back to full attack
      for (const c of selfChars) {
        if (this.retreatingUnits.has(c)) continue;   // healing at base — leave it alone
        if (c.behavior === 'harass' || c.behavior === 'defend' || c.behavior === 'rush') {
          c.behavior = 'attacking';
          noteDecision(`⇒ Economy attack #${c.id} (${c.config.id})`);
        }
      }
    }

    this.tickWaveStaging(self, selfChars, stance === 'push' && !finisher && feat.has('stageWave'), oppTowerFrontX, isMelee);
  }

  // ── Wave staging ('stageWave') ──────────────────────────────────────────────
  // The tower shoots the nearest unit at 40 dmg/s, so attackers that trickle in
  // one at a time die one at a time. In a push, melee attackers first gather at
  // a line WAVE_STAGE_OFFSET outside the enemy tower's range (the ranged line
  // already holds nearby at the harass safeX) and are released together once
  // WAVE_MIN_UNITS have arrived or the first arrival has waited
  // WAVE_MAX_HOLD_SEC. The tankiest units stage WAVE_TANK_LEAD ahead so they
  // take the tower's first shots. Released units charge straight in for the
  // rest of the push; newly spawned ones form the next wave. Not used when the
  // enemy tower is critical (just finish it), in the finisher, or in all-in.
  private tickWaveStaging(
    self: 'player' | 'enemy', selfChars: Character[], active: boolean,
    oppTowerFrontX: number, isMelee: (c: Character) => boolean,
  ) {
    const w        = this.wave[self];
    const oppTower = self === 'enemy' ? this.playerTower : this.enemyTower;
    if (!active || oppTower.hp / TOWER_HP < 0.28) {
      if (w.released.size > 0 || w.holdSince !== null) { w.released.clear(); w.holdSince = null; }
      for (const c of selfChars) c.stageX = null;
      return;
    }
    for (const c of w.released) if (c.isDead) w.released.delete(c);

    const dir   = self === 'player' ? 1 : -1;
    const lineX = oppTowerFrontX - dir * (TOWER_ATTACK_RANGE + WAVE_STAGE_OFFSET);
    const tribe = tribeForSide(self);
    let staged = 0, arrived = 0;
    for (const c of selfChars) {
      const staging = c.behavior === 'attacking' && isMelee(c) && !w.released.has(c) && !this.retreatingUnits.has(c);
      if (!staging) { c.stageX = null; continue; }
      if (c.stageX === null) {
        const lead = Game.unitProfile(tribe, c.config.id).tanky >= WAVE_TANK_THRESHOLD ? WAVE_TANK_LEAD : 0;
        c.stageX      = lineX + dir * lead;
        c.stageFloorY = oppTower.baseY;
      }
      staged++;
      if (c.isAtStage) arrived++;
    }
    if (staged === 0 || arrived === 0) { w.holdSince = null; return; }
    const now = this.elapsedSeconds;
    if (w.holdSince === null) w.holdSince = now;
    const release = arrived >= Math.min(WAVE_MIN_UNITS, staged) || now - w.holdSince >= WAVE_MAX_HOLD_SEC;
    if (!release) return;
    for (const c of selfChars) {
      if (c.stageX !== null && c.isAtStage) { c.stageX = null; w.released.add(c); }
    }
    w.holdSince = null;
    if (self === 'enemy') this.cpuStrategyInfo.decision = `🌊 Wave released — ${arrived} unit${arrived === 1 ? '' : 's'}`;
  }

  private fireProjectile(req: FireRequest) {
    if (req.projectileKind === 'grenade') {
      playSoundAt('grenade_throw', req.sx);
      const g = new Grenade(
        req.side, req.sx, req.sy, req.tx, req.ty,
        req.damage, GRENADE_FUSE_S, GRENADE_SPLASH_R, GRENADE_GRAVITY, GRENADE_MAX_VX,
        req.shooter ?? null, this.mapGroundY,
      );
      this.grenades.push(g);
      this.grenadeLayer.addChild(g.container);
    } else if (req.projectileKind === 'rocket') {
      playSoundAt('rocket_launch', req.sx);
      const r = new Rocket(
        req.side, req.sx, req.sy, req.tx,
        req.damage, ROCKET_FUSE_S, ROCKET_SPLASH_R, ROCKET_GRAVITY, ROCKET_LAUNCH_VX,
        req.shooter ?? null, this.mapGroundY,
      );
      this.rockets.push(r);
      this.rocketLayer.addChild(r.container);
    } else {
      playSoundAt(
        req.projectileKind === 'arrow'         ? 'arrow_fire'  :
        req.shooter?.config.id === 'sniper'  ? 'sniper_shot' :
        'gun_fire',
        req.sx,
      );
      const p = new Projectile(req.side, req.sx, req.sy, req.tx, req.ty, req.damage, req.projectileKind, req.shooter ?? null);
      this.projectiles.push(p);
      this.projLayer.addChild(p.container);
    }
  }

  // ── Game state ───────────────────────────────────────────────────────────────

  private end(winner: 'player' | 'enemy', reason: 'tower' | 'timeout') {
    this.isOver = true;
    this.stopBerserk(false);   // tickBerserk no longer runs — don't leave the box frozen mid-shake
    // Push one final HP sync before tick() starts early-exiting at `isOver`:
    // the killing blow lands after this tick already ran its notify pass, so
    // without this the top HUD freezes on the pre-fatal value and a tower that
    // just fell still reads e.g. "14" next to the Defeat banner.
    this.notifyEnemyTowerHp();
    this.notifyPlayerTowerHp();
    // Leave the ticker attached: tick() early-exits at `if (this.isOver)` so
    // game logic doesn't run, but camera pan + sprite playback + culling all
    // need to keep ticking so the player can move the map around after the
    // match ends.
    for (const c of this.characters) c.freezeForGameOver();
    this.onGameOver(winner, reason);
  }

  /** Bytes of every base texture currently holding a GL texture (sprite
   *  atlases, map skins, text) — RGBA estimate for the dev perf panel. */
  gpuTextureBytes(): number {
    const renderer = this.app.renderer;
    if (!('texture' in renderer)) return 0;
    let bytes = 0;
    for (const t of (renderer as PIXI.Renderer).texture.managedTextures) bytes += t.realWidth * t.realHeight * 4;
    return bytes;
  }

  /** Every skin URL the current map + tribe tower templates can load — the
   *  per-map slice of the Assets cache. Shared defaults (coin PNGs, coin-box
   *  skin, power-up art) are deliberately absent so they're never evicted. */
  private collectMapAssetUrls(): Set<string> {
    const m = this.mapDef;
    const urls = [
      m.backgroundSkin, m.backgroundSkin2, m.groundSkin, m.coinBox.skin,
      m.coinSkins?.gold, m.coinSkins?.silver, m.coinSkins?.blue,
      ...m.platforms.map(p => p.skin),
      ...m.blocks.map(b => b.skin),
      ...(m.decor ?? []).map(d => d.skin),
      getTowerTemplate(getPlayerTribe()).skin,
      getTowerTemplate(getEnemyTribe()).skin,
    ];
    return new Set(urls.filter((u): u is string => !!u));
  }

  reset(mapDef?: MapDefinition) {
    if (mapDef) {
      this.mapDef = mapDef;
      // "Map drives both sides": loading a map seeds both tribes from its
      // per-placeholder defaults. The dev panel may override the player tribe
      // afterwards via its own setPlayerTribe + restart.
      setPlayerTribe(mapDef.playerTowerTribe ?? 'kattgard');
      setEnemyTribe(mapDef.enemyTowerTribe   ?? 'lapinor');
    }
    this.app.ticker.remove(this.tickFn);

    for (const c of this.characters)    { c.destroy(); }
    for (const p of this.projectiles)   { p.destroy(); }
    for (const g of this.grenades)      { g.destroy(); }
    for (const r of this.rockets)       { r.destroy(); }
    for (const coin of this.coins)      { coin.destroy(); }
    for (const pu of this.powerUps)     { pu.destroy(); }
    for (const l of this.damageLabels)  { l.destroy(); }
    for (const d of this.decorObjects)  { d.destroy(); }
    this.decorObjects = [];
    clearVfx();
    this.shakeTrauma = 0;
    this.sheep?.destroy();
    this.sheep = null;
    this.characters   = [];
    this.projectiles  = [];
    this.grenades     = [];
    this.rockets      = [];
    this.coins        = [];
    this.powerUps     = [];
    this.damageLabels = [];
    this.powerUpTimer           = 0;
    this.berserkRemaining       = 0;
    this.berserkTimer           = berserkDelay(false);
    this.berserkPhase           = 0;
    this.powerUpIndicatorActive = false;
    this.powerUpLastCountdown   = -1;
    this.isOver                = false;
    this.isPaused              = false;
    this.matchStats            = { playerKills: 0, playerDeaths: 0, playerSpawns: 0, playerSpawnsByType: {} };
    this.nextCharId            = 1;
    this.freeCharIds           = [];
    this.lastCpuCharsSig       = '';
    this.lastCpuStrategySig    = '';
    this.cpuStance             = 'economy';
    this.playerStance          = 'economy';
    this.cpuAllIn              = false;
    this.playerAllIn           = false;
    this.oppThreat             = { player: 0, enemy: 0 };
    this.oppThreatBaseline     = { player: 0, enemy: 0 };
    this.stanceSince           = { player: 0, enemy: 0 };
    this.scoreEma              = { player: null, enemy: null };
    this.scoreTotalEma         = { player: null, enemy: null };
    for (const w of [this.wave.player, this.wave.enemy]) { w.released.clear(); w.holdSince = null; }
    this.runners.player.clear(); this.runners.enemy.clear();
    this.puFetchers.clear();
    // Tribe power-ups: fresh cooldowns; the CPU picks its ability for the new
    // match (uniform random — all four are situationally strong). The player's
    // pick persists (set from the squad screen via setPlayerTribePowerUp).
    this.playerTribePUCooldown = 0;
    this.cpuTribePUCooldown    = 0;
    this.playerVitalityTimer   = 0;
    this.cpuVitalityTimer      = 0;
    this.cpuTribePU = TRIBE_PU_IDS[Math.floor(Math.random() * TRIBE_PU_IDS.length)];
    this.cpuStrategyInfo       = { stance: 'economy', score: 0, unitAdv: 0, towerAdv: 0, coinAdv: 0, decision: '—' };
    this.coinBalance           = STARTING_COINS;
    this.cpuCoinBalance        = STARTING_COINS;
    this.lastNotifiedCoins     = -1;
    this.lastNotifiedCpuCoins  = -1;
    this.lastNotifiedEnemyTowerHp  = -1;
    this.lastNotifiedPlayerTowerHp = -1;
    this.timeRemaining         = this.mapDurationSec;
    this.lastNotifiedTime      = -1;
    // Every type on both sides starts the match on its own cooldown. Armed at
    // elapsedSeconds = 0 (timeRemaining was just reset above), and the match
    // sits paused behind the 3-2-1 countdown, so the clocks start at GO.
    for (const side of ['player', 'enemy'] as const) {
      this.spawnReadyAt[side].clear();
      this.spawnCooldownLen[side].clear();
      for (const type of TRIBE_ROSTERS[tribeForSide(side)]) this.armSpawnCooldown(side, type);
    }

    this.notifyCpuCharsMs    = 0;
    this.notifyCpuStrategyMs = 0;
    this.cpuStanceMs         = 0;
    this.cpuCollectAIMs      = 0;
    this.cullingFrame        = 0;
    this.cameraX = 0;
    // cameraY default (restCameraY) is set by build() from the player tower baseY
    this.hud.clear();
    // removeChildren() alone would leak the old scene tree (Graphics geometry,
    // Text canvas textures in towers/indicator, parallax layers) on every
    // restart — destroy the detached children. Entities were already destroyed
    // above (their containers detach themselves), and texture defaults to
    // false so Assets-cached sprite textures survive for the rebuild.
    for (const child of this.app.stage.removeChildren()) child.destroy({ children: true });
    const prevAssetUrls = this.mapAssetUrls;
    this.build();
    // Evict the previous map's skins the new scene doesn't reuse — backgrounds,
    // decor, platform art and tower skins would otherwise stay cached (and
    // decoded) for the rest of the session. Every entity that held one of
    // these textures was destroyed above.
    this.mapAssetUrls = this.collectMapAssetUrls();
    const staleUrls = [...prevAssetUrls].filter(u => !this.mapAssetUrls.has(u));
    if (staleUrls.length > 0) void unloadSkinTextures(staleUrls);
    this.resetSpawnTimerFirst('enemy');
    if (this.cpuVsCpu) this.resetSpawnTimerFirst('player');
    this.resetCoinDropTimer();
    this.resetSilverDropTimer();
    this.resetBlueDropTimer();
    this.app.ticker.add(this.tickFn);

    this.notifyCoins();
    this.notifyCpuCoins();
    this.notifyEnemyTowerHp();
    this.notifyPlayerTowerHp();
    this.onTimeChanged(this.mapDurationSec);
  }

  destroy() {
    this.setFastForward(1);
    this.app.ticker.remove(this.tickFn);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup',   this.onKeyUp);
    this.hud.clear();
    this.app.destroy(false, { children: true });
  }
}
