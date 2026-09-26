import { GameConfig, type AttackStyle, type CharTypeName, type TribePowerUpId } from './gameConfig';
import { isTouchDevice } from './mobile';
import type { CharacterConfig } from './Character';
import type { Tribe } from './Tribes';

// Re-export the config-derived character types — source files import from
// constants.ts, never from gameConfig.ts directly.
export type { AttackStyle, CharTypeName, TribePowerUpId };

const { canvas, groundY, colors, towers, characters, cpu, economy } = GameConfig;
const ch    = characters;
const proj  = GameConfig.projectiles;
const ui    = GameConfig.ui;
const promo = GameConfig.promotions;
const pu    = GameConfig.powerUp;
const gr    = GameConfig.grenade;
const rkt   = GameConfig.rocket;

// Fixed logical canvas width. The game now renders at a fixed logical size
// (VIEWPORT_WIDTH × GAME_HEIGHT) and the whole #game-container is CSS-scaled to
// fit the browser window (see fitGameToWindow in main.ts). Decoupling this from
// window.innerWidth makes the view monitor-independent (so map balance doesn't
// depend on viewer's monitor size) and lets the scale-to-fit actually enlarge.
export const VIEWPORT_WIDTH = 1920;

// Fixed logical viewport (canvas) height. Drives the canvas size, camera anchor,
// scale-to-fit aspect, and the resolution backing-store base — but NOT the game's
// coordinate space. GROUND_Y, the ground, and all saved map Y-coordinates stay
// tied to GAME_HEIGHT (below), so editing this just changes how tall the visible
// frame is (more/less sky) without moving any game elements. Default 800 = no
// change. Raise it (e.g. 1080) to make the frame closer to 16:9 / reduce letterbox.
export const VIEWPORT_HEIGHT = 1000;

// How far (screen px) the camera may pan DOWN below its default resting view.
// Lower = less peeking below the ground; 0 = no downward pan at all. The
// world-bottom limit still applies, so this only ever further restricts it.
export const CAMERA_MAX_PAN_DOWN = 160;

// Distance (screen px) between the bottom edge of the camera view and the
// player tower's bottom (baseY) in the default resting view. Larger = the
// tower sits higher up the screen, leaving more room below it; smaller = the
// tower bottom hugs the canvas bottom. Anchoring on the tower base (not the
// ground) keeps this gap consistent even when the tower is placed on a block.
export const CAMERA_TOWER_BOTTOM_GAP = 210;

// In-world rendering zoom. Applied to the `world` PIXI container so all game
// objects, backgrounds, and characters scale uniformly. Ground stays anchored
// at its current screen position (see Game.build()).
// Touch devices get a closer camera (GameConfig.mobile.worldZoomMult) — the
// logical frame is shown at ~0.4× on a phone and reads small otherwise.
export const GAME_ZOOM = 1.5 * (isTouchDevice ? GameConfig.mobile.worldZoomMult : 1);
// DOM HUD zoom on touch devices (1 elsewhere); main.ts publishes it as --hud-scale.
export const MOBILE_HUD_SCALE = isTouchDevice ? GameConfig.mobile.hudScale : 1;
export const TEXTURE_GC_IDLE_SEC = isTouchDevice ? GameConfig.mobile.textureGcIdleSec : GameConfig.textureGcIdleSec;
// Sprite-atlas memory policy (see GameConfig.mobile). Desktop keeps the original
// 1.25 headroom and retains atlas bitmaps; touch devices trade a little
// oversampling nobody can see on a phone for a much smaller resident set.
export const SPRITE_ATLAS_HEADROOM = isTouchDevice ? GameConfig.mobile.atlasHeadroom : 1.25;
export const SPRITE_ATLAS_GPU_ONLY = isTouchDevice && GameConfig.mobile.gpuOnlyAtlases;
const deviceMemoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
export const SPRITE_ATLAS_LOWMEM_SCALE =
  isTouchDevice && deviceMemoryGB !== undefined && deviceMemoryGB <= 4 ? GameConfig.mobile.lowMemoryAtlasScale : 1;
