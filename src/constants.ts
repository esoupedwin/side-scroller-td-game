import { GameConfig } from './gameConfig';

const { canvas, groundY, colors, towers, characters, cpu, economy } = GameConfig;
const ch    = characters;
const proj  = GameConfig.projectiles;
const ui    = GameConfig.ui;
const promo = GameConfig.promotions;

export const GAME_WIDTH       = canvas.width;
export const GAME_HEIGHT      = canvas.height;
export const GAME_DURATION_SEC = canvas.durationSec;

export const GROUND_Y     = groundY;
export const TOWER_WIDTH  = towers.width;
export const TOWER_HEIGHT = towers.height;
export const TOWER_HP           = towers.hp;
export const TOWER_ATTACK_RANGE = towers.attackRange;
export const TOWER_ATTACK_POWER = towers.attackPower;
export const TOWER_FIRE_RATE    = towers.fireRate;

export const PLAYER_TOWER_X = towers.playerX;
export const ENEMY_TOWER_X  = towers.enemyX;

export const PLAYER_COLOR = colors.player;
export const ENEMY_COLOR  = colors.enemy;

// ── Character physics & interaction ─────────────────────────────────────────
export const CHAR_GRAVITY          = ch.gravity;
export const JUMP_VELOCITY         = ch.jumpVelocity;
export const CHAR_PICKUP_DIST      = ch.pickupDist;
export const CHAR_DEPOSIT_DIST     = ch.depositDist;
export const CHAR_CARRY_SPEED_MULT       = ch.coinCarrySpeedMult;
export const CHAR_COIN_RECOVERY_COOLDOWN = ch.coinRecoveryCooldownSec;
export const CHAR_HP_BAR_W         = ch.hpBarWidth;
export const CHAR_HP_BAR_H         = ch.hpBarHeight;

// ── CPU AI ───────────────────────────────────────────────────────────────────
export const CPU_SPAWN_MIN_MS    = cpu.spawnMinMs;
export const CPU_SPAWN_MAX_MS    = cpu.spawnMaxMs;
export const CPU_FIRST_SPAWN_MAX = cpu.firstSpawnMaxMs;
export const CPU_PRESSURE_THRESHOLD  = cpu.pressureThreshold;
export const CPU_URGENT_MAX_FACTOR   = cpu.urgentMaxFactor;
export const CPU_COMFORT_MIN_FACTOR  = cpu.comfortMinFactor;
export const CPU_NEUTRAL_MIN_FACTOR  = cpu.neutralMinFactor;
export const CPU_NEUTRAL_MAX_FACTOR  = cpu.neutralMaxFactor;

// ── Platform ─────────────────────────────────────────────────────────────────
export const PLATFORM_X      = GameConfig.platform.x;
export const PLATFORM_Y      = GameConfig.platform.y;
export const PLATFORM_WIDTH  = GameConfig.platform.width;
export const PLATFORM_HEIGHT = GameConfig.platform.height;

// ── Economy ──────────────────────────────────────────────────────────────────
export const STARTING_COINS      = economy.startingCoins;
export const PASSIVE_INCOME_RATE = economy.passiveIncomeRate;
export const COIN_VALUE          = economy.coinValue;
export const KILL_REWARD         = economy.killReward;
export const TOWER_KILL_REWARD   = economy.towerKillReward;
export const COIN_DROP_MIN_MS    = economy.dropIntervalMinMs;
export const COIN_DROP_MAX_MS    = economy.dropIntervalMaxMs;
export const COIN_LIFETIME_S     = economy.coinLifetimeSec;
export const COIN_DROP_X_MIN          = economy.dropZoneXMin;
export const COIN_DROP_X_MAX          = economy.dropZoneXMax;
export const LOW_BALANCE_THRESHOLD    = economy.lowBalanceThreshold;
export const LOW_BALANCE_INCOME_MULT  = economy.lowBalanceIncomeMult;
export const SILVER_COIN_VALUE        = economy.silverCoinValue;
export const SILVER_DROP_MIN_MS       = economy.silverDropIntervalMinMs;
export const SILVER_DROP_MAX_MS       = economy.silverDropIntervalMaxMs;
export const COIN_GRAVITY             = economy.coinGravity;
export const COIN_DROP_VX_MIN    = economy.dropBounceVxMin;
export const COIN_DROP_VX_MAX    = economy.dropBounceVxMax;
export const COIN_DROP_VY_MIN    = economy.dropBounceVyMin;
export const COIN_DROP_VY_MAX    = economy.dropBounceVyMax;
export const COIN_BOUNCE_DAMPING     = economy.coinBounceDamping;
export const COIN_BOUNCE_X_FRICTION  = economy.coinBounceXFriction;
export const COIN_BOUNCE_SETTLE_VY   = economy.coinBounceSettleVy;
export const COIN_BOUNCE_INIT_VX_MIN = economy.coinBounceInitVxMin;
export const COIN_BOUNCE_INIT_VX_MAX = economy.coinBounceInitVxMax;

