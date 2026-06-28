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
import { getSpriteSet } from './SpriteRegistry';
import { tribeForSide, TRIBE_ROSTERS, heavyMeleeForTribe, getPlayerTribe, getEnemyTribe, setPlayerTribe, setEnemyTribe } from './Tribes';
import { getRenderScale } from './resolution';
import type { PlatformData } from './Platform';
import type { BlockData } from './Block';
import type { CollisionBoxData } from './CollisionBox';
import { NavGraph } from './Pathfinding';
import { Diagnostics } from './Diagnostics';
import {
  PLAYER_COLOR, ENEMY_COLOR,
  VIEWPORT_WIDTH, GAME_HEIGHT, GAME_DURATION_SEC, GAME_ZOOM,
  TOWER_WIDTH,
  GROUND_Y, TOWER_HEIGHT, TOWER_HP,
  CONSCRIPT, WARRIOR, ARCHER, RIFLEMAN, GUNSLINGER, SNIPER, VIKING, KNIGHT, HEAVY, TANKER, GRENADIER, ROCKETEER, SHOCKTROOPER,
  GRENADE_FUSE_S, GRENADE_SPLASH_R, GRENADE_GRAVITY, GRENADE_MAX_VX, GRENADE_SPLASH_MIN_FRAC,
  GRENADE_KNOCKBACK_MAX_VX, GRENADE_KNOCKBACK_MAX_VY, GRENADE_KNOCKBACK_DECAY, ATTACK_KNOCKBACK_DECAY,
  ROCKET_FUSE_S, ROCKET_SPLASH_R, ROCKET_GRAVITY, ROCKET_LAUNCH_VX, ROCKET_SPLASH_MIN_FRAC,
  ROCKET_HIT_RADIUS, ROCKET_KNOCKBACK_MAX_VX, ROCKET_KNOCKBACK_MAX_VY, ROCKET_KNOCKBACK_DECAY,
  CPU_SPAWN_MIN_MS, CPU_SPAWN_MAX_MS, CPU_FIRST_SPAWN_MAX,
  STARTING_COINS, CHAR_COST,
  PASSIVE_INCOME_RATE, LOW_BALANCE_THRESHOLD, LOW_BALANCE_INCOME_MULT,
  COIN_VALUE, KILL_REWARD, TOWER_KILL_REWARD, COIN_DROP_MIN_MS, COIN_DROP_MAX_MS,
  COIN_LIFETIME_S,
  COIN_DROP_VX_MIN, COIN_DROP_VX_MAX, COIN_DROP_VY_MIN, COIN_DROP_VY_MAX,
  COIN_GRAVITY,
  SILVER_COIN_VALUE, SILVER_DROP_MIN_MS, SILVER_DROP_MAX_MS,
  BLUE_COIN_VALUE, BLUE_DROP_MIN_MS, BLUE_DROP_MAX_MS,
  CPU_PRESSURE_THRESHOLD,
  CPU_URGENT_MAX_FACTOR, CPU_COMFORT_MIN_FACTOR,
  CPU_NEUTRAL_MIN_FACTOR, CPU_NEUTRAL_MAX_FACTOR,
  CPU_RETREAT_HP_FRAC, CPU_RETREAT_RECOVER_FRAC,
  POWERUP_DROP_INTERVAL, POWERUP_INDICATOR_LEAD,
  CHEAT_PLAYER_COIN_GRANT, CHEAT_CPU_COIN_GRANT,
  SHAKE_DECAY, SHAKE_MAX_OFFSET, SHAKE_GRENADE, SHAKE_ROCKET, SHAKE_FALLOFF_PX,
} from './constants';
import { playSoundAt, setViewport } from './AudioManager';
import { initVfx, initAfterImageLayer, tickVfx, clearVfx, spawnHitSpark, spawnExplosion } from './Vfx';

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

const CHAR_CONFIGS = {
  conscript: CONSCRIPT,
  warrior:   WARRIOR,
  archer:    ARCHER,
  rifleman:  RIFLEMAN,
  gunslinger: GUNSLINGER,
  sniper:    SNIPER,
  viking:    VIKING,
  shocktrooper: SHOCKTROOPER,
  knight:    KNIGHT,
  heavy:     HEAVY,
  tanker:    TANKER,
  grenadier: GRENADIER,
  rocketeer: ROCKETEER,
} as const;