export const GAME_WIDTH       = GameConfig.worldWidth; // scrollable world width (2246 px)
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
export const CPU_SPRITE_RETRY_MS = cpu.spriteRetryMs;
export const CPU_SPAWN_MAX_MS    = cpu.spawnMaxMs;
export const CPU_FIRST_SPAWN_MAX = cpu.firstSpawnMaxMs;
export const CPU_PRESSURE_THRESHOLD  = cpu.pressureThreshold;
export const CPU_URGENT_MAX_FACTOR   = cpu.urgentMaxFactor;
export const CPU_COMFORT_MIN_FACTOR  = cpu.comfortMinFactor;
export const CPU_NEUTRAL_MIN_FACTOR  = cpu.neutralMinFactor;
export const CPU_NEUTRAL_MAX_FACTOR  = cpu.neutralMaxFactor;
export const CPU_RETREAT_HP_FRAC      = cpu.retreatHpFrac;
export const CPU_RETREAT_RECOVER_FRAC = cpu.retreatRecoverFrac;
export const CPU_ENDGAME_SEC          = cpu.endgameSec;
export const CPU_VAL_RANGE_DIVISOR    = cpu.valuation.rangeReachDivisor;
export const CPU_VAL_HP_DIVISOR       = cpu.valuation.hpTankyDivisor;
export const CPU_VAL_SPLASH_PUSH_MULT = cpu.valuation.splashPushMult;
export const CPU_VAL_THREAT_NORM      = cpu.valuation.threatNorm;

// ── Platform ─────────────────────────────────────────────────────────────────
export const PLATFORM_X      = GameConfig.platform.x;
export const PLATFORM_Y      = GameConfig.platform.y;
export const PLATFORM_WIDTH  = GameConfig.platform.width;
export const PLATFORM_HEIGHT = GameConfig.platform.height;

// ── Coin box ─────────────────────────────────────────────────────────────────
export const COIN_BOX_X          = GameConfig.coinBox.x;
export const COIN_BOX_Y          = GameConfig.coinBox.y;
export const COIN_BOX_W          = GameConfig.coinBox.width;
export const COIN_BOX_H          = GameConfig.coinBox.height;
export const COIN_BOX_SPREAD_DEG = GameConfig.coinBox.spreadDeg;
export const COIN_BOX_VISUAL_SCALE = GameConfig.coinBox.visualScale;

// ── Economy ──────────────────────────────────────────────────────────────────
export const STARTING_COINS      = economy.startingCoins;
export const PASSIVE_INCOME_RATE = economy.passiveIncomeRate;
export const COIN_VALUE          = economy.coinValue;
export const KILL_REWARD         = economy.killReward;
export const TOWER_KILL_REWARD   = economy.towerKillReward;
export const COIN_DROP_MIN_MS    = economy.dropIntervalMinMs;
export const COIN_DROP_MAX_MS    = economy.dropIntervalMaxMs;
export const COIN_LIFETIME_S     = economy.coinLifetimeSec;
export const LOW_BALANCE_THRESHOLD    = economy.lowBalanceThreshold;
export const LOW_BALANCE_INCOME_MULT  = economy.lowBalanceIncomeMult;
export const SILVER_COIN_VALUE        = economy.silverCoinValue;
export const SILVER_DROP_MIN_MS       = economy.silverDropIntervalMinMs;
export const SILVER_DROP_MAX_MS       = economy.silverDropIntervalMaxMs;
export const BLUE_COIN_VALUE          = economy.blueCoinValue;
export const BLUE_DROP_MIN_MS         = economy.blueDropIntervalMinMs;
export const BLUE_DROP_MAX_MS         = economy.blueDropIntervalMaxMs;
export const COIN_GRAVITY             = economy.coinGravity;
export const COIN_DROP_VX_MIN    = economy.dropBounceVxMin;
export const COIN_DROP_VX_MAX    = economy.dropBounceVxMax;
export const COIN_DROP_VY_MIN    = economy.dropBounceVyMin;
export const COIN_DROP_VY_MAX    = economy.dropBounceVyMax;
export const COIN_BOUNCE_DAMPING     = economy.coinBounceDamping;
export const COIN_BOUNCE_INIT_VX_MIN = economy.coinBounceInitVxMin;
export const COIN_BOUNCE_INIT_VX_MAX = economy.coinBounceInitVxMax;
export const COIN_FRICTION           = economy.coinFriction;
export const COIN_FRICTION_AIR       = economy.coinFrictionAir;
export const SURFACE_FRICTION        = economy.surfaceFriction;
export const COIN_VISUAL_SCALE       = economy.coinVisualScale;

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

