# COIN — Architecture reference for Claude Code

Tower-defense game: PixiJS v7 + Vite + TypeScript (strict).

## Tech stack
- **Renderer**: `pixi.js` v7 — imperative `Graphics` API for most characters; `PIXI.AnimatedSprite` for character types that have sprite sheets defined in `SpriteRegistry.ts`
- **Build**: Vite; `npm run dev` to start, `npm run build` to bundle. Multi-page: `index.html` (game) + `map-builder.html` (editor)
- **Types**: `tsconfig.json` with `strict`, `noUnusedLocals`, `noUnusedParameters` — zero warnings is the bar

## Config pattern
All tunable numbers live in **`src/gameConfig.ts`** (`GameConfig` object, `as const`).  
**`src/constants.ts`** re-exports them as flat named constants (`GROUND_Y`, `COIN_VALUE`, …).  
Source files import only from `constants.ts`, never directly from `gameConfig.ts`.

> To add a tunable: add it to the right section in `gameConfig.ts`, re-export from `constants.ts`, then use the constant.

## File map

| File | Responsibility |
|---|---|
| `src/main.ts` | DOM wiring, button handlers, Game lifecycle |
| `src/Game.ts` | Tick loop, spawn, coin drops, power-up drops, projectile fire, culling |
| `src/Character.ts` | Per-character state machine, physics, behavior |
| `src/CharacterHUD.ts` | Player-side HP card panel |
| `src/Coin.ts` | Coin physics, lifetime, pickup flag |
| `src/PowerUp.ts` | Power-up physics, visual, pickup, effects |
| `src/Projectile.ts` | Arc projectile movement and splash damage |
| `src/Grenade.ts` | Grenade arc, fuse, explosion splash |
| `src/Tower.ts` | HP, auto-fire, frontX geometry |
| `src/Platform.ts` | One-way elevated surface; exposes `PlatformData` shape |
| `src/Block.ts` | Solid-from-all-sides environment element; exposes `BlockData` |
| `src/Background.ts` | Pure visual scene dressing |
| `src/Sheep.ts` | Sheep NPC — wanders, bounces off walls, blocks characters |
| `src/DamageLabel.ts` | Floating damage numbers |
| `src/Physics.ts` | Matter.js world setup, collision categories, body factories |
| `src/Pathfinding.ts` | NavGraph: A* path planning across ground, platforms, and blocks |
| `src/Diagnostics.ts` | Runtime diagnostic logger: anomaly detection, snapshots, markdown reports |
| `src/CollisionBox.ts` | Debug overlay: renders physics body outlines |
| `src/maps.ts` | `MapDefinition` type; `DEFAULT_MAP`, `HIGHLANDS_MAP`; `ALL_MAPS` list |
| `src/map-builder.ts` | Canvas2D drag-and-drop map editor logic |
| `src/gameConfig.ts` | Single source of truth for all numbers |
| `src/constants.ts` | Flat re-exports of gameConfig values |
| `src/names.ts` | `pickName()` — random character display names |
| `src/SpriteRegistry.ts` | Sprite sheet definitions, async preloader, per-type frame cache |
| `public/sprites/<type>/` | Sprite sheet PNGs; presence is optional — missing files fall back to Graphics |
| `map-builder.html` | Map builder entry point (served at `/map-builder.html`) |

## Sprite animation system

Characters use `PIXI.AnimatedSprite` when a sprite sheet is available for their type; otherwise they render with the existing `PIXI.Graphics` approach. The two paths are transparent to all callers — the same `Character` class handles both.

### Adding sprites for a character type

1. Place sprite sheet PNGs in `public/sprites/<type>/` (e.g. `public/sprites/warrior/walk.png`). These are served at `/sprites/<type>/<anim>.png` by Vite.
2. Add an entry to `SPRITE_DEFS` in `src/SpriteRegistry.ts`:

