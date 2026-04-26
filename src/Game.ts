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
import { buildBackground, buildTowerRangeMarkers } from './Background';
import { Tower } from './Tower';
import type { TowerShot } from './Tower';
import { Character, RANK_NAMES, type FireRequest, type UpdateContext } from './Character';
import { Projectile } from './Projectile';
import { CharacterHUD } from './CharacterHUD';
import { Coin, type CoinKind } from './Coin';
import { DamageLabel } from './DamageLabel';
import { Platform } from './Platform';
import type { PlatformData } from './Platform';
import {
  PLAYER_COLOR, ENEMY_COLOR,
  VIEWPORT_WIDTH, GAME_WIDTH, GAME_HEIGHT, GAME_DURATION_SEC,
  PLAYER_TOWER_X, ENEMY_TOWER_X,
  GROUND_Y, TOWER_HEIGHT, TOWER_HP,
  WARRIOR, ARCHER, RIFLEMAN, SNIPER, MEDIC, HEAVY,
  CPU_SPAWN_MIN_MS, CPU_SPAWN_MAX_MS, CPU_FIRST_SPAWN_MAX,
  STARTING_COINS, CHAR_COST,
  PASSIVE_INCOME_RATE, LOW_BALANCE_THRESHOLD, LOW_BALANCE_INCOME_MULT,
  COIN_VALUE, KILL_REWARD, TOWER_KILL_REWARD, COIN_DROP_MIN_MS, COIN_DROP_MAX_MS,
  COIN_LIFETIME_S, COIN_DROP_X_MIN, COIN_DROP_X_MAX,
  COIN_DROP_VX_MIN, COIN_DROP_VX_MAX, COIN_DROP_VY_MIN, COIN_DROP_VY_MAX, COIN_DROP_START_Y,
  SILVER_COIN_VALUE, SILVER_DROP_MIN_MS, SILVER_DROP_MAX_MS,
  PLATFORM_X, PLATFORM_Y, PLATFORM_WIDTH, PLATFORM_HEIGHT,
  CPU_PRESSURE_THRESHOLD,
  CPU_URGENT_MAX_FACTOR, CPU_COMFORT_MIN_FACTOR,
  CPU_NEUTRAL_MIN_FACTOR, CPU_NEUTRAL_MAX_FACTOR,
} from './constants';

export class Game {
  readonly app: PIXI.Application;

  private playerTower!: Tower;
  private enemyTower!:  Tower;
  private characters:   Character[]  = [];
  private projectiles:  Projectile[] = [];
  private coins:        Coin[]       = [];
  private unitLayer!:   PIXI.Container;
  private projLayer!:   PIXI.Container;
  private coinLayer!:    PIXI.Container;
  private labelLayer!:   PIXI.Container;
  private damageLabels:  DamageLabel[] = [];
  private platform!:     Platform;
  private readonly platformData: PlatformData[] = [];
  private physics!:      Physics;

  private world!:     PIXI.Container;
  private cameraX  = 0;
  private readonly keysDown = new Set<string>();

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      this.keysDown.add(e.key);
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
    this.world = new PIXI.Container();

    buildBackground(this.world);
    buildTowerRangeMarkers(this.world);

    this.platform = new Platform({
      x: PLATFORM_X, y: PLATFORM_Y,
      width: PLATFORM_WIDTH, height: PLATFORM_HEIGHT,
    });
    this.platformData.length = 0;
    this.platformData.push(this.platform.data);
    this.world.addChild(this.platform.container);

    this.physics = new Physics({
      x: PLATFORM_X, y: PLATFORM_Y,
      width: PLATFORM_WIDTH, height: PLATFORM_HEIGHT,
    });

    this.coinLayer  = new PIXI.Container();
    this.projLayer  = new PIXI.Container();
    this.unitLayer  = new PIXI.Container();
    this.labelLayer = new PIXI.Container();
    this.world.addChild(this.coinLayer);
    this.world.addChild(this.projLayer);
    this.world.addChild(this.unitLayer);
    this.world.addChild(this.labelLayer);

    this.playerTower = new Tower('player', PLAYER_TOWER_X);
    this.enemyTower  = new Tower('enemy',  ENEMY_TOWER_X);
    this.world.addChild(this.playerTower.container);
    this.world.addChild(this.enemyTower.container);