// ── Loadout ──────────────────────────────────────────────────────────────────
export const LOADOUT_MAX_CARDS   = GameConfig.loadout.maxCards;

// ── Tribe power-ups ──────────────────────────────────────────────────────────
const tpu = GameConfig.tribePowerUp;
export const TRIBE_PU_COOLDOWN_SEC     = tpu.cooldownSec;
export const TRIBE_PU_DURATION_SEC     = tpu.durationSec;
export const TRIBE_PU_SPEED_MULT       = tpu.speedMult;
export const TRIBE_PU_HEAL_PER_SEC     = tpu.vitalityHealPerSec;
export const TRIBE_PU_PLAGUE_DAMAGE    = tpu.plagueDamage;
export const TRIBE_PU_PLAGUE_TICKS     = tpu.plagueTicks;
export const TRIBE_PU_PLAGUE_INTERVAL  = tpu.plagueIntervalSec;
export const TRIBE_PU_AGGRESSION_MULT  = tpu.aggressionMult;
export const TRIBE_PU_PLAYER_DEFAULT: TribePowerUpId = tpu.playerDefault;

/** UI metadata for the four tribe power-ups (picker cards + activation button).
 *  `art` is the PNG skin used by the in-game button and picker; `icon` stays as
 *  the compact emoji fallback (dev bar, text rows). */
export const TRIBE_POWER_UPS: Record<TribePowerUpId, { name: string; icon: string; desc: string; art: string }> = {
  speed:      { name: 'Speed',      icon: '⚡', desc: `All your characters move faster for ${tpu.durationSec}s`,       art: '/sprites/misc/powerup_speed.png' },
  vitality:   { name: 'Vitality',   icon: '💚', desc: `All your characters heal for ${tpu.durationSec}s`,              art: '/sprites/misc/powerup_vitality.png' },
  plague:     { name: 'Plague',     icon: '☠️', desc: `All enemy characters are poisoned`,                             art: '/sprites/misc/powerup_plague.png' },
  aggression: { name: 'Aggression', icon: '🔥', desc: `All your characters deal double damage for ${tpu.durationSec}s`, art: '/sprites/misc/powerup_aggression.png' },
};
export const TRIBE_PU_IDS = Object.keys(TRIBE_POWER_UPS) as readonly TribePowerUpId[];

// ── Dev cheats ───────────────────────────────────────────────────────────────
export const CHEAT_PLAYER_COIN_GRANT  = GameConfig.cheats.playerCoinGrant;
export const CHEAT_CPU_COIN_GRANT     = GameConfig.cheats.cpuCoinGrant;
export const CHEAT_SKIP_INTRO_SCREENS = GameConfig.cheats.skipIntroScreens;
export const CHEAT_TOWER_DAMAGE       = GameConfig.cheats.towerDamage;
export const CHEAT_CLOCK_SKIP_SEC     = GameConfig.cheats.clockSkipSec;

// ── Power-ups ────────────────────────────────────────────────────────────────
export const POWERUP_PICKUP_DIST    = pu.pickupDist;
export const POWERUP_LIFETIME_S     = pu.lifetimeSec;
export const POWERUP_BOB_AMP        = pu.bobAmp;
export const POWERUP_BOB_FREQ       = pu.bobFreq;
export const POWERUP_BODY_RADIUS    = pu.bodyRadius;
export const POWERUP_SPEED_MULT     = pu.speedMult;
export const POWERUP_SPEED_DUR_S    = pu.speedDurSec;
export const POWERUP_ATK_MULT       = pu.atkMult;
export const POWERUP_DROP_INTERVAL  = pu.dropIntervalSec;
export const POWERUP_INDICATOR_LEAD = pu.indicatorLeadSec;

