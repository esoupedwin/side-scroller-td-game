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
    harassRallyOffset:   80, // px in front of own tower where a lone harass unit rallies when no enemies are visible
    harassGroupDist:     55, // px — a harass unit regroups toward its nearest ally when farther than this
    harassRallyTolerance: 20, // px — how close to the solo rally point a harass unit must get before holding
    defendPursuitRange: 600, // px — defenders pursue any enemy within this distance of their home tower face (larger than TOWER_ATTACK_RANGE so they can chase off ranged units firing in from just outside the defence zone)
    rangedKiteThreshold: 80, // px — ranged units back away when a melee enemy closes within this distance
    coinThrowScanRange:  80,  // px — scan radius for a new coin after throwing one toward tower
    coinThrowHoldSec:   0.5, // seconds the character holds the coin before releasing the throw
    coinThrowMaxYGap:   100, // px — if the carrier's standing surface sits at least this much below the home tower's base, skip throwing and keep carrying (prevents arcing coins into a wall when the tower is on an elevated block ~120 px tall — the threshold is set a few px below the block height to be robust to small tower-placement offsets in the map builder)
    safeZoneHealRate:    5,  // HP/s passively healed while within own tower's attack range
    hitJumpChance:    0.75,  // probability of jumping when struck by a projectile

    // ── Liveness ("random") jump: occasional hop so marching units feel alive ──
    randomJumpIntervalMinSec: 1.5,  // base seconds between liveness-jump checks
    randomJumpIntervalVarSec: 2.0,  // added random variance (→ checks every 1.5–3.5 s)
    randomJumpChance:         0.20, // probability of a liveness jump per check
    randomJumpChanceDefend:   0.02, // dampened chance while on defend duty (stay in formation)
    randomJumpHomeMargin:     120,  // px from the home tower face within which liveness jumps are suppressed

    // ── Evasive jump: hop over an enemy blocking the path while collecting ──────
    evasiveJumpCooldownSec:   2.0,  // seconds between evasive-jump attempts
    evasiveJumpChance:        0.80, // probability of jumping a blocker when one is detected
    evasiveJumpScanRange:     60,   // px ahead to scan for a blocking enemy

    attackKnockbackVy:    80,  // px/s — small upward impulse applied with every per-character knockback
    attackKnockbackDecay: 4.0, // multiplied against knockbackVx each second (e^-decay); shared by melee + projectile hits
    lowHealthRatio:     0.3,      // hp/maxHp at or below which the body blinks a red tint
    lowHealthBlinkColor: 0xff2b2b, // tint colour pulsed onto the body while low on health
    lowHealthBlinkHz:    2.4,     // blink pulses per second
    poisonColor:        0x66cc33, // green used for the poisoned-body tint and poison damage numbers

    // ── Per-tribe rosters ──────────────────────────────────────────────────
    // Each tribe fully lists ITS OWN units with independent stats — Kattgard's
    // conscript ≠ Lapinor's conscript. Types that belong to no tribe (heavy,
    // tanker — CPU/hidden) live in `common` below.
    //
    // ★ ADDING A NEW CHARACTER: add a block here (key = type name) and you're
    //   done — everything else derives from it automatically:
    //   • roster + spawn button + loadout card (key order = display order)
    //   • the CharacterConfig['type'] union (derived from these keys)
    //   • combat semantics via `attackStyle` (see below)
    //   • CPU AI valuation (threat + buy order, from the stats)
    //   • sprite sheets from /public/sprites/<tribe>/<key>/{body,legs}/<anim>.png
    //     (drop the PNGs in; missing sheets fall back to a Graphics body chosen
    //     by attackStyle; `spriteFolder` overrides the folder name if needed)
    //
    //   Required: type, hp, speed, attackRange, attackPower, fireRate, cost,
    //             critical (miss chance), knockback, attackStyle:
    //     'melee'   — close swing (pendingMeleeSwing)
    //     'blast'   — frontal shotgun cone, hits everything in it
    //     'arrow'   — snap-fire projectile, no muzzle flash
    //     'bullet'  — snap-fire projectile with muzzle flash; add burstCount > 1
    //                 for burst fire
    //     'grenade' — arcing AoE with lead targeting
    //     'rocket'  — flat-arc AoE
    //   Optional: displayName (default: capitalized key), icon (emoji),
    //             uiColor (HUD accent), width/height, shotsBeforeCooldown +
    //             cooldownSec (magazine), poison*, spriteFolder.
    kattgard: {
      conscript: {
        type:        'conscript' as const,
        attackStyle: 'melee' as const, icon: '👊', uiColor: '#b07040',
        hp:          110, speed: 150, attackRange: 36, attackPower: 10,
        fireRate:    0.65, cost: 15, critical: 0.18, knockback: 0,
      },
      warrior: {
        type:        'warrior' as const,
        attackStyle: 'melee' as const, icon: '⚔', uiColor: '#00b4d8',
        hp:          160, speed: 120, attackRange: 40, attackPower: 15,
        fireRate:    0.8, cost: 25, critical: 0.10, knockback: 0,
      },
      archer: {
        type:        'archer' as const,
        attackStyle: 'arrow' as const, icon: '🏹', uiColor: '#43aa8b',
        hp:          100, speed: 70, attackRange: 180, attackPower: 12,
        fireRate:    2.2, cost: 50, critical: 0.08, knockback: 0,
        // Poison-tipped arrows — a hit applies a damage-over-time effect. Kattgard only.
        poisonDamage:      4,    // HP lost per poison tick
        poisonTicks:       4,    // number of ticks before it wears off
        poisonIntervalSec: 1.0,  // seconds between ticks
      },
      rifleman: {
        type:        'rifleman' as const,
        attackStyle: 'bullet' as const, icon: '🔫', uiColor: '#7a8c42',
        hp:          90, speed: 78, attackRange: 280, attackPower: 9,
        fireRate:    0.25, cost: 70, critical: 0.07, knockback: 0,
        shotsBeforeCooldown: 3, cooldownSec: 1.5,  // 3 rounds, then a 1.5 s reload
      },
      sniper: {
        type:        'sniper' as const,
        attackStyle: 'bullet' as const, icon: '🎯', uiColor: '#e07b39',
        hp:          70, speed: 50, attackRange: 380, attackPower: 35,
        fireRate:    3.1, cost: 100, critical: 0.05, knockback: 0,
      },
      viking: {
        type:        'viking' as const,
        attackStyle: 'melee' as const, icon: '🪓', uiColor: '#7a9e7e',
        hp:          350, speed: 100, attackRange: 44, attackPower: 20,
        fireRate:    1.0, cost: 120, critical: 0.12, knockback: 400,
      },
      shocktrooper: {
        type:        'shocktrooper' as const,
        attackStyle: 'blast' as const, displayName: 'Shock Trooper', icon: '💥', uiColor: '#c25b3a',
        hp:          130, speed: 85, attackRange: 190, attackPower: 20,
        fireRate:    0.7, cost: 90, critical: 0.10, knockback: 350,
        shotsBeforeCooldown: 3, cooldownSec: 2,  // 3 blasts, then a 2 s reload
      },
      grenadier: {
        type:        'grenadier' as const,
        attackStyle: 'grenade' as const, icon: '💣', uiColor: '#6b7a2a',
        hp:          110, speed: 65, attackRange: 280, attackPower: 55,
        fireRate:    2, cost: 90, critical: 0.08, knockback: 0,
      },
      rocketeer: {
        type:        'rocketeer' as const,
        attackStyle: 'rocket' as const, icon: '🚀', uiColor: '#cc4400',
        hp:          120, speed: 68, attackRange: 260, attackPower: 70,
        fireRate:    2.5, cost: 120, critical: 0.06, knockback: 0,
      },
    },
    lapinor: {
      conscript: {
        type:        'conscript' as const,
        attackStyle: 'melee' as const, icon: '👊', uiColor: '#b07040',
        hp:          110, speed: 150, attackRange: 36, attackPower: 10,
        fireRate:    0.65, cost: 15, critical: 0.18, knockback: 0,
      },
      warrior: {
        type:        'warrior' as const,
        attackStyle: 'melee' as const, icon: '⚔', uiColor: '#00b4d8',
        hp:          160, speed: 120, attackRange: 40, attackPower: 15,
        fireRate:    0.8, cost: 25, critical: 0.10, knockback: 0,
      },
      archer: {
        type:        'archer' as const,
        attackStyle: 'arrow' as const, icon: '🏹', uiColor: '#43aa8b',
        hp:          100, speed: 70, attackRange: 180, attackPower: 12,
        fireRate:    2.2, cost: 50, critical: 0.08, knockback: 0,
        // No poison — poison is a Kattgard-archer trait for now.
      },
      rifleman: {
        type:        'rifleman' as const,
        attackStyle: 'bullet' as const, icon: '🔫', uiColor: '#7a8c42',
        hp:          90, speed: 78, attackRange: 280, attackPower: 9,
        fireRate:    0.25, cost: 70, critical: 0.07, knockback: 0,
        shotsBeforeCooldown: 3, cooldownSec: 1.5,
      },
      gunslinger: {
        type:        'gunslinger' as const,
        attackStyle: 'bullet' as const, icon: '🤠', uiColor: '#b8860b',
        hp:          85, speed: 92, attackRange: 200, attackPower: 7,
        fireRate:    1.4, cost: 75, critical: 0.09, knockback: 0,
        burstCount:  3, burstIntervalSec: 0.09,  // 3-round burst per trigger pull
      },
      sniper: {
        type:        'sniper' as const,
        attackStyle: 'bullet' as const, icon: '🎯', uiColor: '#e07b39',
        hp:          70, speed: 50, attackRange: 380, attackPower: 35,
        fireRate:    3.1, cost: 100, critical: 0.05, knockback: 0,
        spriteFolder: 'Sniper',  // asset folder is capitalised on disk
      },
      knight: {
        type:        'knight' as const,
        attackStyle: 'melee' as const, icon: '🛡', uiColor: '#8b9faa',
        hp:          280, speed: 80, attackRange: 44, attackPower: 28,
        fireRate:    1.1, cost: 150, critical: 0.08, knockback: 250,
      },
      grenadier: {
        type:        'grenadier' as const,
        attackStyle: 'grenade' as const, icon: '💣', uiColor: '#6b7a2a',
        hp:          110, speed: 65, attackRange: 280, attackPower: 55,
        fireRate:    2, cost: 90, critical: 0.08, knockback: 0,
      },
      rocketeer: {
        type:        'rocketeer' as const,
        attackStyle: 'rocket' as const, icon: '🚀', uiColor: '#cc4400',
        hp:          120, speed: 68, attackRange: 260, attackPower: 70,
        fireRate:    2.5, cost: 120, critical: 0.06, knockback: 0,
      },
    },
    // Tribe-less types: CPU-only / hidden (not in any roster). Shared fallback.
    common: {
      heavy: {
        type:        'heavy' as const,
        attackStyle: 'melee' as const, icon: '🔨', uiColor: '#8899bb',
        hp:          220, speed: 25, attackRange: 48, attackPower: 40,
        fireRate:    1.3, cost: 80, critical: 0.12, width: 28, height: 44, knockback: 0,
      },
      tanker: {
        type:        'tanker' as const,
        attackStyle: 'bullet' as const, icon: '🪖', uiColor: '#8b4513',
        hp:          500, speed: 30, attackRange: 240, attackPower: 75,
        fireRate:    3.2, cost: 160, critical: 0.08, width: 80, height: 70, knockback: 0,
      },
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
    retreatHpFrac:        0.15,     // AI combat units fall back to 'defend' below this HP fraction…
    retreatRecoverFrac:   0.6,      // …and only rejoin the fight once healed back above this (hysteresis)

    // ── Attribute-driven unit valuation ──────────────────────────────────────
    // The CPU derives every unit's worth from its live config attributes
    // (sustained DPS, hp, range, cost, AoE) instead of hardcoded per-type
    // tables — editing a unit's stats automatically reshapes both the threat
    // assessment and the buy order. These knobs shape how attributes combine:
    valuation: {
      rangeReachDivisor: 600,   // reach = 1 + attackRange/divisor — lower values reward range more
      hpTankyDivisor:    350,   // tanky = 1 + hp/divisor — lower values reward durability more
      splashPushMult:    1.6,   // push-score multiplier for AoE units when opponents are clustered
      threatNorm:        55,    // combat×reach divisor so a baseline warrior threat ≈ 1.0
    },
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
    blueCoinValue:           200,    // rare jackpot — worth ~6.7× a gold coin
    blueDropIntervalMinMs:   60_000, // super rare: one every 1–2.5 minutes
    blueDropIntervalMaxMs:   150_000,
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

  loadout: {
    maxCards: 7,   // how many character cards the player can bring into a map
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
    dropIntervalSec: 25, // seconds between power-up drops
    indicatorLeadSec: 12, // seconds before drop that indicator appears
    indicatorDriftSpeed: 0.667, // fraction of full drift speed (1 = original, 2/3 = 3× slower)
  },

  cheats: {
    playerCoinGrant: 100,   // K key — coins added to player balance
    cpuCoinGrant:    100,   // L key — coins added to CPU balance
    // Dev fast-start: skip the splash screen and character selection on game
    // load (and on tribe/map switches) and jump straight into the match with
    // EVERY owned character card loaded — no 7-card cap, no 3-2-1 countdown.
    skipIntroScreens: true,
  },

  vfx: {
    shakeDecay:     3.0,   // trauma units bled off per second
    shakeMaxOffset: 30,    // px world displacement at full trauma
    shakeGrenade:   0.55,  // trauma added by a grenade blast
    shakeRocket:    0.85,  // trauma added by a rocket blast (bigger boom)
    shakeFalloffPx: 650,   // off-screen distance over which blast shake fades to 0
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

// ── Derived character types ──────────────────────────────────────────────────
// How a unit delivers damage — drives combat dispatch, snap-fire gating, kiting
// classification, muzzle VFX, CPU splash valuation, and the Graphics-fallback
// body. Set per character block above.
export type AttackStyle = 'melee' | 'blast' | 'arrow' | 'bullet' | 'grenade' | 'rocket';

// The unit-type union, derived from the config block keys — adding a new
// character block automatically extends it (no hand-maintained union).
export type CharTypeName =
  | keyof typeof GameConfig.characters.kattgard
  | keyof typeof GameConfig.characters.lapinor
  | keyof typeof GameConfig.characters.common;