```typescript
warrior: {
  idle:       { path: '/sprites/warrior/idle.png',        rows: 1, fps:  8, spriteScale: 1.5 },
  walk:       { path: '/sprites/warrior/walk.png',        rows: 2, fps: 10, spriteScale: 1.5 },
  attack:     { path: '/sprites/warrior/attack.png',      rows: 1, fps: 12, spriteScale: 1.5 },
  attackWalk: { path: '/sprites/warrior/attack_walk.png', rows: 1, fps: 12, spriteScale: 1.5 },
  carry:      { path: '/sprites/warrior/carry.png',       rows: 4, fps: 10, spriteScale: 1.5 },
},
```

Sheets are always laid out left-to-right, top-to-bottom with exactly `FRAMES_PER_ROW` (6) frames per row. Frame width is `sheet.width / 6`; frame height is `sheet.height / rows`. The actual number of frames is **auto-detected** by scanning cells for transparent content — adding or removing frames within an existing row layout requires no config change, as long as `rows` is still correct. The last row may be partially filled. Only the animations you define are loaded — missing entries fall back to the nearest substitute (e.g. `carry` falls back to `walk` then `idle`). A type with no entry at all continues to use Graphics.

### Key types and fields (`SpriteRegistry.ts`)

| Symbol | Description |
|---|---|
| `AnimationName` | `'idle' \| 'walk' \| 'attack' \| 'attackWalk' \| 'carry'` |
| `SpriteAnimDef` | `{ path, cols, rows, fps, spriteScale }` — one animation's sheet metadata |
| `LoadedSpriteSet` | `Partial<Record<AnimationName, PIXI.Texture[]>>` — extracted frames per animation |
| `preloadAllSprites()` | Called once at startup (`main.ts`) before `Game` is created; populates the module-level cache |
| `getSpriteSet(type)` | Sync lookup called per `new Character()`; returns cached frames or `null` |

### `spriteScale`

Sprite sheets typically have empty padding around the art. `spriteScale` compensates: the sprite's rendered height is `config.height × spriteScale`, so the actual character art fills roughly the same vertical space as the Graphics equivalent. Start at `1.5` and tune visually.

### Animation state machine (inside `Character`)

`tickAnimSprite()` runs each tick and:
- Sets `scale.x = animSpriteBaseScale × lastMoveDir` to flip the sprite for left-moving characters (sheets are drawn facing right).
- Calls `selectAnimation()` to pick the target `AnimationName` from the character's current `state` and `carryingCoin` flag.
- Calls `switchAnimation(name)` only when the animation actually changes — PIXI re-starts playback from frame 0 on a texture swap.

| Character state | Animation chosen |
|---|---|
| `returning` or `carryingCoin` | `carry` |
| `fighting` | `attack` |
| `marching` or `collecting` | `walk` |
| anything else | `idle` |

### Startup flow

`main.ts` does `await preloadAllSprites()` (top-level await in a `<script type="module">`) before constructing `Game`. Sprites that fail to load (404) are caught silently — the cache stores `null` and the character falls back to Graphics at construction time.

> To add a new animation state: add the name to `AnimationName`, extend the fallback table in `switchAnimation`, and add a case in `selectAnimation`.

## Map system

### MapDefinition
`src/maps.ts` defines the `MapDefinition` interface — the single source of truth for each map:

```typescript
interface MapDefinition {
  id:           string;
  name:         string;
  worldWidth:   number;
  playerTowerX: number;   // tower centre x
  enemyTowerX:  number;
  platforms:    PlatformData[];
  blocks:       BlockData[];
  coinBox:      CoinBoxDef;  // { x, y, width, height, spreadDeg }
}
```

`ALL_MAPS` is the authoritative list. `DEFAULT_MAP` reproduces the original hardcoded layout.

### Game.build()
`build()` reads `this.mapDef` (defaults to `DEFAULT_MAP`) and constructs the full scene:
1. Background + range markers + coin box visuals
2. `Platform` and `Block` visuals added to `this.world`
3. `Physics` instance created; platform and block bodies registered
4. Game layers (coin, sheep, powerup, proj, grenade, unit, label) added
5. Towers created; nav graph built; tower physics bodies registered

Call `reset(mapDef?)` to switch maps — it removes all stage children and calls `build()` fresh.