// ── VFX / screen shake ─────────────────────────────────────────────────────────
const vfx = GameConfig.vfx;
export const SHAKE_DECAY       = vfx.shakeDecay;
export const SHAKE_MAX_OFFSET  = vfx.shakeMaxOffset;
export const SHAKE_GRENADE     = vfx.shakeGrenade;
export const SHAKE_ROCKET      = vfx.shakeRocket;
export const SHAKE_FALLOFF_PX  = vfx.shakeFalloffPx;

// ── Promotions ───────────────────────────────────────────────────────────────
export const PROMO_KILL_AP     = promo.killAP;
export const PROMO_COIN_AP     = promo.coinAP;
export const PROMO_HP_BOOST    = promo.hpBoostPerRank;
export const PROMO_SPEED_BOOST = promo.speedBoostPerRank;
export const PROMO_ATK_BOOST   = promo.atkBoostPerRank;
// Plain number[] so it can be indexed by rank without tuple-type issues
export const PROMO_THRESHOLDS: number[] = [...promo.thresholds];

// ── Characters ───────────────────────────────────────────────────────────────
export const SAFE_ZONE_HEAL_RATE      = ch.safeZoneHealRate;
export const HIT_JUMP_CHANCE        = ch.hitJumpChance;
export const RANDOM_JUMP_INTERVAL_MIN  = ch.randomJumpIntervalMinSec;
export const RANDOM_JUMP_INTERVAL_VAR  = ch.randomJumpIntervalVarSec;
export const RANDOM_JUMP_CHANCE        = ch.randomJumpChance;
export const RANDOM_JUMP_CHANCE_DEFEND = ch.randomJumpChanceDefend;
export const RANDOM_JUMP_HOME_MARGIN   = ch.randomJumpHomeMargin;
export const EVASIVE_JUMP_COOLDOWN     = ch.evasiveJumpCooldownSec;
export const EVASIVE_JUMP_CHANCE       = ch.evasiveJumpChance;
export const EVASIVE_JUMP_SCAN_RANGE   = ch.evasiveJumpScanRange;
export const CHAR_LOW_HEALTH_RATIO       = ch.lowHealthRatio;
export const CHAR_LOW_HEALTH_BLINK_COLOR = ch.lowHealthBlinkColor;
export const CHAR_LOW_HEALTH_BLINK_HZ    = ch.lowHealthBlinkHz;
export const CHAR_POISON_COLOR           = ch.poisonColor;
export const ATTACK_KNOCKBACK_VY    = ch.attackKnockbackVy;
export const ATTACK_KNOCKBACK_DECAY = ch.attackKnockbackDecay;
export const HARASS_SAFETY_BUFFER   = ch.harassSafetyBuffer;
export const HARASS_RALLY_OFFSET    = ch.harassRallyOffset;
export const HARASS_GROUP_DIST      = ch.harassGroupDist;
export const HARASS_RALLY_TOLERANCE = ch.harassRallyTolerance;
export const DEFEND_PURSUIT_RANGE   = ch.defendPursuitRange;
export const RANGED_KITE_THRESHOLD  = ch.rangedKiteThreshold;
export const COIN_PICK_DIST_OFFSET  = ch.coinPickDistOffset;
export const COIN_THROW_SCAN_RANGE  = ch.coinThrowScanRange;
export const COIN_THROW_HOLD_SEC    = ch.coinThrowHoldSec;
export const COIN_THROW_MAX_Y_GAP   = ch.coinThrowMaxYGap;
export const COIN_THROW_VX          = GameConfig.economy.coinThrowVx;
export const COIN_THROW_VY          = GameConfig.economy.coinThrowVy;
export const COIN_THROW_MIN_DIST    = GameConfig.towers.attackRange + 50;

export const CHAR_WIDTH  = ch.width;
export const CHAR_HEIGHT = ch.height;

// ── Per-tribe character configs ─────────────────────────────────────────────
// Each tribe fields its own units with independent stats (gameConfig.characters
// .<tribe>); `common` holds tribe-less CPU/hidden types (heavy, tanker). Costs
// are per-tribe too. A unit config/cost is looked up via charConfig/charCost,
// which fall back tribe → common → other tribe so dev-forced cross-tribe types
// still resolve.

/** Shape of a raw per-type block in gameConfig.characters.<tribe>. Superset of
 *  CharacterConfig fields; width/height are optional (defaulted from ch.width /
 *  ch.height). burstCount is carried through so the CPU's attribute-driven unit
 *  valuation can price burst weapons correctly (burstIntervalSec stays a
 *  gunslinger-global constant). */
