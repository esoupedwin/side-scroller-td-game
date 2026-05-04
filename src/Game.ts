import * as PIXI from 'pixi.js';

export interface CpuStrategyInfo {
  stance:   'push' | 'economy' | 'defend';
  score:    number;   // composite score; positive = CPU winning
  unitAdv:  number;   // cpuStr − playerStr
  towerAdv: number;   // enemy tower ratio − player tower ratio
  coinAdv:  number;   // clamped coin balance delta
  decision: string;   // most recent significant action
}
import { Physics } from './Physics';
import { buildBackground, buildGround, buildTowerRangeMarkers, buildCoinBox } from './Background';
import { DEFAULT_MAP, loadMapWithOverride, type MapDefinition } from './maps';
import { Tower } from './Tower';
import type { TowerShot } from './Tower';
import { Character, RANK_NAMES, type CharacterConfig, type FireRequest, type UpdateContext } from './Character';
import { Projectile } from './Projectile';
import { Grenade } from './Grenade';
import { CharacterHUD } from './CharacterHUD';
import { Coin, type CoinKind } from './Coin';
import { PowerUp, type PowerUpType } from './PowerUp';
import { Sheep } from './Sheep';
import { DamageLabel } from './DamageLabel';
import { Platform } from './Platform';
import { Block } from './Block';
import { pickName } from './names';
import type { PlatformData } from './Platform';
import type { BlockData } from './Block';
import type { CollisionBoxData } from './CollisionBox';
import { NavGraph } from './Pathfinding';
import { Diagnostics } from './Diagnostics';
import {
  PLAYER_COLOR, ENEMY_COLOR,
  VIEWPORT_WIDTH, GAME_HEIGHT, GAME_DURATION_SEC,
  TOWER_WIDTH,
  GROUND_Y, TOWER_HEIGHT, TOWER_HP,
  WARRIOR, ARCHER, RIFLEMAN, SNIPER, MEDIC, HEAVY, TANKER, GRENADIER,
  GRENADE_FUSE_S, GRENADE_SPLASH_R, GRENADE_GRAVITY, GRENADE_MAX_VX, GRENADE_SPLASH_MIN_FRAC,
  GRENADE_KNOCKBACK_MAX_VX, GRENADE_KNOCKBACK_MAX_VY, GRENADE_KNOCKBACK_DECAY,
  CPU_SPAWN_MIN_MS, CPU_SPAWN_MAX_MS, CPU_FIRST_SPAWN_MAX,
  STARTING_COINS, CHAR_COST,
  PASSIVE_INCOME_RATE, LOW_BALANCE_THRESHOLD, LOW_BALANCE_INCOME_MULT,
  COIN_VALUE, KILL_REWARD, TOWER_KILL_REWARD, COIN_DROP_MIN_MS, COIN_DROP_MAX_MS,
  COIN_LIFETIME_S,
  COIN_DROP_VX_MIN, COIN_DROP_VX_MAX, COIN_DROP_VY_MIN, COIN_DROP_VY_MAX,
  COIN_GRAVITY,
  SILVER_COIN_VALUE, SILVER_DROP_MIN_MS, SILVER_DROP_MAX_MS,
  CPU_PRESSURE_THRESHOLD,
  CPU_URGENT_MAX_FACTOR, CPU_COMFORT_MIN_FACTOR,
  CPU_NEUTRAL_MIN_FACTOR, CPU_NEUTRAL_MAX_FACTOR,
  POWERUP_DROP_INTERVAL, POWERUP_INDICATOR_LEAD,
  CHEAT_PLAYER_COIN_GRANT, CHEAT_CPU_COIN_GRANT,
} from './constants';

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
  warrior:   WARRIOR,
  archer:    ARCHER,
  rifleman:  RIFLEMAN,
  sniper:    SNIPER,
  medic:     MEDIC,
  heavy:     HEAVY,
  tanker:    TANKER,
  grenadier: GRENADIER,
} as const;

export class Game {
  readonly app: PIXI.Application;

  private playerTower!: Tower;
  private enemyTower!:  Tower;
  private characters:   Character[]  = [];
  private projectiles:  Projectile[] = [];
  private grenades:     Grenade[]    = [];
  private coins:        Coin[]       = [];
  private powerUps:     PowerUp[]    = [];
  private sheep:        Sheep | null = null;
  private unitLayer!:   PIXI.Container;
  private projLayer!:    PIXI.Container;
  private grenadeLayer!: PIXI.Container;
  private coinLayer!:    PIXI.Container;
  private sheepLayer!:   PIXI.Container;
  private powerUpLayer!: PIXI.Container;
  private labelLayer!:   PIXI.Container;
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
  private readonly blockData:    BlockData[]    = [];
  private physics!:      Physics;

  private world!:     PIXI.Container;
  private cameraX  = 0;
  private readonly keysDown = new Set<string>();

