const VIEWPORT_W      = 1900;
const W               = Math.round(VIEWPORT_W * 2.25); // scrollable world width
const H               = 800;
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
    fireRate:    1.0,   // seconds between shots
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
    harassSafetyBuffer: 40,  // px outside enemy tower range where harass units hold
    defendPursuitRange: 600, // px — defenders pursue any enemy within this distance of their home tower face (larger than TOWER_ATTACK_RANGE so they can chase off ranged units firing in from just outside the defence zone)
    rangedKiteThreshold: 80, // px — ranged units back away when a melee enemy closes within this distance
    coinThrowScanRange:  80,  // px — scan radius for a new coin after throwing one toward tower
    coinThrowHoldSec:   0.5, // seconds the character holds the coin before releasing the throw
    safeZoneHealRate:    5,  // HP/s passively healed while within own tower's attack range
    hitJumpChance:    0.75,  // probability of jumping when struck by a projectile
    attackKnockbackVy:    80,  // px/s — small upward impulse applied with every per-character knockback
    attackKnockbackDecay: 4.0, // multiplied against knockbackVx each second (e^-decay); shared by melee + projectile hits

    conscript: {
      type:        'conscript' as const,
      hp:          110,
      speed:       150,  // faster than warrior
      attackRange: 36,
      attackPower: 10,   // damage per punch
      fireRate:    0.65, // rapid punches
      cost:        15,
      critical:    0.18, // untrained brawler
      knockback:   0,    // px/s horizontal impulse imparted on the target when this unit hits
    },
    warrior: {
      type:        'warrior'  as const,
      hp:          160,
      speed:       120,
      attackRange: 40,
      attackPower: 15,   // damage per swing
      fireRate:    0.8,  // seconds between swings
      cost:        25,
      critical:    0.10, // 10 % miss chance
      knockback:   0,
    },
    archer: {
      type:        'archer'   as const,
      hp:          100,
      speed:       70,
      attackRange: 180,
      attackPower: 12,
      fireRate:    2.2,
      cost:        50,
      critical:    0.08, // 8 % miss chance
      knockback:   0,
    },
    rifleman: {
      type:        'rifleman' as const,
      hp:          90,
      speed:       78,
      attackRange: 280,
      attackPower: 9,
      fireRate:    0.5,
      cost:        70,
      critical:    0.07, // 7 % miss chance
      knockback:   0,
    },
    sniper: {
      type:        'sniper' as const,
      hp:          70,
      speed:       50,
      attackRange: 320,
      attackPower: 35,
      fireRate:    2.8,
      cost:        100,
      critical:    0.05, // 5 % miss chance — trained marksman
      knockback:   0,
    },
    viking: {
      type:        'viking'   as const,
      hp:          280,
      speed:       100,
      attackRange: 44,
      attackPower: 20,
      fireRate:    1.0,
      cost:        120,
      critical:    0.12,
      knockback:   400,  // staggers melee victims back a clear ~100 px before decay zeroes vx
    },
    heavy: {
      type:        'heavy'    as const,
      hp:          220,
      speed:       25,
      attackRange: 48,
      attackPower: 40,
      fireRate:    1.3,
      cost:        80,
      critical:    0.12, // 12 % miss chance — slow and imprecise
      width:       28,
      height:      44,
      knockback:   0,
    },
    tanker: {
      type:        'tanker'   as const,
      hp:          500,
      speed:       30,
      attackRange: 240,
      attackPower: 75,
      fireRate:    3.2,   // slow but devastating
      cost:        160,
      critical:    0.08,
      width:       80,
      height:      70,
      knockback:   0,
    },
    grenadier: {
      type:        'grenadier' as const,
      hp:          110,
      speed:       65,
      attackRange: 280,
      attackPower: 55,   // grenade AoE damage per target hit
      fireRate:    2,
      cost:        90,
      critical:    0.08,
      knockback:   0,
    },
    rocketeer: {
      type:        'rocketeer' as const,
      hp:          120,
      speed:       68,
      attackRange: 260,
      attackPower: 70,   // rocket AoE damage per target hit
      fireRate:    2.5,
      cost:        120,
      critical:    0.06,
      knockback:   0,
    },
  },

  rocket: {
    fuseSec:             3.0,   // seconds until explosion if no contact
    hitRadius:           16,    // px — proximity to enemy triggers detonation
    splashRadius:        110,   // px — AoE damage radius
    gravity:             200,   // px/s² — much flatter arc than grenades
    launchVx:            380,   // px/s — horizontal launch speed
    splashMinDamageFrac: 0.30,  // fraction of full damage at blast edge
    knockbackMaxVx:      1200,  // px/s — horizontal knockback at direct hit
    knockbackMaxVy:      750,   // px/s — upward knockback at direct hit
    knockbackDecay:      4.0,   // same decay rate as grenades
  },

  grenade: {
    fuseSec:             2.2,   // seconds until explosion
    splashRadius:        150,   // px — AoE damage radius
    gravity:             800,   // px/s² — matches character gravity
    maxVx:               400,   // px/s — max horizontal launch speed
    splashMinDamageFrac: 0.25,  // fraction of full damage dealt at the blast edge
    knockbackMaxVx:      1500,  // px/s — horizontal knockback at direct hit
    knockbackMaxVy:      940,   // px/s — upward knockback at direct hit
    knockbackDecay:      4.0,   // multiplied against knockbackVx each second (e^-decay)
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

  coinBox: {
    x:         W / 2,             // centre of map
    y:         GROUND_Y - 350,    // top of box (≈80 px from canvas top)
    width:     48,
    height:    48,
    spreadDeg: 25,                // ± degrees from vertical coins can be released
  },

  economy: {
    startingCoins:      150,
    passiveIncomeRate:  0.8,
    coinValue:          30,
    killReward:         2,
    towerKillReward:    15,
    dropIntervalMinMs:  4_000,
    dropIntervalMaxMs:  15_000,
    coinLifetimeSec:    30,
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
    coinBounceDamping:    0.78, // restitution — fraction of vy retained on each bounce
    coinBounceInitVxMin:  60,   // px/s — horizontal kick on character-dropped coins (min)
    coinBounceInitVxMax:  130,  // px/s — horizontal kick on character-dropped coins (max)
    coinThrowVx:          300,  // px/s — horizontal component of throw (60° → vy ≈ vx × √3)
    coinThrowVy:          446,  // px/s — vertical (upward) component of throw
    coinFriction:         0.01, // contact friction on coin bodies (combined with surface via sqrt)
    coinFrictionAir:      0.003,// air resistance per tick — higher than default to settle faster
    surfaceFriction:      0.8,  // friction on ground/platform surfaces; characters unaffected
                                // because char friction=0 → sqrt(0 × 0.8)=0
  },

  projectiles: {
    bulletSpeed:        500,   // px/s
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

  powerUp: {
    pickupDist:  30,    // px — horizontal pickup radius
    lifetimeSec: 20,    // seconds on ground before expiry
    bobAmp:      4,     // px vertical bob amplitude
    bobFreq:     2.2,   // Hz
    bodyRadius:  20,    // physics circle radius
    speedMult:   2.5,   // speed multiplier for speed power-up
    speedDurSec: 15,    // seconds the speed boost lasts
    atkMult:     2.0,   // attack multiplier for attack power-up
    dropIntervalSec: 40, // seconds between power-up drops
    indicatorLeadSec: 20, // seconds before drop that indicator appears
    indicatorDriftSpeed: 0.667, // fraction of full drift speed (1 = original, 2/3 = 3× slower)
  },

  cheats: {
    playerCoinGrant: 100,   // K key — coins added to player balance
    cpuCoinGrant:    100,   // L key — coins added to CPU balance
  },

  promotions: {
    killAP:            1,     // achievement points per kill
    coinAP:            2,     // AP per successful coin deposit
    thresholds:        [5, 15, 30],   // cumulative AP to reach Corporal, Sergeant, Captain
    hpBoostPerRank:    0.20,  // +20% max HP per rank above Private
    speedBoostPerRank: 0.10,  // +10% speed per rank
    atkBoostPerRank:   0.15,  // +15% attack power per rank
  },

  audio: {
    sfxVolume: 0.32,
    // Spatial attenuation: sounds originating outside the viewport fade with distance.
    spatialMaxDist: 800,  // world-px beyond the viewport edge at which volume reaches its minimum
    spatialMinVol:  0.05, // volume fraction at or beyond spatialMaxDist (0 = silent)
    // Each sound maps to one or more source files — Howler picks the first format the browser supports.
    // WAV and FLAC work in all browsers; OGG works everywhere except Safari.
    // An empty array disables that sound gracefully — no file required until you have it.
    sounds: {
      // List every format you might have — Howler picks the first file that actually exists.
      // Keep the format your file is in as the first entry for fastest loading.
      sword_slash:      ['/audio/sword_slash.ogg',       '/audio/sword_slash.mp3',      '/audio/sword_slash.wav'],
      punch:            ['/audio/punch.wav',              '/audio/punch.mp3',             '/audio/punch.ogg'],
      arrow_fire:       ['/audio/arrow_fire.wav',         '/audio/arrow_fire.mp3',        '/audio/arrow_fire.ogg'],
      gun_fire:         ['/audio/gun_fire.wav',           '/audio/gun_fire.mp3',          '/audio/gun_fire.ogg'],
      sniper_shot:      ['/audio/sniper_shot.wav',        '/audio/sniper_shot.mp3',       '/audio/sniper_shot.ogg'],
      rocket_launch:    ['/audio/rocket_launch.mp3',      '/audio/rocket_launch.wav',     '/audio/rocket_launch.ogg'],
      grenade_throw:    ['/audio/grenade_throw.wav',      '/audio/grenade_throw.mp3',     '/audio/grenade_throw.ogg'],
      rocket_explosion: ['/audio/rocket_explosion.wav',   '/audio/rocket_explosion.mp3',  '/audio/rocket_explosion.ogg'],
      grenade_explosion:['/audio/grenade_explosion.wav',  '/audio/grenade_explosion.mp3', '/audio/grenade_explosion.ogg'],
      level_up:         ['/audio/level_up.wav',           '/audio/level_up.mp3',          '/audio/level_up.ogg'],
    },
  },
} as const;