type RawCharCfg = {
  id: CharacterConfig['id'];
  attackStyle: AttackStyle;
  hp: number; speed: number; attackRange: number; attackPower: number;
  fireRate: number; cost: number; critical: number; knockback: number;
  width?: number; height?: number;
  shotsBeforeCooldown?: number; cooldownSec?: number;
  burstCount?: number;
  poisonDamage?: number; poisonTicks?: number; poisonIntervalSec?: number;
  blockChance?: number; blockPercent?: number;
  displayName?: string; icon?: string; uiColor?: string;
  spriteFolder?: string;   // sprite-only concern — consumed by SpriteRegistry, not CharacterConfig
};

function toCharConfig(c: RawCharCfg): CharacterConfig {
  return {
    id:          c.id,
    attackStyle: c.attackStyle,
    hp:          c.hp,
    speed:       c.speed,
    attackRange: c.attackRange,
    attackPower: c.attackPower,
    fireRate:    c.fireRate,
    critical:    c.critical,
    width:       c.width  ?? ch.width,
    height:      c.height ?? ch.height,
    knockback:   c.knockback,
    shotsBeforeCooldown: c.shotsBeforeCooldown,
    cooldownSec:         c.cooldownSec,
    burstCount:          c.burstCount,
    poisonDamage:      c.poisonDamage,
    poisonTicks:       c.poisonTicks,
    poisonIntervalSec: c.poisonIntervalSec,
    blockChance:       c.blockChance,
    blockPercent:      c.blockPercent,
    displayName:       c.displayName,
    icon:              c.icon,
    uiColor:           c.uiColor,
  };
}

function buildConfigs(block: Record<string, RawCharCfg>): Record<string, CharacterConfig> {
  const out: Record<string, CharacterConfig> = {};
  for (const k in block) out[k] = toCharConfig(block[k]);
  return out;
}
function buildCosts(block: Record<string, RawCharCfg>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k in block) out[k] = block[k].cost;
  return out;
}

const kattgardRaw = ch.kattgard as unknown as Record<string, RawCharCfg>;
const lapinorRaw  = ch.lapinor  as unknown as Record<string, RawCharCfg>;
const commonRaw   = ch.common   as unknown as Record<string, RawCharCfg>;

const COMMON_CONFIGS = buildConfigs(commonRaw);
const COMMON_COSTS   = buildCosts(commonRaw);

/** Per-tribe unit config map — the tribe's own units merged over `common`. */
export const CHAR_CONFIGS_BY_TRIBE: Record<Tribe, Record<string, CharacterConfig>> = {
  kattgard: { ...COMMON_CONFIGS, ...buildConfigs(kattgardRaw) },
  lapinor:  { ...COMMON_CONFIGS, ...buildConfigs(lapinorRaw)  },
};

/** Per-tribe unit cost map — same merge as CHAR_CONFIGS_BY_TRIBE. */
export const CHAR_COST_BY_TRIBE: Record<Tribe, Record<string, number>> = {
  kattgard: { ...COMMON_COSTS, ...buildCosts(kattgardRaw) },
  lapinor:  { ...COMMON_COSTS, ...buildCosts(lapinorRaw)  },
};

const otherTribe = (t: Tribe): Tribe => (t === 'kattgard' ? 'lapinor' : 'kattgard');

/** Config for a unit of `type` fielded by `tribe`. Falls back to the shared
 *  `common` block (already merged in), then the other tribe (dev-forced types). */
export function charConfig(tribe: Tribe, type: string): CharacterConfig {
  return CHAR_CONFIGS_BY_TRIBE[tribe][type]
      ?? CHAR_CONFIGS_BY_TRIBE[otherTribe(tribe)][type];
}

/** Coin cost of a unit for a tribe, with the same fallback chain. Infinity if
 *  the type is unknown to both tribes and common. */
export function charCost(tribe: Tribe, type: string): number {
  return CHAR_COST_BY_TRIBE[tribe][type]
      ?? CHAR_COST_BY_TRIBE[otherTribe(tribe)][type]
      ?? Infinity;
}