// ── Projectiles ──────────────────────────────────────────────────────────────
export const BULLET_SPEED        = proj.bulletSpeed;
export const BULLET_MIN_TIME     = proj.bulletMinTime;
export const BULLET_ARC_FACTOR   = proj.bulletArcFactor;
export const BULLET_SPLASH       = proj.bulletSplash;
export const ARROW_SPEED         = proj.arrowSpeed;
export const ARROW_MIN_TIME      = proj.arrowMinTime;
export const ARROW_ARC_FACTOR    = proj.arrowArcFactor;
export const ARROW_SPLASH        = proj.arrowSplash;
export const PROJ_TOWER_SPLASH   = proj.towerSplashBonus;

// ── UI ───────────────────────────────────────────────────────────────────────
export const DMG_LABEL_LIFETIME  = ui.damageLabel.lifetimeSec;
export const DMG_LABEL_RISE      = ui.damageLabel.risePx;

// ── Promotions ───────────────────────────────────────────────────────────────
export const PROMO_KILL_AP     = promo.killAP;
export const PROMO_COIN_AP     = promo.coinAP;
export const PROMO_HP_BOOST    = promo.hpBoostPerRank;
export const PROMO_SPEED_BOOST = promo.speedBoostPerRank;
export const PROMO_ATK_BOOST   = promo.atkBoostPerRank;
// Plain number[] so it can be indexed by rank without tuple-type issues
export const PROMO_THRESHOLDS: number[] = [...promo.thresholds];

// ── Characters ───────────────────────────────────────────────────────────────
export const CHAR_HEAL_RANGE        = ch.healRange;
export const CHAR_HEAL_RATE         = ch.healRate;
export const HARASS_SAFETY_BUFFER   = ch.harassSafetyBuffer;
export const RANGED_KITE_THRESHOLD  = ch.rangedKiteThreshold;

export const CHAR_COST = {
  warrior:  ch.warrior.cost,
  archer:   ch.archer.cost,
  rifleman: ch.rifleman.cost,
  medic:    ch.medic.cost,
  heavy:    ch.heavy.cost,
} as const;

export const CHAR_WIDTH  = ch.width;
export const CHAR_HEIGHT = ch.height;

export const WARRIOR = {
  type:        ch.warrior.type,
  hp:          ch.warrior.hp,
  speed:       ch.warrior.speed,
  attackRange: ch.warrior.attackRange,
  attackPower: ch.warrior.attackPower,
  fireRate:    ch.warrior.fireRate,
  width:       ch.width,
  height:      ch.height,
};

export const ARCHER = {
  type:        ch.archer.type,
  hp:          ch.archer.hp,
  speed:       ch.archer.speed,
  attackRange: ch.archer.attackRange,
  attackPower: ch.archer.attackPower,
  fireRate:    ch.archer.fireRate,
  width:       ch.width,
  height:      ch.height,
};

export const RIFLEMAN = {
  type:        ch.rifleman.type,
  hp:          ch.rifleman.hp,
  speed:       ch.rifleman.speed,
  attackRange: ch.rifleman.attackRange,
  attackPower: ch.rifleman.attackPower,
  fireRate:    ch.rifleman.fireRate,
  width:       ch.width,
  height:      ch.height,
};

export const MEDIC = {
  type:        ch.medic.type,
  hp:          ch.medic.hp,
  speed:       ch.medic.speed,
  attackRange: ch.medic.attackRange,
  attackPower: ch.medic.attackPower,
  fireRate:    ch.medic.fireRate,
  width:       ch.width,
  height:      ch.height,
};

export const HEAVY = {
  type:        ch.heavy.type,
  hp:          ch.heavy.hp,
  speed:       ch.heavy.speed,
  attackRange: ch.heavy.attackRange,
  attackPower: ch.heavy.attackPower,
  fireRate:    ch.heavy.fireRate,
  width:       ch.heavy.width,
  height:      ch.heavy.height,
};
