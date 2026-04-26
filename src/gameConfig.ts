const VIEWPORT_W      = 1248;
const W               = Math.round(VIEWPORT_W * 1.8);  // 2246 — scrollable world width
const H               = 480;
const CHAR_W          = 20;
const CHAR_H          = 32;
const GROUND_Y        = H - 80;
const GAME_DURATION_S = 300;   // seconds — total match length

export const GameConfig = {
  canvas:    { width: VIEWPORT_W, height: H, durationSec: GAME_DURATION_S },
  worldWidth: W,
  groundY:   H - 80,
  colors:  { player: 0x00b4d8, enemy: 0xe63946 },

  towers: {
    width:       48,
    height:      120,
    hp:          1000,
    playerX:     60,
    enemyX:      W - 60,
    attackRange: 300,   // px — horizontal range of tower fire
    attackPower: 40,    // damage per projectile
    fireRate:    2.5,   // seconds between shots
  },

  characters: {
    width:              CHAR_W,
    height:             CHAR_H,
    gravity:            800,    // px/s²
    jumpVelocity:       520,    // px/s  (peak height ≈ 169 px > 140 px platform gap)
    pickupDist:         22,     // px — how close a character must be to grab a coin
    depositDist:        28,     // px — how close to the tower to deposit a coin
    coinCarrySpeedMult:       0.6,  // speed multiplier while carrying a coin
    coinRecoveryCooldownSec:  2,    // seconds after dropping a coin before pickup is allowed
    hpBarWidth:         28,     // px
    hpBarHeight:        5,      // px
    healRange: 55,   // px — medic heal radius
    healRate:  8,    // HP/s healed to the most-injured ally in range
    harassSafetyBuffer: 40,  // px outside enemy tower range where harass units hold
    rangedKiteThreshold: 80, // px — ranged units back away when a melee enemy closes within this distance
    coinThrowScanRange:  80,  // px — scan radius for a new coin after throwing one toward tower
    coinThrowHoldSec:   0.5, // seconds the character holds the coin before releasing the throw

    warrior: {
      type:        'warrior'  as const,
      hp:          100,
      speed:       100,
      attackRange: 40,
      attackPower: 12,   // damage per swing
      fireRate:    0.8,  // seconds between swings
      cost:        25,
      critical:    0.10, // 10 % miss chance
    },
    archer: {
      type:        'archer'   as const,
      hp:          60,
      speed:       70,
      attackRange: 180,
      attackPower: 28,
      fireRate:    2.2,
      cost:        50,
      critical:    0.08, // 8 % miss chance
    },
    rifleman: {
      type:        'rifleman' as const,
      hp:          75,
      speed:       78,
      attackRange: 180,
      attackPower: 22,
      fireRate:    0.8,
      cost:        70,
      critical:    0.07, // 7 % miss chance
    },
    sniper: {
      type:        'sniper' as const,
      hp:          50,
      speed:       50,
      attackRange: 220,
      attackPower: 32,
      fireRate:    2.8,
      cost:        100,
      critical:    0.05, // 5 % miss chance — trained marksman
    },
    medic: {
      type:        'medic'    as const,
      hp:          50,
      speed:       45,
      attackRange: 0,
      attackPower: 0,
      fireRate:    0,
      cost:        60,
      critical:    0,    // no attacks
    },
    heavy: {
      type:        'heavy'    as const,
      hp:          160,
      speed:       25,
      attackRange: 48,
      attackPower: 40,
      fireRate:    1.3,
      cost:        80,
      critical:    0.12, // 12 % miss chance — slow and imprecise
      width:       28,
      height:      44,
    },
  },

  cpu: {
    spawnMinMs:           5_000,
    spawnMaxMs:           20_000,
    firstSpawnMaxMs:      3_000,    // cap on the very first spawn delay
    pressureThreshold:    2,        // unit difference that triggers urgent / comfortable mode
    urgentMaxFactor:      2,        // urgent: interval ∈ [spawnMin, spawnMin × urgentMaxFactor]
    comfortMinFactor:     0.65,     // comfortable: interval ∈ [spawnMax × comfortMinFactor, spawnMax]
    neutralMinFactor:     1.4,      // neutral: interval ∈ [spawnMin × neutralMinFactor, spawnMax × neutralMaxFactor]
    neutralMaxFactor:     0.75,
  },

  platform: {
    x:      W / 2 - 180,          // left edge (centred on map)
    y:      GROUND_Y - 140,       // top surface (140 px above ground)
    width:  360,
    height: 14,
  },

  economy: {
    startingCoins:      150,
    passiveIncomeRate:  0.8,
    coinValue:          30,
    killReward:         2,
    towerKillReward:    15,
    dropIntervalMinMs:  8_000,
    dropIntervalMaxMs:  15_000,
    coinLifetimeSec:    25,
    dropZoneXMin:       936,   // scaled with world width (≈ W/2 − 187)
    dropZoneXMax:       1310,  // scaled with world width (≈ W/2 + 187)
    silverCoinValue:         15,     // silver is worth less than gold (20)
    silverDropIntervalMinMs: 5_000, // drops 50% more often than gold (min)
    silverDropIntervalMaxMs: 10_000,// drops 50% more often than gold (max)
    lowBalanceThreshold:  25,   // below this balance, passive income rate doubles
    lowBalanceIncomeMult:  3,   // multiplier applied when balance is below threshold
    coinGravity:        520,    // px/s² — physics for airborne coins
    dropBounceVxMin:    60,     // px/s — horizontal bounce speed (min)
    dropBounceVxMax:    140,    // px/s — horizontal bounce speed (max)
    dropBounceVyMin:    160,    // px/s — upward bounce speed (min)
    dropBounceVyMax:    240,    // px/s — upward bounce speed (max)
    coinBounceDamping:    0.55, // restitution — fraction of vy retained on each bounce
    coinBounceXFriction:  0.62, // legacy (unused by Matter.js path)
    coinBounceSettleVy:   65,   // legacy (unused by Matter.js path)
    coinBounceInitVxMin:  60,   // px/s — horizontal kick on character-dropped coins (min)
    coinBounceInitVxMax:  130,  // px/s — horizontal kick on character-dropped coins (max)
    coinThrowVx:          300,  // px/s — horizontal component of throw (60° → vy ≈ vx × √3)
    coinThrowVy:          446,  // px/s — vertical (upward) component of throw
    coinDropStartY:       10,   // absolute y where sky-dropped coins spawn (near canvas top)
    coinFriction:         0.4,  // contact friction on coin bodies (combined with surface via sqrt)
    coinFrictionAir:      0.012,// air resistance per tick — higher than default to settle faster
    surfaceFriction:      0.8,  // friction on ground/platform surfaces; characters unaffected
                                // because char friction=0 → sqrt(0 × 0.8)=0
  },

  projectiles: {
    bulletSpeed:        1400,   // px/s
    bulletMinTime:      0.08,   // s — minimum travel time
    bulletArcFactor:    0.015,  // arc height = dist × factor
    bulletSplash:       18,     // px — hit radius at landing
    arrowSpeed:         400,    // px/s
    arrowMinTime:       0.30,   // s
    arrowArcFactor:     0.28,
    arrowSplash:        24,     // px
    towerSplashBonus:   30,     // extra px added to splash radius when targeting a tower
  },

  ui: {
    damageLabel: {
      lifetimeSec: 1.0,
      risePx:      38,   // total upward travel over lifetime
    },
  },

  promotions: {
    killAP:            1,     // achievement points per kill
    coinAP:            2,     // AP per successful coin deposit
    thresholds:        [5, 15, 30],   // cumulative AP to reach Corporal, Sergeant, Captain
    hpBoostPerRank:    0.20,  // +20% max HP per rank above Private
    speedBoostPerRank: 0.10,  // +10% speed per rank
    atkBoostPerRank:   0.15,  // +15% attack power per rank
  },
} as const;