// ── Config-driven character UI lookups ───────────────────────────────────────
// Display name / icon / accent colour come from the character's config block
// (with graceful generic fallbacks) so a new character needs no UI-table edits.

/** UI display name — config `displayName`, else the capitalized type key. */
export function charDisplayName(tribe: Tribe, type: string): string {
  return charConfig(tribe, type)?.displayName
      ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/** HUD/button emoji — config `icon`, else a generic per-attackStyle glyph. */
export function charIcon(tribe: Tribe, type: string): string {
  const cfg = charConfig(tribe, type);
  if (cfg?.icon) return cfg.icon;
  const byStyle: Record<AttackStyle, string> = {
    melee: '⚔', blast: '💥', arrow: '🏹', bullet: '🔫', grenade: '💣', rocket: '🚀',
  };
  return cfg ? byStyle[cfg.attackStyle] : '❓';
}

/** HUD accent colour — config `uiColor`, else neutral white. */
export function charUiColor(tribe: Tribe, type: string): string {
  return charConfig(tribe, type)?.uiColor ?? '#ffffff';
}

/** Sprite-sheet folder under /public/sprites/<tribe>/ — config `spriteFolder`
 *  override (e.g. Lapinor's capitalised 'Sniper' asset dir), else the type key. */
export function charSpriteFolder(tribe: Tribe, type: string): string {
  const raw = (tribe === 'kattgard' ? kattgardRaw : lapinorRaw)[type] ?? commonRaw[type];
  return raw?.spriteFolder ?? type;
}

/** Every character type known to the game (both tribes + common). Used by dev
 *  tools that need the full cross-tribe list (e.g. the forced-spawn dropdown). */
export const ALL_CHAR_TYPES: readonly string[] = [...new Set([
  ...Object.keys(kattgardRaw), ...Object.keys(lapinorRaw), ...Object.keys(commonRaw),
])];

// Burst-fire tunables — Lapinor's gunslinger fires `burstCount` rounds spaced
// `burstIntervalSec` apart on each trigger pull (see Character.tickPendingBurst).
export const GUNSLINGER_BURST_COUNT    = ch.lapinor.gunslinger.burstCount;
export const GUNSLINGER_BURST_INTERVAL = ch.lapinor.gunslinger.burstIntervalSec;

// ── Grenade ──────────────────────────────────────────────────────────────────
export const GRENADE_FUSE_S            = gr.fuseSec;
export const GRENADE_SPLASH_R          = gr.splashRadius;
export const GRENADE_GRAVITY           = gr.gravity;
export const GRENADE_MAX_VX            = gr.maxVx;
export const GRENADE_SPLASH_MIN_FRAC   = gr.splashMinDamageFrac;
export const GRENADE_KNOCKBACK_MAX_VX  = gr.knockbackMaxVx;
export const GRENADE_KNOCKBACK_MAX_VY  = gr.knockbackMaxVy;
export const GRENADE_KNOCKBACK_DECAY   = gr.knockbackDecay;

// ── Rocket ───────────────────────────────────────────────────────────────────
export const ROCKET_FUSE_S             = rkt.fuseSec;
export const ROCKET_HIT_RADIUS         = rkt.hitRadius;
export const ROCKET_SPLASH_R           = rkt.splashRadius;
export const ROCKET_GRAVITY            = rkt.gravity;
export const ROCKET_LAUNCH_VX          = rkt.launchVx;
export const ROCKET_SPLASH_MIN_FRAC    = rkt.splashMinDamageFrac;
export const ROCKET_KNOCKBACK_MAX_VX   = rkt.knockbackMaxVx;
export const ROCKET_KNOCKBACK_MAX_VY   = rkt.knockbackMaxVy;
export const ROCKET_KNOCKBACK_DECAY    = rkt.knockbackDecay;

// ── Audio ────────────────────────────────────────────────────────────────────
export const SFX_VOLUME           = GameConfig.audio.sfxVolume;
export const SFX_SOUNDS           = GameConfig.audio.sounds;
export const SFX_SPATIAL_MAX_DIST = GameConfig.audio.spatialMaxDist;
export const SFX_SPATIAL_MIN_VOL  = GameConfig.audio.spatialMinVol;
