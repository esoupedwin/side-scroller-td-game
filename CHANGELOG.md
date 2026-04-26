# COIN — Changelog

## [cccf1a4] 2026-04-26 — Coin relay throw, tower range markers, boundary walls, platform pickup fix

### New features

**Tower range markers**
- Blue and red ground strips drawn at each tower's attack radius so players can read the engagement zone at a glance.
- Implemented in `Background.ts` (`buildTowerRangeMarkers`); called once at game start with zero runtime cost.
- Range driven by `towers.attackRange` in `gameConfig.ts` (currently 300 px).

**Coin relay / throw mechanic**
- A collecting character holding a coin that is more than `COIN_THROW_MIN_DIST` (attack range + 50 px = 350 px) from its own tower will throw the coin toward the tower instead of carrying it all the way back.
- Wind-up: character stands still for `coinThrowHoldSec` (0.5 s) before releasing.
- Throw arc: 60° diagonal — `coinThrowVx = 300 px/s`, `coinThrowVy = 446 px/s` (≈ vx × √3), both independently tunable in `gameConfig.ts → economy`.
- After throwing, the character scans within `coinThrowScanRange` (80 px) for a new coin to chase immediately.
- General coin selection now prioritises coins closest to the character's own tower (`coinClosestToTower`) so chains are efficient.

**Tower boundary walls**
- Two invisible static bodies (`CAT_WALL`) placed just outside each tower prevent coins from bouncing behind the towers.
- Character X is clamped in code (`update()`) to the same bounds because character bodies only participate in Matter.js ground collision.

### Bug fixes

**Platform jump suppression**
- Random liveness jumps (`tickRandomJump`) and evasive jumps in `updateCollecting` are now suppressed while `isOnPlatform` is true, preventing characters from immediately leaping off the elevated platform after landing.

**Platform coin pickup (body fall-through + bouncing coin freeze)**

Root cause: character bodies have `mask: CAT_GROUND` (no `CAT_PLATFORM` collision). After the manual landing snap in `syncFromBody`, gravity pulled the body through the platform to the ground over ~35 frames. `char.y` followed the body (read from `body.position.y + halfH`), so the character appeared at ground level while `floorY` stayed stale at `platform.y`. This stale state blocked the jump block (`!charOnPlatform` was false) and caused the character to oscillate at ground level trying to reach `coin.x` horizontally.

Two-layer fix:
1. **`syncToBody` body pinning** — when `!isAirborne && floorY < GROUND_Y`, body Y is locked to `floorY - halfH` and `velocity.y` zeroed each tick. The body never drifts; `char.y` stays at platform height.
2. **`sameSurface` / `coinReachable` relaxation** — when both character and coin are confirmed on the platform (`charOnPlatform && coinOnPlatform`), pickup is allowed even if the coin's `floorY` is still the initial `GROUND_Y` default (i.e. the coin is still bouncing and hasn't settled yet). This eliminates the `Math.sign(0) = 0` freeze that occurred when the character reached `coin.x` but couldn't trigger pickup.

### Configuration changes (`gameConfig.ts`)

| Key | Location | Value | Notes |
|---|---|---|---|
| `GAME_DURATION_S` | top-level constant | 300 s | Lifted from inline literal |
| `towers.attackRange` | `towers` | 300 px | Was 200 px |
| `towers.attackPower` | `towers` | 40 | — |
| `characters.coinThrowScanRange` | `characters` | 80 px | Post-throw coin scan radius |
| `characters.coinThrowHoldSec` | `characters` | 0.5 s | Wind-up before throw |
| `economy.coinThrowVx` | `economy` | 300 px/s | Horizontal throw speed |
| `economy.coinThrowVy` | `economy` | 446 px/s | Vertical throw speed (60°) |
| `platform.width` | `platform` | 360 px | Doubled from 180 px |

---

## [23805b2] 2026-04-26 — Integrate Matter.js physics engine

Replaced the hand-rolled gravity and bounce simulation with Matter.js v0.19.

### Architecture

**Hybrid kinematic model**
- Characters: AI teleports X each tick; Matter.js owns Y (gravity + ground landing). Landing on the platform is detected manually in `syncFromBody` to avoid one-way tunneling issues.
- Coins: fully simulated in both axes with `restitution`, `friction`, and `frictionAir`.

**Physics setup (`Physics.ts`)**
- `Engine.create({ gravity: { y: CHAR_GRAVITY / 1000, scale: 0.001 } })` — converts px/s² config value to Matter's internal scale.
- `Engine.update(engine, dt * 1000)` — called once per game tick; velocities stored as px/frame.
- Static bodies: ground, platform (one-way via `collisionFilter`), and `updatePlatformPassthrough` helper for coins rising through the platform.
- Collision categories: `CAT_GROUND`, `CAT_PLATFORM`, `CAT_CHARACTER`, `CAT_COIN`.

**Coin body**
- `friction: COIN_FRICTION (0.4)`, `frictionAir: COIN_FRICTION_AIR (0.012)`, `restitution: COIN_BOUNCE_DAMPING (0.55)`.
- Combined surface friction = `sqrt(coinFriction × surfaceFriction)` — ground/platform must keep `surfaceFriction > 0` or horizontal velocity never dissipates.

**Settle condition**
- `speed < 0.05 px/frame` AND coin centre within 35 px of a surface → `isOnGround = true`, body set static.

---

## [7eaf26c] 2026-04-26 — Initial commit

Full game foundation built with PixiJS v7 + Vite + TypeScript (strict).

### Systems

**Rendering**
- Imperative `PIXI.Graphics` API; no sprites or textures.
- Scrollable world (2246 px wide) with viewport camera tracking the action.
- `Background.ts`: parallax hill layers, stars, ground strip.

**Unit types** (6 total)

| Type | Role | HP | Speed | Cost |
|---|---|---|---|---|
| Warrior | Melee | 100 | 100 | 25 |
| Archer | Ranged (arrow) | 60 | 70 | 50 |
| Rifleman | Ranged (bullet, fast) | 75 | 78 | 70 |
| Sniper | Ranged (bullet, slow/long) | 50 | 50 | 100 |
| Medic | Support / heal | 50 | 45 | 60 |
| Heavy | Melee (slow, tanky) | 160 | 25 | 80 |

**Behaviours**
- `attacking` — march toward enemies, fight in range, attack enemy tower.
- `collecting` — target coins, carry to own tower, deposit for gold.
- `harass` — advance to safe X (enemy tower range + buffer), hold and fire.

**Coin economy**
- Passive income + gold/silver sky drops on independent timers.
- Coin carry speed penalty, deposit distance check, drop-on-hit with 2 s recovery cooldown.
- Low-balance income multiplier (3×) when balance < 25.

**CPU AI**
- Spawn interval scales with unit pressure (outnumbered → fast spawn, comfortable → slow spawn).
- `tickCpuCollectAI()`: assigns nearest marching unit to coins each tick.

**Promotion system**
- AP per kill and per deposit → rank thresholds [5, 15, 30] → Corporal / Sergeant / Captain.
- Each rank: +20% max HP, +10% speed, +15% attack power.

**Projectiles**
- Arc trajectories with configurable speed, min-time, arc factor, and splash radius.
- Two kinds: arrow (archer + tower), bullet (rifleman / sniper).

**Platform**
- Single centred elevated platform (one-way: characters jump through from below).
- Characters pathfind onto it: walk to platform X range, then jump.

**UI**
- Floating damage labels with rise animation.
- `CharacterHUD`: HP cards for player units showing type, rank, HP bar.
- Spawn buttons with coin costs; timer countdown.