### Map builder
`map-builder.html` / `src/map-builder.ts` — a standalone Canvas2D tool for editing maps. Supports:
- Drag platforms to move; drag left/right edge to resize
- Drag tower markers and coin box
- Block preview (grey rectangles in canvas)
- JSON export (copies to clipboard) and import
- Preset loading from `ALL_MAPS`

## Environment elements

### Platform (`src/Platform.ts`)
One-way elevated surface — characters can jump up through from below, land on top.  
`PlatformData`: `{ x, y, width, height }` where `y` is the **top surface** (character feet position).  
Physics: `CAT_PLATFORM` body with one-way passthrough via `updatePlatformPassthrough()`.  
Character landing is detected **manually** in `syncFromBody` (tunneling-safe crossing check), not via Matter.js collision events.

### Block (`src/Block.ts`)
Solid-from-all-sides environment element — nothing passes through any face.  
`BlockData = PlatformData` (same shape). Visual: stone-brick with staggered mortar lines.  
Physics: `CAT_BLOCK = 0x0100` static body; included in collision masks for characters, coins, power-ups, and sheep.  
Character landing on blocks is also detected manually in `syncFromBody`, same tunneling-safe pattern as platforms.  
Blocks are registered with `NavGraph.build()` as walkable surfaces alongside platforms.

> To add a new environment element: add a category bit in `Physics.ts`, create a visual class, add a `createXBody()` factory, add the field to `MapDefinition` in `maps.ts`, wire into `Game.build()` (visual + body), update `Character.syncFromBody`, update `NavGraph.build`.

## Character system

### Unit types
Eight types: `warrior`, `archer`, `rifleman`, `sniper`, `medic`, `heavy`, `tanker`, `grenadier`.  
Each has its own `build*Sprite()` method in `Character.ts`. The dispatch is in `buildSprite()`.  
- Melee: `warrior`, `heavy` — deal damage via `takeDamage()` on contact
- Ranged: `archer` (arrow), `rifleman` (bullet, fast fire), `sniper` (bullet, long range, slow fire), `tanker` (bullet, slow, high damage)
- Explosive: `grenadier` (grenade arc, splash damage, fuse delay)
- Support: `medic` (no attack; heals nearby allies; player-only)
- `heavy`, `tanker`, and `grenadier` have custom `width`/`height` overrides in `gameConfig.ts`

### Behavior vs State
- **`behavior`** (`'attacking' | 'collecting' | 'harass' | 'defend'`) — the character's strategic intent; player-controlled or set by CPU AI
- **`state`** (`'marching' | 'fighting' | 'collecting' | 'returning' | 'dead'`) — what the character is doing this frame; set inside `update()`

Setting `behavior` via the setter handles side effects automatically:
- Switching away from `'collecting'` while carrying a coin triggers `dropCarriedCoin()`
- `dropCarriedCoin()` sets `pendingCoinDrop` and starts the `coinPickupCooldown` blink

**Harass behavior**: advance toward enemies but stop at `safeX` (enemy tower range + `HARASS_SAFETY_BUFFER`). When no enemies are visible: group near the nearest ally (within 55 px), or rally 80 px in front of own tower if alone.

**Defend behavior**: patrol within own tower's attack range, engaging any enemy that enters range. Ranged units kite away from closing melee.

### isRanged / isMeleeType helpers
- `private get isRanged()` — true for `archer`, `rifleman`, `sniper`. Use this instead of inline type checks.
- `private static isMeleeType(type)` — true for `warrior`, `heavy`. Used in kiting logic to classify an enemy's type.

### UpdateContext
`Character.update(ctx: UpdateContext)` receives everything it needs per-tick. No direct references to `Game.ts` internals.

Key fields:
- `platforms: PlatformData[]` — for landing detection and coin settle checks
- `blocks: BlockData[]` — for block landing detection and edge walk-off
- `worldWidth: number` — used to compute movement bounds
- `homeTowerFrontX / enemyTowerFrontX` — tower face positions

Callbacks:
- `onFire(req)` — character requests a projectile be spawned
- `onDamageTower(dmg)` — warrior melee hit on tower
- `onDepositCoin(value)` — coin deposited at home tower; Game.ts credits the balance