    this.app.stage.addChild(this.world);
  }

  // ── Spawn ────────────────────────────────────────────────────────────────────

  /** Returns false if the player cannot afford this unit. */
  spawnPlayer(type: 'warrior' | 'archer' | 'rifleman' | 'sniper' | 'medic' | 'heavy'): boolean {
    if (this.isOver) return false;
    const cost = CHAR_COST[type];
    if (this.coinBalance < cost) return false;

    this.coinBalance -= cost;
    this.notifyCoins();

    const configs = { warrior: WARRIOR, archer: ARCHER, rifleman: RIFLEMAN, sniper: SNIPER, medic: MEDIC, heavy: HEAVY };
    const config = configs[type];
    const c = new Character('player', this.playerTower.frontX, config, this.allocateCharId(), this.physics);
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
      score >  1.5 ? 'push' :
      score < -1.0 ? 'defend' : 'economy';

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

    type UnitType = 'warrior' | 'archer' | 'rifleman' | 'sniper' | 'medic' | 'heavy';
    let order: UnitType[];

    if (stance === 'push') {
      // Mass melee; heavies are the priority finisher
      order = ['heavy', 'warrior', 'archer'];
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
      } else if (this.cpuCoinBalance >= CHAR_COST.sniper && cpuChars.length >= 3) {
        order = ['sniper', 'rifleman', 'archer', 'heavy', 'warrior'];
      } else if (this.cpuCoinBalance >= CHAR_COST.rifleman) {
        order = ['rifleman', 'archer', 'heavy', 'warrior'];
      } else {
        order = ['archer', 'heavy', 'warrior'];
      }
    }

    const cfgMap = { warrior: WARRIOR, archer: ARCHER, rifleman: RIFLEMAN, sniper: SNIPER, medic: MEDIC, heavy: HEAVY };
    for (const type of order) {
      if (this.cpuCoinBalance < CHAR_COST[type]) continue;
      this.cpuCoinBalance -= CHAR_COST[type];
      const c = new Character('enemy', this.enemyTower.frontX, cfgMap[type], this.allocateCharId(), this.physics);
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
    const x    = COIN_DROP_X_MIN + Math.random() * (COIN_DROP_X_MAX - COIN_DROP_X_MIN);
    const coin = new Coin(x, COIN_LIFETIME_S, value, kind, 0, 0, COIN_DROP_START_Y, this.physics, dt);
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
    this.cameraX     = Math.max(0, Math.min(GAME_WIDTH - VIEWPORT_WIDTH, this.cameraX));
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

    // Update coins
    for (const coin of this.coins) coin.update(dt, this.platformData);

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
        coins:             liveCoins,
        platforms:         this.platformData,
        onFire:        (req: FireRequest) => this.fireProjectile(req),
        onDamageTower: (dmg: number)     => enemyTower.takeDamage(dmg),
        onDepositCoin: (value: number) => {
          if (isPlayer) {
            this.coinBalance += value;
            this.notifyCoins();
          } else {
            this.cpuCoinBalance += value;
          }
        },
      };

      c.update(ctx);
    }

    // Physics step: push AI positions → engine → read results back
    for (const c of liveChars) c.syncToBody(dt);
    for (const coin of this.coins) if (!coin.isDead && !coin.isPickedUp) this.physics.updatePlatformPassthrough(coin.body);
    this.physics.step(dt);
    for (const c of liveChars) c.syncFromBody(this.platformData);

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
      const vx   = throwVx  ?? (Math.random() < 0.5 ? 1 : -1) * (COIN_DROP_VX_MIN + Math.random() * (COIN_DROP_VX_MAX - COIN_DROP_VX_MIN));
      const vy   = throwVy  ?? -(COIN_DROP_VY_MIN + Math.random() * (COIN_DROP_VY_MAX - COIN_DROP_VY_MIN));
      const coin = new Coin(x, COIN_LIFETIME_S, dropValue, dropKind, vx, vy, y, this.physics, dt);
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
      p.update(dt, liveChars, this.playerTower, this.enemyTower);
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
    this.coins = this.coins.filter(coin => {
      if (coin.isDead) { this.coinLayer.removeChild(coin.container); coin.destroy(); return false; }
      return true;
    });
    this.damageLabels = this.damageLabels.filter(l => {
      if (l.isDead) { this.labelLayer.removeChild(l.container); l.destroy(); return false; }
      return true;
    });

    this.hud.update();

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
      this.cpuStance === 'defend' ? 0 : 2;

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
        // Prefer non-medic attackers that are marching (not engaged), closest to a coin
        const pool = cpuChars.filter(
          c => c.behavior === 'attacking' && c.config.type !== 'medic' && c.state === 'marching',
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

    if (this.cpuStance === 'defend') {
      // All non-collecting units hold the defensive line in harass mode.
      // Warriors/heavies form a melee wall; archers/riflemen shoot over them; medics heal in place.
      for (const c of cpuChars) {
        if (c.behavior === 'collecting') continue;
        if (c.behavior !== 'harass') {
          c.behavior = 'harass';
          this.cpuStrategyInfo.decision = `↯ Defend wall #${c.id} (${c.config.type})`;
        }
      }
    } else {
      // Push / economy: recall all harassers back to full attack
      for (const c of cpuChars) {
        if (c.behavior === 'harass') {
          c.behavior = 'attacking';
          this.cpuStrategyInfo.decision = `⇒ Attack #${c.id} (${c.config.type})`;
        }
      }
    }
  }

  private fireProjectile(req: FireRequest) {
    const p = new Projectile(req.side, req.sx, req.sy, req.tx, req.ty, req.damage, req.projectileKind, req.shooter ?? null);
    this.projectiles.push(p);
    this.projLayer.addChild(p.container);
  }

  // ── Game state ───────────────────────────────────────────────────────────────

  private end(winner: 'player' | 'enemy', reason: 'tower' | 'timeout') {
    this.isOver = true;
    this.app.ticker.remove(this.tickFn);
    this.onGameOver(winner, reason);
  }

  reset() {
    this.app.ticker.remove(this.tickFn);

    for (const c of this.characters)    { c.destroy(); }
    for (const p of this.projectiles)   { p.destroy(); }
    for (const coin of this.coins)      { coin.destroy(); }
    for (const l of this.damageLabels)  { l.destroy(); }
    this.characters   = [];
    this.projectiles  = [];
    this.coins        = [];
    this.damageLabels = [];
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