const PARALLAX_FACTOR     = 0.15; // near background scrolls at 15 % of world camera speed
const PARALLAX_FACTOR_FAR = 0.05; // far background scrolls at 5 % — feels more distant

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

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;   // primary button only — don't fight right-click menus
    this.isDragging       = true;
    this.dragStartClientX = e.clientX;
    this.dragStartClientY = e.clientY;
    this.dragStartCameraX = this.cameraX;
    this.dragStartCameraY = this.cameraY;
    const c = this.app.view as HTMLCanvasElement;
    c.style.cursor = 'grabbing';
    c.setPointerCapture?.(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.isDragging) return;
    // Inverse drag: dragging the map right/down (positive dx/dy) should shift
    // the camera left/up so the user feels they're sliding the world.
    // Divide by GAME_ZOOM so 1 client px == 1 world px regardless of zoom.
    const dx = e.clientX - this.dragStartClientX;
    const dy = e.clientY - this.dragStartClientY;
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
  private isOver           = false;
  private isPaused         = false;

  private readonly hud:               CharacterHUD;
  private readonly onGameOver:         (winner: 'player' | 'enemy', reason: 'tower' | 'timeout') => void;
  private readonly onCoinsChanged:     (amount: number) => void;
  private readonly onCpuCoinsChanged:  (amount: number) => void;
  private readonly onCpuCharsChanged:    (chars: { id: number; name: string; type: string; behavior: string }[]) => void;
  private readonly onCpuStrategyChanged: (info: CpuStrategyInfo) => void;
  private readonly onTimeChanged:        (seconds: number) => void;
  private readonly onEnemyTowerHpChanged: (hp: number, maxHp: number) => void;
  private readonly tickFn:               (dt: number) => void;

  private lastCpuCharsSig     = '';
  private lastCpuStrategySig  = '';
  private cpuStance: 'push' | 'economy' | 'defend' = 'economy';
  private playerStance: 'push' | 'economy' | 'defend' = 'economy';
  // AI combat units currently retreating to heal (low HP). WeakSet so dead units
  // are GC'd automatically without manual cleanup.
  private readonly retreatingUnits = new WeakSet<Character>();
  private playerSpawnTimer    = 0;
  private playerSpawnInterval = 0;
  private cpuVsCpu            = false;
  private gameShark           = false;
  // Dev override: when set, the CPU (enemy) buys this unit type every spawn,
  // bypassing the stance-driven AI order. null = normal AI behavior.
  private cpuForcedType: CharacterConfig['type'] | null = null;
  private timeRemaining    = this.mapDurationSec;
  private lastNotifiedTime = -1;
  private cpuStrategyInfo: CpuStrategyInfo = {
    stance: 'economy', score: 0, unitAdv: 0, towerAdv: 0, coinAdv: 0, decision: '—',
  };
  private lastNotifiedEnemyTowerHp = -1;

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
    onEnemyTowerHpChanged: (hp: number, maxHp: number) => void,
  ) {
    this.onGameOver             = onGameOver;
    this.onCoinsChanged         = onCoinsChanged;
    this.onCpuCoinsChanged      = onCpuCoinsChanged;
    this.onCpuCharsChanged      = onCpuCharsChanged;
    this.onCpuStrategyChanged   = onCpuStrategyChanged;
    this.onTimeChanged          = onTimeChanged;
    this.onEnemyTowerHpChanged  = onEnemyTowerHpChanged;
    this.hud            = new CharacterHUD(hudEl);
    this.tickFn         = (_dt) => this.tick();

    this.app = new PIXI.Application({
      view: canvas,
      width:  VIEWPORT_WIDTH,
      height: GAME_HEIGHT,
      resolution: getRenderScale(),  // backing-store density from the resolution setting
      autoDensity: true,             // keep the canvas's displayed CSS size at the logical size
      backgroundColor: 0x87ceeb,
      antialias: false,
    });

    // Seed tribes from the initial map's defaults so build() reads the
    // correct tribe for each side. Mirrors the same logic in reset().
    setPlayerTribe(this.mapDef.playerTowerTribe ?? 'kattgard');
    setEnemyTribe(this.mapDef.enemyTowerTribe   ?? 'lapinor');

    this.build();
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
    this.onTimeChanged(this.mapDurationSec);
  }

  // ── Scene construction ───────────────────────────────────────────────────────

  private build() {
    const m = this.mapDef;
    this.mapGroundY = (m.worldHeight ?? GAME_HEIGHT) - (m.groundHeight ?? (GAME_HEIGHT - GROUND_Y));
    // Default vertical scroll: ground surface sits 60px above the canvas bottom.
    this.cameraY = (GAME_HEIGHT - 60 - this.mapGroundY) / GAME_ZOOM;
    const towerFaceL = m.playerTowerX + TOWER_WIDTH / 2;
    const towerFaceR = m.enemyTowerX  - TOWER_WIDTH / 2;

    this.world = new PIXI.Container();

    buildBackground(this.world, m.worldWidth);
    this.rangeMarkers = buildTowerRangeMarkers(this.world, m.playerTowerX, m.enemyTowerX);
    this.rangeMarkers.visible = this.devMode;
    buildCoinBox(this.world, m.coinBox);

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
      PIXI.Assets.load<PIXI.Texture>(m.backgroundSkin2)
        .then(tex => {
          const sprite = new PIXI.Sprite(tex);
          sprite.y      = m.backgroundSkin2Y ?? 0;
          sprite.width  = parallaxWide2;
          sprite.height = this.mapGroundY;
          this.parallaxGfx2.addChild(sprite);
        })
        .catch(() => { /* silent — far layer is purely optional */ });
    }
    this.app.stage.addChild(this.parallaxGfx2);

    // Near layer — image skin or procedural mountains.
    this.parallaxGfx = new PIXI.Container();
    if (m.backgroundSkin) {
      PIXI.Assets.load<PIXI.Texture>(m.backgroundSkin)
        .then(tex => {
          const sprite = new PIXI.Sprite(tex);
          sprite.y      = m.backgroundSkinY ?? 0;
          sprite.width  = parallaxWide;
          sprite.height = this.mapGroundY;
          this.parallaxGfx.addChild(sprite);
        })
        .catch(() => {
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

  /** Returns false if the player cannot afford this unit. */
  spawnPlayer(type: CharacterConfig['type']): boolean {
    if (this.isOver) return false;
    const cost = CHAR_COST[type];
    if (this.coinBalance < cost) return false;

    this.coinBalance -= cost;
    this.notifyCoins();

    const config  = withSpawnBoosts(CHAR_CONFIGS[type]);
    // Offset by half the character body width so the unit's tower-side edge
    // (not centre) sits at the tribe's configured spawn point — keeps the
    // body from overlapping the tower physics box.
    const spawnX  = this.playerTower.spawnX + config.width / 2;
    const c = new Character('player', spawnX, this.playerTower.spawnY, config, this.allocateCharId(), pickName(), this.physics, getSpriteSet(tribeForSide('player'), type), this.mapGroundY);
    this.characters.push(c);
    this.unitLayer.addChild(c.container);
    this.hud.add(c);
    return true;
  }

  get paused() { return this.isPaused; }

  /** Re-apply the current resolution setting to the renderer's backing store.
   *  Logical size and the canvas's displayed CSS size are unchanged — only the
   *  pixel density changes, so the HTML UI overlays stay aligned. */
  applyResolution(): void {
    this.app.renderer.resolution = getRenderScale();
    this.app.renderer.resize(VIEWPORT_WIDTH, GAME_HEIGHT);
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

  /** Dev: force the CPU (enemy) to purchase a specific unit type every spawn,
   *  bypassing its stance-driven AI order. Pass null to restore normal AI. */
  setCpuForcedType(type: CharacterConfig['type'] | null): void { this.cpuForcedType = type; }
  getCpuForcedType(): CharacterConfig['type'] | null { return this.cpuForcedType; }

  /** Dev cheat: when ON the player's coin balance is pinned to 9999. */
  setGameShark(on: boolean): void { this.gameShark = on; }

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

  private assessCpuStance(self: 'player' | 'enemy', selfChars: Character[], oppChars: Character[]): 'push' | 'economy' | 'defend' {
    const selfTower = self === 'enemy' ? this.enemyTower : this.playerTower;
    const oppTower  = self === 'enemy' ? this.playerTower : this.enemyTower;
    const selfCoins = self === 'enemy' ? this.cpuCoinBalance : this.coinBalance;
    const oppCoins  = self === 'enemy' ? this.coinBalance    : this.cpuCoinBalance;

    const typeWeight = (type: string) =>
      type === 'tanker'   ? 2.5 :
      type === 'heavy'    ? 1.8 :
      type === 'sniper'   ? 1.4 :
      type === 'rifleman' ? 1.3 :
      type === 'gunslinger' ? 1.3 :
      type === 'archer'   ? 1.2 : 1.0;
    const threat = (chars: Character[], discountCollecting: boolean) =>
      chars.reduce((s, c) => {
        const behaviorMult = discountCollecting && c.behavior === 'collecting' ? 0.15 : 1.0;
        return s + (c.hp / c.maxHp) * typeWeight(c.config.type) * behaviorMult;
      }, 0);

    const oppStr  = threat(oppChars,  true);   // opponent's collectors aren't a real threat
    const selfStr = threat(selfChars, false);  // own strength unmodified
    const unitAdv   = selfStr - oppStr;
    const towerAdv  = (selfTower.hp / TOWER_HP) - (oppTower.hp / TOWER_HP);
    const coinAdv   = Math.min(1, Math.max(-1, (selfCoins - oppCoins) / 120));
    const score     = unitAdv * 1.5 + towerAdv * 2.5 + coinAdv * 0.5;

    // Store intermediate values for the dev panel — only from the canonical CPU (enemy) perspective
    if (self === 'enemy') {
      this.cpuStrategyInfo.score    = score;
      this.cpuStrategyInfo.unitAdv  = unitAdv;
      this.cpuStrategyInfo.towerAdv = towerAdv;
      this.cpuStrategyInfo.coinAdv  = coinAdv;
    }

    let stance: 'push' | 'economy' | 'defend';
    // Critical tower overrides
    if (selfTower.hp / TOWER_HP < 0.28)      stance = 'defend';
    else if (oppTower.hp / TOWER_HP < 0.28)  stance = 'push';
    else if (score >  0.8)                   stance = 'push';
    else if (score < -0.7)                   stance = 'defend';
    else                                     stance = 'economy';

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

    const stance    = self === 'enemy' ? this.cpuStance : this.playerStance;
    const pressure  = oppChars.length - selfChars.length;
    const balance   = self === 'enemy' ? this.cpuCoinBalance : this.coinBalance;
    // spawnX is computed per unit type (width varies) — see cpuSpawnX below
    const spawnY    = self === 'enemy' ? this.enemyTower.spawnY : this.playerTower.spawnY;

    // Dev override: force the CPU (enemy) to buy a specific type, bypassing the
    // stance AI and roster filter entirely. Saves toward it when it can't afford.
    if (self === 'enemy' && this.cpuForcedType) {
      const type = this.cpuForcedType;
      const cost = CHAR_COST[type];
      if (this.cpuCoinBalance >= cost) {
        this.cpuCoinBalance -= cost;
        const c = this.spawnCpuUnit(self, type, spawnY);
        this.cpuStrategyInfo.decision = `Forced ${type} #${c.id}`;
      } else {
        this.cpuStrategyInfo.decision = `Saving (forced ${type}) — need ${cost} (have ${Math.floor(this.cpuCoinBalance)})`;
      }
      this.resetSpawnTimer(self, pressure);
      return;
    }

    // Tanker is intentionally excluded from every order array — it's hidden
    // from both the player UI and the CPU until further notice.
    type UnitType = 'warrior' | 'archer' | 'rifleman' | 'gunslinger' | 'sniper' | 'viking' | 'knight' | 'heavy' | 'rocketeer' | 'grenadier';
    let order: UnitType[];

    // Opponent cluster result is pre-computed every 500 ms alongside the stance
    // assessment — no need to run the O(n²) scan here on every spawn call.
    const opponentsClustered = self === 'enemy'
      ? this.cachedEnemyOppClustered
      : this.cachedPlayerOppClustered;

    if (stance === 'push') {
      if (opponentsClustered && balance >= CHAR_COST.rocketeer) {
        // Splash-heavy: opponents are bunched up, prefer rockets/grenades
        order = ['rocketeer', 'grenadier', 'rifleman', 'knight', 'heavy', 'warrior', 'archer'];
      } else if (opponentsClustered && balance >= CHAR_COST.grenadier) {
        order = ['grenadier', 'rifleman', 'knight', 'heavy', 'warrior', 'archer'];
      } else {
        // Aggressive push: flood high-damage units; knight leads the melee wedge
        order = ['knight', 'rifleman', 'gunslinger', 'heavy', 'warrior', 'archer'];
      }
    } else if (stance === 'defend') {
      if (pressure >= 3) {
        // Severely outnumbered — knight tanks while warriors plug the gap
        order = ['knight', 'warrior', 'heavy', 'archer', 'sniper'];
      } else {
        // Steady defence: archers for harassment, knight as frontline wall
        order = ['archer', 'knight', 'warrior', 'sniper'];
      }
    } else {
      // Economy: invest in better units
      if (balance >= CHAR_COST.sniper && selfChars.length >= 3) {
        order = ['sniper', 'rifleman', 'knight', 'archer', 'heavy', 'warrior'];
      } else if (balance >= CHAR_COST.knight) {
        order = ['knight', 'rifleman', 'gunslinger', 'archer', 'heavy', 'warrior'];
      } else if (balance >= CHAR_COST.rifleman) {
        order = ['rifleman', 'gunslinger', 'archer', 'heavy', 'warrior'];
      } else {
        order = ['archer', 'heavy', 'warrior'];
      }
    }

    // Translate AI orders (which were authored around the Lapinor roster with
    // 'knight' as the heavy melee) into the actual CPU tribe's roster:
    //   - 'knight' / 'viking' both resolve to the tribe's own heavy melee
    //   - anything else not in the tribe's roster is dropped
    const cpuTribe   = tribeForSide(self);
    const roster     = TRIBE_ROSTERS[cpuTribe];
    const heavyMelee = heavyMeleeForTribe(cpuTribe);
    const rosterSet = new Set<string>(roster);
    const resolved: UnitType[] = [];
    for (const t of order) {
      const mapped = (t === 'knight' || t === 'viking') ? heavyMelee as UnitType : t;
      if (rosterSet.has(mapped)) resolved.push(mapped);
    }
    order = resolved;

    for (const type of order) {
      const cost = CHAR_COST[type];
      if (balance < cost) continue;
      if (self === 'enemy') {
        this.cpuCoinBalance -= cost;
      } else {
        this.coinBalance -= cost;
        this.notifyCoins();
      }
      const c = this.spawnCpuUnit(self, type, spawnY);
      if (self === 'enemy')  this.cpuStrategyInfo.decision = `Spawned ${type} #${c.id}`;
      this.resetSpawnTimer(self, pressure);
      return;
    }
    if (self === 'enemy') {
      const needCost = Math.min(...order.map(t => CHAR_COST[t]));
      this.cpuStrategyInfo.decision = `Saving — need ${needCost} (have ${Math.floor(this.cpuCoinBalance)})`;
    }
    this.resetSpawnTimer(self, pressure);
  }

  /** Construct a CPU-side Character of `type` at the side's tower spawn point and
   *  register it with the world. Shared by the AI spawn loop and the dev forced-type
   *  override. Does not deduct coins or reset the spawn timer — the caller owns that. */
  private spawnCpuUnit(self: 'player' | 'enemy', type: CharacterConfig['type'], spawnY: number): Character {
    const cpuConfig = withSpawnBoosts(CHAR_CONFIGS[type]);
    // Place the unit's tower-side body edge (not centre) at the tribe's
    // configured spawn point so it never overlaps the tower physics body.
    const towerSpawnX = self === 'enemy' ? this.enemyTower.spawnX : this.playerTower.spawnX;
    const cpuSpawnX   = self === 'enemy'
      ? towerSpawnX - cpuConfig.width / 2
      : towerSpawnX + cpuConfig.width / 2;
    const c = new Character(self, cpuSpawnX, spawnY, cpuConfig, this.allocateCharId(), pickName(), this.physics, getSpriteSet(tribeForSide(self), type), this.mapGroundY);
    this.characters.push(c);
    this.unitLayer.addChild(c.container);
    if (self === 'player') this.hud.add(c);
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
    const vx        = (Math.random() * 2 - 1) * vxMax;
    const coin = new Coin(cb.x, COIN_LIFETIME_S, value, kind, vx, 0, cb.y + cb.height, this.physics, dt, wallL, wallR, this.mapGroundY, this.mapDef.coinSkins?.[kind]);
    this.coins.push(coin);
    this.coinLayer.addChild(coin.container);
  }

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
    const [min, max] =
      pressure >= CPU_PRESSURE_THRESHOLD  ? [CPU_SPAWN_MIN_MS,                         CPU_SPAWN_MIN_MS * CPU_URGENT_MAX_FACTOR  ] :
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

  private tick() {
    const ticker = this.app.ticker;
    const dt     = Math.min(ticker.deltaMS / 1000, 1 / 30);  // cap at 33 ms — prevents physics explosion on lag spikes

    // Camera — runs even when the game is over so the player can review the field
    const CAMERA_SPEED = 500; // px/s
    if (this.keysDown.has('ArrowLeft'))  this.cameraX -= CAMERA_SPEED * dt;
    if (this.keysDown.has('ArrowRight')) this.cameraX += CAMERA_SPEED * dt;
    if (this.keysDown.has('ArrowUp'))    this.cameraY += CAMERA_SPEED * dt;
    if (this.keysDown.has('ArrowDown'))  this.cameraY -= CAMERA_SPEED * dt;
    this.cameraX = Math.max(0, Math.min(this.mapDef.worldWidth - VIEWPORT_WIDTH / GAME_ZOOM, this.cameraX));
    // Y: positive cameraY = scrolled up (world Y=0 toward canvas top); negative = scrolled down.
    // world.y = zoom_anchor + cameraY*GAME_ZOOM, so larger cameraY raises the world on screen.
    // Max up: world Y=0 at canvas top.
    // Max down: world bottom (worldHeight) at canvas bottom.
    const worldH  = (this.mapDef.worldHeight ?? GAME_HEIGHT) as number;
    const camYMax = Math.max(0, this.mapGroundY * (GAME_ZOOM - 1) / GAME_ZOOM);
    const camYMin = Math.min(0, GAME_HEIGHT / GAME_ZOOM - worldH + this.mapGroundY * (GAME_ZOOM - 1) / GAME_ZOOM);
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

    if (this.isOver)   { this.tickGameOver(dt, ticker.deltaMS); return; }
    if (this.isPaused) { this.updateCulling(); return; }

    if (this.gameShark && this.coinBalance < 9999) this.coinBalance += 9999 - this.coinBalance;
    const playerRate = this.coinBalance    < LOW_BALANCE_THRESHOLD ? PASSIVE_INCOME_RATE * LOW_BALANCE_INCOME_MULT : PASSIVE_INCOME_RATE;
    const cpuRate    = this.cpuCoinBalance < LOW_BALANCE_THRESHOLD ? PASSIVE_INCOME_RATE * LOW_BALANCE_INCOME_MULT : PASSIVE_INCOME_RATE;
    this.coinBalance    += playerRate * dt;
    this.cpuCoinBalance += cpuRate    * dt;
    this.notifyCoins();
    this.notifyCpuCoins();
    this.notifyCpuCharsMs    += ticker.deltaMS;
    this.notifyCpuStrategyMs += ticker.deltaMS;
    if (this.notifyCpuCharsMs    >= 200) { this.notifyCpuCharsMs    = 0; this.notifyCpuChars(); }
    if (this.notifyCpuStrategyMs >= 150) { this.notifyCpuStrategyMs = 0; this.notifyCpuStrategy(); }
    this.notifyEnemyTowerHp();

    // Rebuild live arrays into pre-allocated buffers — avoids filter() allocations each tick
    this.liveChars.length = 0; this.playerLive.length = 0; this.enemyLive.length = 0;
    for (const c of this.characters) {
      if (!c.isDead) {
        this.liveChars.push(c);
        (c.side === 'player' ? this.playerLive : this.enemyLive).push(c);
      }
    }
    const liveChars = this.liveChars;

    // Throttle stance assessment to every 500 ms — frame-perfect precision not needed.
    // Also refresh the opponent-cluster cache here: same cadence, avoids a per-spawn O(n²) scan.
    this.cpuStanceMs += ticker.deltaMS;
    if (this.cpuStanceMs >= 500) {
      this.cpuStanceMs = 0;
      this.cpuStance = this.assessCpuStance('enemy', this.enemyLive, this.playerLive);
      if (this.cpuVsCpu) this.playerStance = this.assessCpuStance('player', this.playerLive, this.enemyLive);
      this.cachedEnemyOppClustered  = this.isCharsClustered(this.playerLive);
      if (this.cpuVsCpu) this.cachedPlayerOppClustered = this.isCharsClustered(this.enemyLive);
    }

    // CPU auto-spawn (uses liveChars for strategic decisions)
    this.cpuSpawnTimer += ticker.deltaMS;
    if (this.cpuSpawnTimer >= this.cpuSpawnInterval) {
      this.spawnCpu('enemy', this.enemyLive, this.playerLive);
    }

    // CPU vs CPU: drive the player side with a second AI instance
    if (this.cpuVsCpu) {
      this.playerSpawnTimer += ticker.deltaMS;
      if (this.playerSpawnTimer >= this.playerSpawnInterval) {
        this.spawnCpu('player', this.playerLive, this.enemyLive);
      }
    }

    // Coin drop
    this.coinDropTimer += ticker.deltaMS;
    if (this.coinDropTimer >= this.coinDropInterval) {
      this.spawnCoin(COIN_VALUE, 'gold');
      this.resetCoinDropTimer();
    }

    // Silver coin drop
    this.silverDropTimer += ticker.deltaMS;
    if (this.silverDropTimer >= this.silverDropInterval) {
      this.spawnCoin(SILVER_COIN_VALUE, 'silver');
      this.resetSilverDropTimer();
    }

    // Blue coin drop — rare jackpot
    this.blueDropTimer += ticker.deltaMS;
    if (this.blueDropTimer >= this.blueDropInterval) {
      this.spawnCoin(BLUE_COIN_VALUE, 'blue');
      this.resetBlueDropTimer();
    }

    // Power-up drop (every 40 s) with 20 s lead-up indicator
    this.powerUpTimer += ticker.deltaMS;
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
    this.cpuCollectAIMs += ticker.deltaMS;
    const runCollectAI = this.cpuCollectAIMs >= 250;
    if (runCollectAI) this.cpuCollectAIMs = 0;
    if (runCollectAI) this.tickCpuCollectAI('enemy', this.enemyLive, liveCoins);
    this.tickCpuBehaviorAI('enemy', this.enemyLive);
    if (this.cpuVsCpu) {
      if (runCollectAI) this.tickCpuCollectAI('player', this.playerLive, liveCoins);
      this.tickCpuBehaviorAI('player', this.playerLive);
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

    // Tower fire — inline both branches; no per-tick closure or object spread.
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
        const label = ev.amount === 0
          ? new DamageLabel(ev.x, ev.y, 0, 0x999999, 'Miss')
          : new DamageLabel(ev.x, ev.y, ev.amount, color);
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
          this.unitLayer.removeChild(c.container);
          this.releaseCharId(c.id);
          const reward = c.killedBy === 'tower' ? TOWER_KILL_REWARD : KILL_REWARD;
          c.destroy();
          if (c.side === 'enemy') { this.coinBalance += reward; this.notifyCoins(); }
          else                    { this.cpuCoinBalance += reward; this.notifyCpuCoins(); }
        } else { this.characters[wi++] = c; }
      }
      this.characters.length = wi; }
    { let wi = 0;
      for (let ri = 0; ri < this.projectiles.length; ri++) {
        const p = this.projectiles[ri];
        if (p.isDead) { this.projLayer.removeChild(p.container); p.destroy(); }
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

    for (const c  of this.characters)   c.container.visible  = inView(c.x);
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
      snapshot[i] = { id: c.id, name: c.name, type: c.config.type, behavior: c.behavior };
    }
    this.onCpuCharsChanged(snapshot);
  }

  // ── CPU collect AI ───────────────────────────────────────────────────────────

  private tickCpuCollectAI(self: 'player' | 'enemy', selfChars: Character[], liveCoins: Coin[]) {
    const stance     = self === 'enemy' ? this.cpuStance : this.playerStance;
    const collectors = selfChars.filter(c => c.behavior === 'collecting');
    const noteDecision = (msg: string) => { if (self === 'enemy') this.cpuStrategyInfo.decision = msg; };

    // Desired collector count by stance — carrying collectors always finish their run
    const wantedCollectors =
      stance === 'push'   ? 1 :
      stance === 'defend' ? (selfChars.length >= 3 ? 1 : 0) : 2;

    // Recall excess non-carrying collectors — track count inline, no inner filter
    let activeCount = collectors.length;
    if (activeCount > wantedCollectors) {
      for (const c of collectors) {
        if (activeCount <= wantedCollectors) break;
        if (!c.isCarryingCoin) {
          c.behavior = 'attacking';
          activeCount--;
          noteDecision(`← Recalled #${c.id} (${c.config.type})`);
        }
      }
    }

    if (liveCoins.length > 0) {
      if (activeCount < wantedCollectors) {
        // Prefer light attackers that are marching (not engaged), closest to a coin.
        // Tankers and heavies are too valuable for collection runs.
        let best: Character | null = null;
        let minDist = Infinity;
        for (const c of selfChars) {
          if (c.behavior !== 'attacking' || c.config.type === 'tanker' || c.config.type === 'heavy' || c.state !== 'marching') continue;
          for (const coin of liveCoins) {
            const d = Math.abs(c.x - coin.x);
            if (d < minDist) { minDist = d; best = c; }
          }
        }
        if (best) {
          best.behavior = 'collecting';
          noteDecision(`→ Collect #${best.id} (${best.config.type})`);
        }
      }
    } else {
      for (const c of collectors) {
        if (!c.isCarryingCoin) {
          c.behavior = 'attacking';
          noteDecision(`← Attack #${c.id} (${c.config.type})`);
        }
      }
    }
  }

  // ── CPU behaviour AI ─────────────────────────────────────────────────────────

  private tickCpuBehaviorAI(self: 'player' | 'enemy', selfChars: Character[]) {
    const stance    = self === 'enemy' ? this.cpuStance : this.playerStance;
    const noteDecision = (msg: string) => { if (self === 'enemy') this.cpuStrategyInfo.decision = msg; };

    const isMelee = (type: string) => type === 'warrior' || type === 'knight' || type === 'heavy' || type === 'tanker';
    const isRangedUnit = (type: string) => type === 'archer' || type === 'rifleman' || type === 'gunslinger' || type === 'sniper';

    // ── Low-HP retreat (highest priority) ─────────────────────────────────────
    // A combat unit that drops to critical HP falls back to 'defend', pulling it
    // toward its own tower where the safe-zone passive regen heals it. It holds
    // that retreat (skipped by the stance logic below) until healed past the
    // recover threshold — hysteresis prevents it from bouncing straight back into
    // the fight at 1 HP. Collectors are left alone (they finish their coin run).
    for (const c of selfChars) {
      if (c.behavior === 'collecting') continue;
      const hpFrac = c.hp / c.maxHp;
      if (this.retreatingUnits.has(c)) {
        if (hpFrac >= CPU_RETREAT_RECOVER_FRAC) {
          this.retreatingUnits.delete(c);          // recovered — stance logic resumes control
        } else if (c.behavior !== 'defend') {
          c.behavior = 'defend';                    // keep falling back while healing
        }
      } else if (hpFrac < CPU_RETREAT_HP_FRAC && (c.behavior === 'attacking' || c.behavior === 'harass')) {
        this.retreatingUnits.add(c);
        c.behavior = 'defend';
        noteDecision(`🚑 Retreat #${c.id} (${c.config.type}) — critical HP`);
      }
    }

    if (stance === 'defend') {
      // Melee units form the defensive wall at home tower; ranged units harass from safety.
      for (const c of selfChars) {
        if (c.behavior === 'collecting') continue;
        if (this.retreatingUnits.has(c)) continue;   // healing at base — leave it alone
        if (isMelee(c.config.type)) {
          if (c.behavior !== 'defend') {
            c.behavior = 'defend';
            noteDecision(`🛡 Defend wall #${c.id} (${c.config.type})`);
          }
        } else {
          if (c.behavior !== 'harass') {
            c.behavior = 'harass';
            noteDecision(`↯ Harass #${c.id} (${c.config.type})`);
          }
        }
      }
    } else if (stance === 'push') {
      // Push: ranged units harass (advance safely), melee units charge
      for (const c of selfChars) {
        if (c.behavior === 'collecting') continue;
        if (this.retreatingUnits.has(c)) continue;   // healing at base — leave it alone
        if (c.behavior === 'defend') {
          // Lift any lingering defend assignments
          c.behavior = isRangedUnit(c.config.type) ? 'harass' : 'attacking';
          noteDecision(`⇒ Push #${c.id} (${c.config.type})`);
        } else if (isRangedUnit(c.config.type) && c.behavior !== 'harass') {
          c.behavior = 'harass';
          noteDecision(`↯ Harass push #${c.id} (${c.config.type})`);
        } else if (isMelee(c.config.type) && c.behavior !== 'attacking') {
          c.behavior = 'attacking';
          noteDecision(`⇒ Attack #${c.id} (${c.config.type})`);
        }
      }
    } else {
      // Economy: recall all harassers and defenders back to full attack
      for (const c of selfChars) {
        if (this.retreatingUnits.has(c)) continue;   // healing at base — leave it alone
        if (c.behavior === 'harass' || c.behavior === 'defend') {
          c.behavior = 'attacking';
          noteDecision(`⇒ Economy attack #${c.id} (${c.config.type})`);
        }
      }
    }
  }

  private fireProjectile(req: FireRequest) {
    if (req.projectileKind === 'grenade') {
      playSoundAt('grenade_throw', req.sx);
      const g = new Grenade(
        req.side, req.sx, req.sy, req.tx, req.ty,
        req.damage, GRENADE_FUSE_S, GRENADE_SPLASH_R, GRENADE_GRAVITY, GRENADE_MAX_VX,
        req.shooter ?? null,
      );
      this.grenades.push(g);
      this.grenadeLayer.addChild(g.container);
    } else if (req.projectileKind === 'rocket') {
      playSoundAt('rocket_launch', req.sx);
      const r = new Rocket(
        req.side, req.sx, req.sy, req.tx,
        req.damage, ROCKET_FUSE_S, ROCKET_SPLASH_R, ROCKET_GRAVITY, ROCKET_LAUNCH_VX,
        req.shooter ?? null,
      );
      this.rockets.push(r);
      this.rocketLayer.addChild(r.container);
    } else {
      playSoundAt(
        req.projectileKind === 'arrow'         ? 'arrow_fire'  :
        req.shooter?.config.type === 'sniper'  ? 'sniper_shot' :
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
    // Leave the ticker attached: tick() early-exits at `if (this.isOver)` so
    // game logic doesn't run, but camera pan + sprite playback + culling all
    // need to keep ticking so the player can move the map around after the
    // match ends.
    for (const c of this.characters) c.freezeForGameOver();
    this.onGameOver(winner, reason);
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
    this.powerUpIndicatorActive = false;
    this.powerUpLastCountdown   = -1;
    this.isOver                = false;
    this.isPaused              = false;
    this.nextCharId            = 1;
    this.freeCharIds           = [];
    this.lastCpuCharsSig       = '';
    this.lastCpuStrategySig    = '';
    this.cpuStance             = 'economy';
    this.playerStance          = 'economy';
    this.cpuStrategyInfo       = { stance: 'economy', score: 0, unitAdv: 0, towerAdv: 0, coinAdv: 0, decision: '—' };
    this.coinBalance           = STARTING_COINS;
    this.cpuCoinBalance        = STARTING_COINS;
    this.lastNotifiedCoins     = -1;
    this.lastNotifiedCpuCoins  = -1;
    this.lastNotifiedEnemyTowerHp = -1;
    this.timeRemaining         = this.mapDurationSec;
    this.lastNotifiedTime      = -1;

    this.notifyCpuCharsMs    = 0;
    this.notifyCpuStrategyMs = 0;
    this.cpuStanceMs         = 0;
    this.cpuCollectAIMs      = 0;
    this.cullingFrame        = 0;
    this.cameraX = 0;
    // cameraY default is set by build() based on mapGroundY
    this.hud.clear();
    this.app.stage.removeChildren();
    this.build();
    this.resetSpawnTimerFirst('enemy');
    if (this.cpuVsCpu) this.resetSpawnTimerFirst('player');
    this.resetCoinDropTimer();
    this.resetSilverDropTimer();
    this.resetBlueDropTimer();
    this.app.ticker.add(this.tickFn);

    this.notifyCoins();
    this.notifyCpuCoins();
    this.notifyEnemyTowerHp();
    this.onTimeChanged(this.mapDurationSec);
  }

  destroy() {
    this.app.ticker.remove(this.tickFn);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup',   this.onKeyUp);
    this.hud.clear();
    this.app.destroy(false, { children: true });
  }
}