### Pending-events pattern
Characters cannot directly mutate game state. Instead they write to:
- `pendingDamages[]` — `{ amount, x, y }` records; Game.ts reads, clears, and spawns `DamageLabel`s
- `pendingCoinDrop` — `{ x, y, value, kind } | null`; Game.ts spawns the `Coin` and calls `recoverCoin()` on the dropping character

This lets events from characters that die mid-tick still be processed.

### Character IDs
`Game.ts` maintains a free-list: `nextCharId` counter + `freeCharIds: number[]` (kept sorted on release).
- `allocateCharId()` — takes the lowest free id, or increments counter
- `releaseCharId(id)` — inserts in sorted position so `shift()` always gives the lowest
IDs appear on the sprite label (`#N`) and in `CharacterHUD` cards.

### Movement direction tracking
`private lastMoveDir: 1 | -1` is updated in `update()` by comparing `this.x` before and after the behavior call. Use `lastMoveDir` (not `side === 'player' ? 1 : -1`) whenever you need the character's actual travel direction — a collecting character returning home moves in the opposite side-direction.

### Jump system
`jump(dirX, dt)` sets `isAirborne = true`, `jumpVx = dirX * moveSpeed`, and gives the Matter.js body an upward impulse. While airborne, `syncToBody` adds `jumpVx * dt` to `this.x` each tick; `jumpVx` is zeroed on landing.

Two jump timers:
- `randomJumpTimer` — fires a 20% chance liveness jump every 1.5–3.5 s (skipped when fighting or close to home)
- `evasiveJumpTimer` — 2 s cooldown; 80% chance to jump over a blocking enemy while collecting

Both are decremented in `update()` alongside `attackTimer`.

### Power-up effects on Character
Three fields track active power-up effects:
- `powerUpSpeedMult` / `powerUpSpeedTimer` — speed multiplier and remaining duration; timer decremented each tick, mult reset to 1.0 at expiry
- `powerUpAtkMult` — permanent-until-death attack multiplier

`applyPowerUp(type)` is the public entry point called from `Game.ts` on pickup. Values come from `POWERUP_SPEED_MULT`, `POWERUP_SPEED_DUR_S`, `POWERUP_ATK_MULT` in constants.

### Promotion system
Characters earn AP: `PROMO_KILL_AP` per kill, `PROMO_COIN_AP` per deposit.  
Thresholds `[5, 15, 30]` → ranks Private → Corporal → Sergeant → Captain.  
Each rank above Private: +20% max HP (restored on promotion), +10% speed, +15% attack power.  
`earnAP()` is private; called by `takeDamage` (killer) and the deposit branch in `updateCollecting`.

### Fire angle restriction
`private snapFireAngle()` forces ranged shots to **horizontal only** — bullets and arrows fly along the shooter's `bowY` without arcing. Applied in both `attackEnemy()` and `attackTower()` before calling `onFire`.

Pairs with `canSnapHit(target)` which (for snap-firing types only) rejects targets whose collision box doesn't span the shooter's `bowY` line — i.e. targets on a different elevation are unreachable until the shooter matches their plane. AI handles plane-matching naturally:
- **Harass** pursues at the enemy's `floorY` (`requestPath(closest.x, closest.floorY, ...)`) and has a dedicated "climb up to enemy on platform" branch.
- **Collect** paths to the coin's floor.
- **Attack/Rush/Defend** stay focused on their primary goal (tower advance, defence patrol); elevated enemies they can't shoot are simply ignored.

Grenadier, rocketeer, warrior, heavy, and conscript bypass both the snap and the `canSnapHit` filter (melee or ballistic — they aim freely).

## Coin system

### CoinKind
`'gold'` (value 30) | `'silver'` (value 15). Both defined in `gameConfig.ts` → `constants.ts`.

### COIN_PALETTE
Exported from `Coin.ts` as `Record<CoinKind, readonly [outer, mid, inner, highlight]>`.  
Shared by `Coin.drawCoin()` and `Character.showCoinCarry()` — single color definition for both visuals.