  private navGraph!: NavGraph;

  readonly diagnostics = new Diagnostics();

  get elapsedSeconds(): number { return GAME_DURATION_SEC - this.timeRemaining; }

  // Collision-box debug overlay (toggled with 'B')
  private collisionDebugLayer!: PIXI.Graphics;
  private showCollisionBoxes   = false;
  private staticCollisionBoxes: CollisionBoxData[] = [];

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
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
  };
  private readonly onKeyUp = (e: KeyboardEvent) => { this.keysDown.delete(e.key); };

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
  private isOver           = false;

  private readonly hud:               CharacterHUD;
  private readonly onGameOver:         (winner: 'player' | 'enemy', reason: 'tower' | 'timeout') => void;
  private readonly onCoinsChanged:     (amount: number) => void;
  private readonly onCpuCoinsChanged:  (amount: number) => void;
  private readonly onCpuCharsChanged:    (chars: { id: number; type: string; behavior: string }[]) => void;
  private readonly onCpuStrategyChanged: (info: CpuStrategyInfo) => void;
  private readonly onTimeChanged:        (seconds: number) => void;
  private readonly tickFn:               (dt: number) => void;

  private lastCpuCharsSig     = '';
  private lastCpuStrategySig  = '';
  private cpuStance: 'push' | 'economy' | 'defend' = 'economy';
  private timeRemaining    = GAME_DURATION_SEC;
  private lastNotifiedTime = -1;
  private cpuStrategyInfo: CpuStrategyInfo = {
    stance: 'economy', score: 0, unitAdv: 0, towerAdv: 0, coinAdv: 0, decision: '—',
  };

  constructor(
    canvas:              HTMLCanvasElement,
    hudEl:               HTMLElement,
    onGameOver:          (winner: 'player' | 'enemy', reason: 'tower' | 'timeout') => void,
    onCoinsChanged:      (amount: number) => void,
    onCpuCoinsChanged:   (amount: number) => void,
    onCpuCharsChanged:    (chars: { id: number; type: string; behavior: string }[]) => void,
    onCpuStrategyChanged: (info: CpuStrategyInfo) => void,
    onTimeChanged:        (seconds: number) => void,
  ) {
    this.onGameOver             = onGameOver;
    this.onCoinsChanged         = onCoinsChanged;
    this.onCpuCoinsChanged      = onCpuCoinsChanged;
    this.onCpuCharsChanged      = onCpuCharsChanged;
    this.onCpuStrategyChanged   = onCpuStrategyChanged;
    this.onTimeChanged          = onTimeChanged;
    this.hud            = new CharacterHUD(hudEl);
    this.tickFn         = (_dt) => this.tick();

    this.app = new PIXI.Application({
      view: canvas,
      width:  VIEWPORT_WIDTH,
      height: GAME_HEIGHT,
      backgroundColor: 0x1a1a2e,
      antialias: true,
    });

    this.build();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup',   this.onKeyUp);
    this.resetCpuTimerFirst();
    this.resetCoinDropTimer();
    this.resetSilverDropTimer();
    this.app.ticker.add(this.tickFn);

    this.notifyCoins();
    this.notifyCpuCoins();
    this.onTimeChanged(GAME_DURATION_SEC);
  }

  // ── Scene construction ───────────────────────────────────────────────────────

  private build() {
    const m = this.mapDef;
    const towerFaceL = m.playerTowerX + TOWER_WIDTH / 2;
    const towerFaceR = m.enemyTowerX  - TOWER_WIDTH / 2;

    this.world = new PIXI.Container();

    buildBackground(this.world, m.worldWidth);
    buildTowerRangeMarkers(this.world, m.playerTowerX, m.enemyTowerX);
    buildCoinBox(this.world, m.coinBox);

    // Build one Platform visual per map platform
    this.platforms = m.platforms.map(p => new Platform(p));
    this.platformData.length = 0;
    for (const plat of this.platforms) {
      this.platformData.push(plat.data);
      this.world.addChild(plat.container);
    }

    // Build one Block visual per map block
    this.blocks = m.blocks.map(b => new Block(b));
    this.blockData.length = 0;
    for (const blk of this.blocks) {
      this.blockData.push(blk.data);
      this.world.addChild(blk.container);
    }

    this.physics = new Physics(m.worldWidth, m.playerTowerX, m.enemyTowerX, m.platforms);
    for (const b of m.blocks) this.physics.createBlockBody(b.x, b.y, b.width, b.height);

    this.coinLayer     = new PIXI.Container();
    this.sheepLayer    = new PIXI.Container();
    this.powerUpLayer  = new PIXI.Container();
    this.projLayer     = new PIXI.Container();
    this.grenadeLayer  = new PIXI.Container();
    this.unitLayer     = new PIXI.Container();
    this.labelLayer    = new PIXI.Container();
    this.world.addChild(this.coinLayer);
    this.world.addChild(this.sheepLayer);
    this.world.addChild(this.powerUpLayer);
    this.world.addChild(this.projLayer);
    this.world.addChild(this.grenadeLayer);
    this.world.addChild(this.unitLayer);
    this.world.addChild(this.labelLayer);

    this.playerTower = new Tower('player', m.playerTowerX);
    this.enemyTower  = new Tower('enemy',  m.enemyTowerX);
    this.world.addChild(this.playerTower.container);
    this.world.addChild(this.enemyTower.container);

    // Navigation graph — built from current platforms; rebuild whenever map changes.
    this.navGraph = new NavGraph();
    this.navGraph.build(this.platformData, m.playerTowerX, m.enemyTowerX, this.blockData);

    // Tower physics bodies — solid, block character movement.
    this.physics.createTowerBody(m.playerTowerX, TOWER_WIDTH);
    this.physics.createTowerBody(m.enemyTowerX,  TOWER_WIDTH);

    // Register static collision boxes for the debug overlay.
    this.staticCollisionBoxes = [
      {
        x: m.playerTowerX - TOWER_WIDTH / 2, y: GROUND_Y - TOWER_HEIGHT,
        width: TOWER_WIDTH, height: TOWER_HEIGHT,
        type: 'solid', label: 'Player Tower',
      },
      {
        x: m.enemyTowerX - TOWER_WIDTH / 2, y: GROUND_Y - TOWER_HEIGHT,
        width: TOWER_WIDTH, height: TOWER_HEIGHT,
        type: 'solid', label: 'Enemy Tower',
      },
      ...m.platforms.map((p, i) => ({
        x: p.x, y: p.y,
        width: p.width, height: p.height,
        type: 'passthrough' as const, label: `Platform ${i + 1}`,
      })),
      ...m.blocks.map((b, i) => ({
        x: b.x, y: b.y,
        width: b.width, height: b.height,
        type: 'solid' as const, label: `Block ${i + 1}`,
      })),
      {
        x: m.coinBox.x - m.coinBox.width / 2, y: m.coinBox.y,
        width: m.coinBox.width, height: m.coinBox.height,
        type: 'passthrough' as const, label: 'Coin Box',
      },
    ];

    // Ground plane — drawn above all game objects so units appear grounded.
    buildGround(this.world, m.worldWidth);

    // Debug overlay — drawn on top of everything in world space.
    this.collisionDebugLayer = new PIXI.Graphics();
    this.collisionDebugLayer.visible = false;
    this.world.addChild(this.collisionDebugLayer);

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
    this.powerUpIndicatorContainer.y   = 5;   // fixed at top of world
    this.powerUpIndicatorContainer.visible = false;
    this.world.addChild(this.powerUpIndicatorContainer);  // world space — scrolls with camera
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

    // Separator line
    g.lineStyle(1, color, 0.35);
    g.moveTo(-8, 6);
    g.lineTo(-8, bh - 6);
    g.lineStyle(0);

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
  spawnPlayer(type: 'warrior' | 'archer' | 'rifleman' | 'sniper' | 'medic' | 'heavy' | 'tanker' | 'grenadier'): boolean {
    if (this.isOver) return false;
    const cost = CHAR_COST[type];
    if (this.coinBalance < cost) return false;

    this.coinBalance -= cost;
    this.notifyCoins();

    const config = withSpawnBoosts(CHAR_CONFIGS[type]);
    const c = new Character('player', this.playerTower.frontX, config, this.allocateCharId(), pickName(), this.physics);
    this.characters.push(c);
    this.unitLayer.addChild(c.container);
    this.hud.add(c);
    return true;
  }

  // ── CPU strategic assessment ─────────────────────────────────────────────────

  private assessCpuStance(liveChars: Character[]): 'push' | 'economy' | 'defend' {
    const playerChars = liveChars.filter(c => c.side === 'player');
    const cpuChars    = liveChars.filter(c => c.side === 'enemy');

    const typeWeight = (type: string) =>
      type === 'tanker'   ? 2.5 :
      type === 'heavy'    ? 1.8 :
      type === 'sniper'   ? 1.4 :
      type === 'rifleman' ? 1.3 :
      type === 'archer'   ? 1.2 :
      type === 'medic'    ? 0.5 : 1.0;
    const threat = (chars: Character[], discountCollecting: boolean) =>
      chars.reduce((s, c) => {
        const behaviorMult = discountCollecting && c.behavior === 'collecting' ? 0.15 : 1.0;
        return s + (c.hp / c.maxHp) * typeWeight(c.config.type) * behaviorMult;
      }, 0);

    const playerStr = threat(playerChars, true);   // collecting chars aren't a real threat
    const cpuStr    = threat(cpuChars,    false);  // CPU strength unmodified
    const unitAdv   = cpuStr - playerStr;
    const towerAdv  = (this.enemyTower.hp / TOWER_HP) - (this.playerTower.hp / TOWER_HP);
    const coinAdv   = Math.min(1, Math.max(-1, (this.cpuCoinBalance - this.coinBalance) / 120));
    const score     = unitAdv * 1.5 + towerAdv * 2.5 + coinAdv * 0.5;

    // Store all intermediate values for the dev panel
    this.cpuStrategyInfo.score    = score;
    this.cpuStrategyInfo.unitAdv  = unitAdv;
    this.cpuStrategyInfo.towerAdv = towerAdv;
    this.cpuStrategyInfo.coinAdv  = coinAdv;

    // Critical tower overrides
    if (this.enemyTower.hp  / TOWER_HP < 0.28) { this.cpuStrategyInfo.stance = 'defend'; return 'defend'; }
    if (this.playerTower.hp / TOWER_HP < 0.28) { this.cpuStrategyInfo.stance = 'push';   return 'push';   }

    const stance: 'push' | 'economy' | 'defend' =
      score >  0.8 ? 'push' :
      score < -0.7 ? 'defend' : 'economy';

    this.cpuStrategyInfo.stance = stance;
    return stance;
  }

  private spawnCpu(liveChars: Character[]) {
    if (this.isOver) return;

    const stance   = this.cpuStance;   // assessed every tick
    const cpuChars = liveChars.filter(c => c.side === 'enemy');
    const playerCount = liveChars.filter(c => c.side === 'player').length;
    const pressure    = playerCount - cpuChars.length;

    // How many CPU units are below half HP
    const hurting  = cpuChars.filter(c => c.hp / c.config.hp < 0.5).length;
    const hasMedic = cpuChars.some(c => c.config.type === 'medic');

    type UnitType = 'warrior' | 'archer' | 'rifleman' | 'sniper' | 'medic' | 'heavy' | 'tanker';
    let order: UnitType[];

    if (stance === 'push') {
      // Aggressive push: get a medic if units are hurting, then flood high-damage units
      const needMedic = hurting >= 1 && !hasMedic && cpuChars.length >= 2;
      if (needMedic) {
        order = ['medic', 'rifleman', 'heavy', 'tanker', 'warrior', 'archer'];
      } else if (this.cpuCoinBalance >= CHAR_COST.tanker) {
        order = ['tanker', 'rifleman', 'heavy', 'warrior', 'archer'];
      } else {
        order = ['rifleman', 'heavy', 'warrior', 'archer'];
      }
    } else if (stance === 'defend') {
      // Get a medic early — 1 hurting unit is enough to justify it when squad exists
      const needMedic = hurting >= 1 && !hasMedic && cpuChars.length >= 2;
      if (needMedic) {
        order = ['medic', 'warrior', 'archer', 'sniper'];
      } else if (pressure >= 3) {
        // Severely outnumbered — flood cheap units to plug the gap immediately
        order = ['warrior', 'heavy', 'archer', 'sniper'];
      } else {
        // Steady defence: archers for harassment, warriors as frontline wall
        order = ['archer', 'warrior', 'sniper', 'medic'];
      }
    } else {
      // Economy: invest in better units; get a medic if the squad is hurting
      if (hurting >= 2 && !hasMedic) {
        order = ['medic', 'archer', 'warrior'];
      } else if (this.cpuCoinBalance >= CHAR_COST.tanker && cpuChars.length >= 4) {
        order = ['tanker', 'sniper', 'rifleman', 'archer', 'heavy', 'warrior'];
      } else if (this.cpuCoinBalance >= CHAR_COST.sniper && cpuChars.length >= 3) {
        order = ['sniper', 'rifleman', 'archer', 'heavy', 'warrior'];
      } else if (this.cpuCoinBalance >= CHAR_COST.rifleman) {
        order = ['rifleman', 'archer', 'heavy', 'warrior'];
      } else {
        order = ['archer', 'heavy', 'warrior'];
      }
    }

    for (const type of order) {
      if (this.cpuCoinBalance < CHAR_COST[type]) continue;
      this.cpuCoinBalance -= CHAR_COST[type];
      const c = new Character('enemy', this.enemyTower.frontX, withSpawnBoosts(CHAR_CONFIGS[type]), this.allocateCharId(), pickName(), this.physics);
      this.characters.push(c);
      this.unitLayer.addChild(c.container);
      this.cpuStrategyInfo.decision = `Spawned ${type} #${c.id}`;
      this.resetCpuTimer(pressure);
      return;
    }
    const needCost = Math.min(...order.map(t => CHAR_COST[t]));
    this.cpuStrategyInfo.decision = `Saving — need ${needCost} (have ${Math.floor(this.cpuCoinBalance)})`;
    this.resetCpuTimer(pressure);
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
    // Aim vxMax so a coin spread by spreadDeg lands on the lowest platform (rough target)
    const lowestPlatY = this.platformData.reduce((minY, p) => Math.min(minY, p.y), GROUND_Y);
    const fallH     = lowestPlatY - (cb.y + cb.height);
    const spreadRad = cb.spreadDeg * (Math.PI / 180);
    const vxMax     = Math.tan(spreadRad) * Math.sqrt(Math.max(1, fallH) * COIN_GRAVITY / 2);
    const vx        = (Math.random() * 2 - 1) * vxMax;
    const coin = new Coin(cb.x, COIN_LIFETIME_S, value, kind, vx, 0, cb.y + cb.height, this.physics, dt, wallL, wallR);
    this.coins.push(coin);
    this.coinLayer.addChild(coin.container);
  }

  // ── Timers ───────────────────────────────────────────────────────────────────

  private resetCpuTimerFirst() {
    this.cpuSpawnInterval = Math.random() * CPU_FIRST_SPAWN_MAX;
    this.cpuSpawnTimer    = 0;
  }

  private resetCpuTimer(pressure = 0) {
    const [min, max] =
      pressure >= CPU_PRESSURE_THRESHOLD  ? [CPU_SPAWN_MIN_MS,                         CPU_SPAWN_MIN_MS * CPU_URGENT_MAX_FACTOR  ] :
      pressure <= -CPU_PRESSURE_THRESHOLD ? [CPU_SPAWN_MAX_MS * CPU_COMFORT_MIN_FACTOR, CPU_SPAWN_MAX_MS                          ] :
                                            [CPU_SPAWN_MIN_MS * CPU_NEUTRAL_MIN_FACTOR, CPU_SPAWN_MAX_MS * CPU_NEUTRAL_MAX_FACTOR ];
    // Stance modifier: defend and push both need units urgently
    const stanceMult = this.cpuStance === 'push' ? 0.70 : this.cpuStance === 'defend' ? 0.72 : 1.0;
    this.cpuSpawnInterval = (min + Math.random() * (max - min)) * stanceMult;
    this.cpuSpawnTimer    = 0;
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

  // ── Tick ─────────────────────────────────────────────────────────────────────

  private tick() {
    const ticker = this.app.ticker;
    const dt     = ticker.deltaMS / 1000;

    // Camera — runs even when the game is over so the player can review the field
    const CAMERA_SPEED = 500; // px/s
    if (this.keysDown.has('ArrowLeft'))  this.cameraX -= CAMERA_SPEED * dt;
    if (this.keysDown.has('ArrowRight')) this.cameraX += CAMERA_SPEED * dt;
    this.cameraX     = Math.max(0, Math.min(this.mapDef.worldWidth - VIEWPORT_WIDTH, this.cameraX));
    this.world.x     = -this.cameraX;

    if (this.isOver) return;

    const playerRate = this.coinBalance    < LOW_BALANCE_THRESHOLD ? PASSIVE_INCOME_RATE * LOW_BALANCE_INCOME_MULT : PASSIVE_INCOME_RATE;
    const cpuRate    = this.cpuCoinBalance < LOW_BALANCE_THRESHOLD ? PASSIVE_INCOME_RATE * LOW_BALANCE_INCOME_MULT : PASSIVE_INCOME_RATE;
    this.coinBalance    += playerRate * dt;
    this.cpuCoinBalance += cpuRate    * dt;
    this.notifyCoins();
    this.notifyCpuCoins();
    this.notifyCpuChars();

    const liveChars = this.characters.filter(c => !c.isDead);
    this.cpuStance = this.assessCpuStance(liveChars);
    this.notifyCpuStrategy();

    // CPU auto-spawn (uses liveChars for strategic decisions)
    this.cpuSpawnTimer += ticker.deltaMS;
    if (this.cpuSpawnTimer >= this.cpuSpawnInterval) {
      this.spawnCpu(liveChars);  // resets timer internally
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
      // Smooth slide toward target
      this.powerUpIndicatorX += (this.powerUpIndicatorTargetX - this.powerUpIndicatorX) * Math.min(1, dt * 2 / 9);
      this.powerUpIndicatorContainer.x = this.powerUpIndicatorX;

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
      const pu  = new PowerUp(px, this.powerUpTypePreview, this.physics);
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

    const liveCoins = this.coins.filter(c => !c.isDead);

    this.tickCpuCollectAI(liveChars, liveCoins);
    this.tickCpuBehaviorAI(liveChars);

    // Update characters
    for (const c of liveChars) {
      const isPlayer    = c.side === 'player';
      const enemyTower  = isPlayer ? this.enemyTower  : this.playerTower;
      const towerFrontX = enemyTower.frontX;
      const towerY      = GROUND_Y - TOWER_HEIGHT * 0.5;

      const ctx: UpdateContext = {
        dt,
        allChars:          liveChars,
        enemyTowerFrontX:  towerFrontX,
        enemyTowerY:       towerY,
        homeTowerFrontX:   isPlayer ? this.playerTower.frontX : this.enemyTower.frontX,
        worldWidth:        this.mapDef.worldWidth,
        coins:             liveCoins,
        platforms:         this.platformData,
        blocks:            this.blockData,
        navGraph:          this.navGraph,
        onFire:        (req: FireRequest) => this.fireProjectile(req),
        onDamageTower: (dmg: number)     => enemyTower.takeDamage(dmg),
        onDepositCoin: (value: number) => {
          if (isPlayer) {
            this.coinBalance += value;
            this.notifyCoins();
          } else {
            this.cpuCoinBalance += value;
          }
          this.diagnostics.noteEvent(this.elapsedSeconds,
            `Coin deposit: #${c.id} ${c.name} (${c.side}) +${value}`, {
              playerTotal: Math.floor(this.coinBalance),
              cpuTotal:    Math.floor(this.cpuCoinBalance),
            });
        },
      };

      c.update(ctx);
    }

    // Physics step: push AI positions → engine → read results back
    for (const c of liveChars) c.syncToBody(dt);
    for (const coin of this.coins) if (!coin.isDead && !coin.isPickedUp) this.physics.updatePlatformPassthrough(coin.body);
    for (const pu of this.powerUps) if (!pu.isDead && !pu.isPickedUp && !pu.isOnGround) this.physics.updatePlatformPassthrough(pu.body);
    if (this.sheep) this.physics.updatePlatformPassthrough(this.sheep.body);
    this.physics.step(dt);
    for (const c of liveChars) c.syncFromBody(this.platformData, this.blockData);

    this.diagnostics.tick({
      time:      GAME_DURATION_SEC - this.timeRemaining,
      chars:     liveChars,
      platforms: this.platformData,
      blocks:    this.blockData,
    });

    // Tower fire
    const fireShot = (shot: TowerShot, side: 'player' | 'enemy') =>
      this.fireProjectile({ ...shot, side, projectileKind: 'arrow' });
    const shotP = this.playerTower.tryFire(dt, liveChars.filter(c => c.side === 'enemy'));
    if (shotP) fireShot(shotP, 'player');
    const shotE = this.enemyTower.tryFire(dt, liveChars.filter(c => c.side === 'player'));
    if (shotE) fireShot(shotE, 'enemy');

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
      const coin  = new Coin(x, COIN_LIFETIME_S, dropValue, dropKind, vx, vy, y, this.physics, dt, wallL, wallR);
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
      // Startle the sheep when a projectile lands within 55 px of it
      if (wasAlive && p.isDead && this.sheep && Math.abs(p.x - this.sheep.x) <= 55) {
        this.sheep.reactToHit(p.x);
      }
    }

    // Update grenades + process AoE explosions
    const knockbackDecayFactor = Math.exp(-GRENADE_KNOCKBACK_DECAY * dt);
    for (const g of this.grenades) {
      g.update(dt, this.platformData, this.blockData);
      const ex = g.consumeExplosion();
      if (ex) {
        for (const c of liveChars) {
          if (c.side === g.side) continue;
          const dist = Math.hypot(c.x - ex.x, c.y - ex.y);
          if (dist <= ex.radius) {
            const frac = 1 - (dist / ex.radius) * (1 - GRENADE_SPLASH_MIN_FRAC);
            c.takeDamage(Math.round(ex.damage * frac), ex.shooter ?? undefined);

            // Knockback: push outward from blast centre, stronger at closer range
            const kFrac = 1 - dist / ex.radius;
            const dx    = c.x - ex.x;
            const dy    = c.y - ex.y;
            const len   = dist || 1;
            c.applyKnockback(
              (dx / len) * GRENADE_KNOCKBACK_MAX_VX * kFrac,
              (dy / len) * GRENADE_KNOCKBACK_MAX_VY * kFrac,
              dt,
              knockbackDecayFactor,
            );
          }
        }
        // Tower damage — find closest point on the enemy tower rect to the blast centre
        const targetTower = g.side === 'player' ? this.enemyTower : this.playerTower;
        const towerLeft   = targetTower.x - TOWER_WIDTH / 2;
        const towerRight  = targetTower.x + TOWER_WIDTH / 2;
        const towerTop    = GROUND_Y - TOWER_HEIGHT;
        const nearX = Math.max(towerLeft,  Math.min(towerRight, ex.x));
        const nearY = Math.max(towerTop,   Math.min(GROUND_Y,   ex.y));
        if (Math.hypot(nearX - ex.x, nearY - ex.y) <= ex.radius) {
          targetTower.takeDamage(ex.damage);
        }
        if (this.sheep && Math.hypot(this.sheep.x - ex.x, this.sheep.y - ex.y) <= ex.radius + 20) {
          this.sheep.reactToHit(ex.x);
        }
      }
    }

    // Cull dead entities
    this.characters = this.characters.filter(c => {
      if (c.isDead) {
        this.unitLayer.removeChild(c.container);
        this.releaseCharId(c.id);
        const reward = c.killedBy === 'tower' ? TOWER_KILL_REWARD : KILL_REWARD;
        c.destroy();
        if (c.side === 'enemy') {
          this.coinBalance += reward;
          this.notifyCoins();
        } else {
          this.cpuCoinBalance += reward;
          this.notifyCpuCoins();
        }
        return false;
      }
      return true;
    });
    this.projectiles = this.projectiles.filter(p => {
      if (p.isDead) { this.projLayer.removeChild(p.container); p.destroy(); return false; }
      return true;
    });
    this.grenades = this.grenades.filter(g => {
      if (g.isDead) { this.grenadeLayer.removeChild(g.container); g.destroy(); return false; }
      return true;
    });
    this.coins = this.coins.filter(coin => {
      if (coin.isDead) { this.coinLayer.removeChild(coin.container); coin.destroy(); return false; }
      return true;
    });
    this.powerUps = this.powerUps.filter(pu => {
      if (pu.isDead) { this.powerUpLayer.removeChild(pu.container); pu.destroy(); return false; }
      return true;
    });
    this.damageLabels = this.damageLabels.filter(l => {
      if (l.isDead) { this.labelLayer.removeChild(l.container); l.destroy(); return false; }
      return true;
    });

    this.hud.update();

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

      // Collision box
      g.lineStyle(1.5, 0x44ff88, 0.75);
      g.beginFill(0x44ff88, 0.06);
      g.drawRect(c.x - c.config.width / 2, c.y - c.config.height, c.config.width, c.config.height);
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

  private notifyCpuChars() {
    const cpuChars = this.characters.filter(c => c.side === 'enemy' && !c.isDead);
    const sig = cpuChars.map(c => `${c.id}:${c.behavior}`).join(',');
    if (sig === this.lastCpuCharsSig) return;
    this.lastCpuCharsSig = sig;
    this.onCpuCharsChanged(cpuChars.map(c => ({ id: c.id, type: c.config.type, behavior: c.behavior })));
  }

  // ── CPU collect AI ───────────────────────────────────────────────────────────

  private tickCpuCollectAI(liveChars: Character[], liveCoins: Coin[]) {
    const cpuChars   = liveChars.filter(c => c.side === 'enemy');
    const collectors = cpuChars.filter(c => c.behavior === 'collecting');

    // Desired collector count by stance — carrying collectors always finish their run
    const wantedCollectors =
      this.cpuStance === 'push'   ? 1 :
      this.cpuStance === 'defend' ? (cpuChars.length >= 3 ? 1 : 0) : 2;

    // Recall excess non-carrying collectors
    if (collectors.length > wantedCollectors) {
      for (const c of collectors) {
        if (collectors.filter(x => x.behavior === 'collecting').length <= wantedCollectors) break;
        if (!c.isCarryingCoin) {
          c.behavior = 'attacking';
          this.cpuStrategyInfo.decision = `← Recalled #${c.id} (${c.config.type})`;
        }
      }
    }

    if (liveCoins.length > 0) {
      const active = cpuChars.filter(c => c.behavior === 'collecting').length;
      if (active < wantedCollectors) {
        // Prefer light attackers that are marching (not engaged), closest to a coin
        // Exclude medics (no combat), tankers and heavies (too valuable for collection runs)
        const pool = cpuChars.filter(
          c => c.behavior === 'attacking'
            && c.config.type !== 'medic'
            && c.config.type !== 'tanker'
            && c.config.type !== 'heavy'
            && c.state === 'marching',
        );
        let best: Character | null = null;
        let minDist = Infinity;
        for (const c of pool) {
          for (const coin of liveCoins) {
            const d = Math.abs(c.x - coin.x);
            if (d < minDist) { minDist = d; best = c; }
          }
        }
        if (best) {
          best.behavior = 'collecting';
          this.cpuStrategyInfo.decision = `→ Collect #${best.id} (${best.config.type})`;
        }
      }
    } else {
      for (const c of collectors) {
        if (!c.isCarryingCoin) {
          c.behavior = 'attacking';
          this.cpuStrategyInfo.decision = `← Attack #${c.id} (${c.config.type})`;
        }
      }
    }
  }

  // ── CPU behaviour AI ─────────────────────────────────────────────────────────

  private tickCpuBehaviorAI(liveChars: Character[]) {
    const cpuChars = liveChars.filter(c => c.side === 'enemy');

    const isMelee = (type: string) => type === 'warrior' || type === 'heavy' || type === 'tanker';
    const isRangedUnit = (type: string) => type === 'archer' || type === 'rifleman' || type === 'sniper';

    if (this.cpuStance === 'defend') {
      // Melee units form the defensive wall at home tower; ranged units harass from safety.
      for (const c of cpuChars) {
        if (c.behavior === 'collecting') continue;
        if (isMelee(c.config.type)) {
          if (c.behavior !== 'defend') {
            c.behavior = 'defend';
            this.cpuStrategyInfo.decision = `🛡 Defend wall #${c.id} (${c.config.type})`;
          }
        } else if (c.config.type !== 'medic') {
          if (c.behavior !== 'harass') {
            c.behavior = 'harass';
            this.cpuStrategyInfo.decision = `↯ Harass #${c.id} (${c.config.type})`;
          }
        }
      }
    } else if (this.cpuStance === 'push') {
      // Push: ranged units harass (advance safely), melee units charge
      for (const c of cpuChars) {
        if (c.behavior === 'collecting') continue;
        if (c.behavior === 'defend') {
          // Lift any lingering defend assignments
          c.behavior = isRangedUnit(c.config.type) ? 'harass' : 'attacking';
          this.cpuStrategyInfo.decision = `⇒ Push #${c.id} (${c.config.type})`;
        } else if (isRangedUnit(c.config.type) && c.behavior !== 'harass') {
          c.behavior = 'harass';
          this.cpuStrategyInfo.decision = `↯ Harass push #${c.id} (${c.config.type})`;
        } else if (isMelee(c.config.type) && c.behavior !== 'attacking') {
          c.behavior = 'attacking';
          this.cpuStrategyInfo.decision = `⇒ Attack #${c.id} (${c.config.type})`;
        }
      }
    } else {
      // Economy: recall all harassers and defenders back to full attack
      for (const c of cpuChars) {
        if (c.behavior === 'harass' || c.behavior === 'defend') {
          c.behavior = 'attacking';
          this.cpuStrategyInfo.decision = `⇒ Economy attack #${c.id} (${c.config.type})`;
        }
      }
    }
  }

  private fireProjectile(req: FireRequest) {
    if (req.projectileKind === 'grenade') {
      const g = new Grenade(
        req.side, req.sx, req.sy, req.tx,
        req.damage, GRENADE_FUSE_S, GRENADE_SPLASH_R, GRENADE_GRAVITY, GRENADE_MAX_VX,
        req.shooter ?? null,
      );
      this.grenades.push(g);
      this.grenadeLayer.addChild(g.container);
    } else {
      const p = new Projectile(req.side, req.sx, req.sy, req.tx, req.ty, req.damage, req.projectileKind, req.shooter ?? null);
      this.projectiles.push(p);
      this.projLayer.addChild(p.container);
    }
  }

  // ── Game state ───────────────────────────────────────────────────────────────

  private end(winner: 'player' | 'enemy', reason: 'tower' | 'timeout') {
    this.isOver = true;
    this.app.ticker.remove(this.tickFn);
    this.onGameOver(winner, reason);
  }

  reset(mapDef?: MapDefinition) {
    if (mapDef) this.mapDef = mapDef;
    this.app.ticker.remove(this.tickFn);

    for (const c of this.characters)    { c.destroy(); }
    for (const p of this.projectiles)   { p.destroy(); }
    for (const g of this.grenades)      { g.destroy(); }
    for (const coin of this.coins)      { coin.destroy(); }
    for (const pu of this.powerUps)     { pu.destroy(); }
    for (const l of this.damageLabels)  { l.destroy(); }
    this.sheep?.destroy();
    this.sheep = null;
    this.characters   = [];
    this.projectiles  = [];
    this.grenades     = [];
    this.coins        = [];
    this.powerUps     = [];
    this.damageLabels = [];
    this.powerUpTimer           = 0;
    this.powerUpIndicatorActive = false;
    this.powerUpLastCountdown   = -1;
    this.isOver                = false;
    this.nextCharId            = 1;
    this.freeCharIds           = [];
    this.lastCpuCharsSig       = '';
    this.lastCpuStrategySig    = '';
    this.cpuStance             = 'economy';
    this.cpuStrategyInfo       = { stance: 'economy', score: 0, unitAdv: 0, towerAdv: 0, coinAdv: 0, decision: '—' };
    this.coinBalance           = STARTING_COINS;
    this.cpuCoinBalance        = STARTING_COINS;
    this.lastNotifiedCoins     = -1;
    this.lastNotifiedCpuCoins  = -1;
    this.timeRemaining         = GAME_DURATION_SEC;
    this.lastNotifiedTime      = -1;

    this.cameraX = 0;
    this.hud.clear();
    this.app.stage.removeChildren();
    this.build();
    this.resetCpuTimerFirst();
    this.resetCoinDropTimer();
    this.resetSilverDropTimer();
    this.app.ticker.add(this.tickFn);

    this.notifyCoins();
    this.notifyCpuCoins();
    this.onTimeChanged(GAME_DURATION_SEC);
  }

  destroy() {
    this.app.ticker.remove(this.tickFn);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup',   this.onKeyUp);
    this.hud.clear();
    this.app.destroy(false, { children: true });
  }
}