### Coin drop
`Game.ts` has two independent timers (gold / silver). Both call `spawnCoin(value, kind)`.  
Sky-dropped coins spawn at `COIN_DROP_START_Y` (near top of canvas) with no initial velocity.  
Dropped-by-character coins are spawned from `pendingCoinDrop` with a random horizontal bounce velocity.

### Pickup / carry / deposit flow
1. Character reaches coin → `coin.pickup()` (sets `isPickedUp`, hides container, removes physics body)
2. Character stores `coinCarryValue` + `coinCarryKind`, calls `showCoinCarry()` (uses `COIN_PALETTE`)
3. Character walks home → within `CHAR_DEPOSIT_DIST` → `onDepositCoin(value)` → Game credits balance
4. If hit while carrying: `dropCarriedCoin()` → `pendingCoinDrop` → new `Coin` spawned → `recoverCoin(coin)` so character chases it; 2s blink cooldown prevents immediate re-pickup

### Coin claiming
`updateCollecting` builds a `claimed` Set of coins already targeted by other allies (`claimedCoin` getter).  
Each collector picks from the unclaimed pool first; falls back to the full pool only when all coins are claimed.  
This prevents multiple allies from converging on the same coin.

### Coin settle condition
`Coin.update()` sets `isOnGround = true` when `speed < 0.05` (px/frame) AND the coin is near a surface (`y >= GROUND_Y - 35` or within a platform's bounds). A freshly dropped coin can take ~10 bounces to reach this threshold — during which `isOnGround` remains false.

**Pickup reachability**: `updateCollecting` uses `coinReachable = isOnGround || y >= GROUND_Y - 30` so characters can pick up late-stage bouncing coins without freezing. Do not remove the `y >= GROUND_Y - 30` fallback — it prevents a deadlock where `Math.sign(coin.x − char.x) = 0` produces zero movement and `isOnGround` is still false.

## Power-up system

Power-ups drop from the sky every `POWERUP_DROP_INTERVAL` seconds (default 40 s). Three types:
- `'heal'` — restores character HP to full
- `'speed'` — multiplies move speed by `POWERUP_SPEED_MULT` for `POWERUP_SPEED_DUR_S` seconds
- `'attack'` — multiplies attack power by `POWERUP_ATK_MULT` permanently

### Drop indicator
`POWERUP_INDICATOR_LEAD` seconds before each drop, a floating indicator appears at the top of the world and drifts randomly left/right. Its final X position determines where the power-up spawns. The indicator lives in `this.world` (world space, scrolls with camera).

### PowerUp physics
`PowerUp.ts` uses a Matter.js circle body (`CAT_POWERUP`, radius `POWERUP_BODY_RADIUS`). The body collides with ground, platform, walls, towers, and blocks. Once settled (speed < 0.05 near a surface), the body is set static and the visual bobs vertically. `updatePlatformPassthrough()` is called each tick for non-settled power-ups — same one-way platform mechanism used by coins.

All tunable values live in `gameConfig.powerUp` → exported from `constants.ts` as `POWERUP_*` constants.

## Physics

### Hybrid model
Character X is teleported each tick by AI logic; Y is fully simulated by Matter.js (gravity + ground collision). Coins and power-ups are fully simulated in both axes.

### Matter.js setup (Physics.ts)
- `gravity: { y: CHAR_GRAVITY / 1000, scale: 0.001 }` — converts px/s² to Matter's internal units
- `Engine.update(engine, dt * 1000)` — called once per game tick; velocities are in **px/frame** (not px/s)
- Coin body: `friction: COIN_FRICTION, frictionAir: COIN_FRICTION_AIR, restitution: COIN_BOUNCE_DAMPING`
- Power-up body: `friction: 0.05, frictionAir: 0.004, restitution: 0.5`
- Ground/platform/block bodies: `friction: SURFACE_FRICTION, restitution: 0`

### Collision categories (Physics.ts)
| Constant | Value | Collides with |
|---|---|---|
| `CAT_GROUND` | 0x0001 | characters, coins, power-ups, sheep |
| `CAT_PLATFORM` | 0x0002 | characters (one-way), coins, power-ups, sheep |
| `CAT_CHARACTER` | 0x0004 | ground, towers, blocks |
| `CAT_COIN` | 0x0008 | ground, platforms, walls, towers, blocks |
| `CAT_WALL` | 0x0010 | coins, power-ups, sheep |
| `CAT_TOWER` | 0x0020 | characters, coins, power-ups, sheep |
| `CAT_POWERUP` | 0x0040 | ground, platforms, walls, towers, blocks |
| `CAT_SHEEP` | 0x0080 | ground, platforms, walls, towers, blocks |
| `CAT_BLOCK` | 0x0100 | characters, coins, power-ups, sheep |

### Combined friction formula
Matter.js combines friction as `sqrt(bodyA.friction × bodyB.friction)`. If either surface has `friction: 0`, combined friction = 0 and coins **never decelerate horizontally**. Ground, platform, and block bodies must have `friction > 0` (currently `SURFACE_FRICTION = 0.8`). Character bodies keep `friction: 0` — they teleport X, so surface friction would only cause unintended drag.

### Platform and block landing (characters)
Characters do NOT use Matter.js collision for platform or block landing — it is handled manually in `syncFromBody(platforms, blocks)` to avoid one-way tunneling issues.

The check is tunneling-safe: it compares `prevFeetY` (position before the physics step) against the surface top Y. If the feet crossed the surface while falling (`velocity.y >= 0`), the character is snapped to the surface.

- **Platforms**: passthrough from below is allowed; landing only on the way down. Bodies use `CAT_PLATFORM` and `updatePlatformPassthrough()` manages the one-way mask each tick.
- **Blocks**: solid from all sides via `CAT_BLOCK` physics body. Landing detection in `syncFromBody` is identical to platforms. Edge walk-off is also detected for both: if `this.x` is no longer within any platform or block's x-span while `floorY < GROUND_Y`, `isAirborne` is set to `true`.

### updatePlatformPassthrough
Called each tick for every live, non-settled coin, power-up, and sheep body **before** `physics.step()`. Disables platform collision while the body is **rising** through a platform surface, re-enables it once falling. Preserves non-ground/platform mask bits (walls, towers, blocks) using:
```typescript
const extraBits = (body.collisionFilter.mask ?? 0) & ~(CAT_GROUND | CAT_PLATFORM);
const mask = baseMask | extraBits;
```
Without this, the mask would be rebuilt from scratch each tick, silently stripping wall, tower, and block collision.

### Platform coordinate convention
`p.y` is the **top surface** of the platform or block. Character feet land at `p.y`. Coins rest at `p.y - 14` (coin centre offset). When checking whether a coin is on a platform: `coin.y <= p.y + 5` (body may be slightly below surface at contact).

Diagonal jumps: `Character.jump(dirX)` sets both `vy = -JUMP_VELOCITY` and `jumpVx = dirX * moveSpeed`; `jumpVx` is applied to `x` each tick while airborne, zeroed on landing.

## Pathfinding

`NavGraph` in `src/Pathfinding.ts` builds an A* surface graph from the current map and is queried each tick by characters that need multi-step paths.

### Split-surface approach

When `NavGraph.build()` is called, each walkable surface (ground and platforms) is **split into subsegments** at every solid block that straddles that surface's plane:

```typescript
const splitSurface = (sx, sy, sw) => {
  const blockers = blocks
    .filter(b => b.y < sy && b.y + b.height >= sy && b.x < sx+sw && b.x+b.width > sx)
    .map(b => ({ left: Math.max(b.x, sx), right: Math.min(b.x+b.width, sx+sw) }))
    .sort((a, b) => a.left - b.left);
  // emits subsegments for the gaps between blockers
};
```

A character on the left subsegment and a character on the right subsegment of the same surface Y have **different surface IDs** — A* must therefore route a jump over the block to connect them. This replaces the old `findBlockerInPath()` workaround, which has been removed.

Block tops are also added as `solid: true` surfaces so characters can be routed up onto them.

### surfaceAt(floorY, x?)

`surfaceAt` accepts an optional `x` to pick the correct subsegment when multiple subsegments share the same Y (the common case once a block splits the ground):

```typescript
surfaceAt(floorY: number, x?: number): NavSurface | null
```

- If `x` is provided and falls within a subsegment's span, that subsegment is returned.
- Falls back to any same-Y surface if no span matches (graceful degradation).
- `findPath` always passes both `fromX` and `toX` to `surfaceAt`.

### PathStep / followPath

`findPath(fromX, fromFloorY, toX, toFloorY)` returns `PathStep[]` — a minimal walk/jump/fall sequence. `Character.followPath(dt)` executes the current step and advances `pathIdx` when done.

Walk steps include a stale-surface guard: if the character's `floorY` differs from the step's `floorY` by more than 20 px (e.g. the character already fell off the block), the step is skipped rather than walked backward.

### Diagnostics

`src/Diagnostics.ts` is a standalone diagnostic logger. Toggle with the **Diagnose** button in the UI; download the report with **Report**.

Three anomaly types (debounced at 2s per character):
- **Walking in air** — `isAirborne` is false, `floorY < GROUND_Y`, but no platform/block spans that x and y.
- **Stuck** — character has an active path but x hasn't moved > 4 px for 2s.
- **Path thrash** — path rebuilt ≥ 8 times in a 1-second window.

`CharSnapshot` is recorded every 1.5s per live character. `produceMarkdown()` produces a full markdown report with anomaly, event, and snapshot tables.

`Character` exposes a `diagnosticInfo` getter with fields: `isAirborne`, `floorY`, `pathLen`, `pathStep`, `pathRemaining`, `lastBuiltPath`, `clampedCount`, `pathRebuildCount`.

## CPU AI

`tickCpuCollectAI()` runs each tick before character updates:
- If coins exist and no CPU unit is collecting: assign the marching unit closest to a coin
- If no coins exist: return non-carrying collectors to attacking

`tickCpuBehaviorAI()` sets behavior based on current stance:
- Defend stance: melee → `'defend'`, ranged → `'harass'`
- Aggressive stance: all attacking units use `'attacking'`

Spawn interval scales with pressure (`playerCount - cpuCount`):
- Outnumbered (`≥ CPU_PRESSURE_THRESHOLD`): fast spawn
- Comfortable (`≤ -CPU_PRESSURE_THRESHOLD`): slow spawn
- Neutral: middle range

Unit selection prioritises cheap warriors when outnumbered or broke; riflemen when comfortable and well-funded. CPU does not spawn medics.

### CHAR_CONFIGS
`Game.ts` exports a module-level `CHAR_CONFIGS` object mapping unit type strings to their config objects. Use this instead of inline `{ warrior: WARRIOR, ... }` maps wherever a config lookup by type string is needed.

## Medic

`type: 'medic'` — support unit with no attack ability.

- Each tick, `tickHeal(dt, allChars)` scans living friendlies within `CHAR_HEAL_RANGE` (55 px) and heals the most-injured one by `CHAR_HEAL_RATE * dt` (8 HP/s).
- `tickHeal` is called from `update()` before the behavior branch, so healing happens regardless of `behavior`.
- In `updateAttacking`, the medic marches toward the enemy but stops 100 px short of the enemy tower (no melee/ranged attack).
- `heal(amount)` is a public method on `Character` that clamps HP to `maxHp` and redraws the bar.

## Common pitfalls

- **`as const` literal types**: `GameConfig` fields become literal types (e.g. `500` not `number`). When assigning to a mutable `hp: number` field, annotate the field type explicitly.
- **`replace_all` on import lines**: targeted edits for imports; `replace_all` for usage sites. Mixing them produces double-prefixed names.
- **`noUnusedParameters`**: prefix intentionally-unused params with `_` (e.g. `_dt`). Remove the param entirely if nothing uses it.
- **`Math.sign(0) = 0` freeze**: whenever a character moves toward a target using `this.x += Math.sign(target.x - this.x) * speed * dt`, if they share the same x the character produces no movement. Ensure the action that was supposed to trigger at that position (pickup, deposit, jump) fires first or add an explicit distance guard.
- **Coin `isOnGround` lag**: coins can be at ground level but still bouncing for many frames before `isOnGround` becomes true. Never gate character pickup solely on `isOnGround` — pair it with a y-position fallback (`coin.y >= GROUND_Y - 30`).
- **Combined friction zero**: if ground, platform, or block body has `friction: 0`, coin horizontal velocity never dissipates (`sqrt(0 × x) = 0`). Keep `SURFACE_FRICTION > 0` on all static surface bodies; character bodies must stay at `friction: 0` so AI teleportation is unaffected.
- **`lastMoveDir` vs side direction**: use `lastMoveDir` when you need the character's actual travel direction. `side === 'player' ? 1 : -1` is wrong for collecting characters returning home.
- **`updatePlatformPassthrough` mask corruption**: this function rebuilds the collision mask each tick. It must preserve non-ground/platform bits using the `extraBits` pattern above. Do not simplify it to `baseMask` alone — this silently strips wall, tower, and block collision from coins and power-ups.
- **Coin body removal on pickup**: `coin.pickup()` removes the physics body immediately. This prevents the invisible carried-coin body from colliding with the tower during carry. Use the `bodyInWorld` flag pattern (idempotent guard) in any class that wraps a Matter.js body.
- **Adding a new unit type**: update `CharacterConfig.type` union, `buildSprite()` dispatch + new `build*Sprite()` method, `this.isRanged` getter + `Character.isMeleeType()` if needed, `CHAR_CONFIGS` in `Game.ts`, `CharacterHUD.ts` `TYPE_ICON`/`TYPE_COLOR`, `main.ts` button/cost/handler, `index.html` button + CSS, `constants.ts` export + `CHAR_COST`.
- **Adding a new environment element**: add a category bit in `Physics.ts`, create a visual class, add a `createXBody()` factory, add the field to `MapDefinition` in `maps.ts`, wire into `Game.build()` (visual + body), update `Character.syncFromBody`, update `NavGraph.build`.
- **Per-frame precomputation pattern**: constants derived from `dt` (e.g. `Math.exp(-decay * dt)`) are identical for every character in the same tick. Compute them once in `Game.tick()` and pass to the relevant method rather than recomputing inside each character's update. Current example: `knockbackDecayFactor` precomputed in the grenade explosion loop and stored via `applyKnockback`.
- **Grenade knockback abstraction**: `Character` has no direct knowledge of grenade constants. `Game.ts` computes `knockbackDecayFactor = Math.exp(-GRENADE_KNOCKBACK_DECAY * dt)` and passes it into `applyKnockback(vx, vy, dt, decayFactor)`. Adding a new knockback source follows the same pattern.
- **`requestPath` floor level**: always pass the character's actual `this.floorY` (not a hardcoded `GROUND_Y`) as the destination floor when the behavior should keep the character at its current elevation (harass, defend, rally). Only pass a specific surface Y when navigating to a different surface is intentional (e.g. chasing a coin on a platform).
- **`surfaceAt` x parameter**: since `NavGraph.build()` splits each surface into subsegments at block intersections, multiple subsegments can share the same `floorY`. Always pass `x` to `surfaceAt` so the correct subsegment is selected. Omitting `x` returns an arbitrary same-Y surface, which causes A* to route from the wrong starting node and may produce a path that walks backward into a block.
- **Sprite `spriteScale` tuning**: the rendered sprite height is `config.height × spriteScale`. If the sheet has heavy padding the character will appear smaller than its physics body — increase `spriteScale` until the art matches. Conversely, a value too large pushes the sprite well above the character's feet.
- **Sprite facing direction**: sheets must be drawn facing **right**. `tickAnimSprite` flips `scale.x` using `lastMoveDir`; the absolute scale is stored in `animSpriteBaseScale` and must not be written directly on `animSprite.scale.x` or the flip sign is lost on the next tick.
- **`switchAnimation` re-starts playback**: assigning new textures to an `AnimatedSprite` via `.textures = frames` resets the frame index to 0. Only call `switchAnimation` when the target animation name actually changes (guarded by `currentAnimName`), otherwise the sprite stutters back to frame 0 every tick.
- **New melee unit types**: add the type to both the `warrior || heavy` branch in `attackEnemy` and the early-return guard in `canSnapHit`. Omitting either causes the unit to silently skip attacks or mis-evaluate shot feasibility.
