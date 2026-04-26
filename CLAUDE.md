# COIN — Architecture reference for Claude Code

Tower-defense game: PixiJS v7 + Vite + TypeScript (strict).

## Tech stack
- **Renderer**: `pixi.js` v7 — imperative `Graphics` API, no sprites/textures
- **Build**: Vite; `npm run dev` to start, `npm run build` to bundle
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
| `src/Game.ts` | Tick loop, spawn, coin drops, projectile fire, culling |
| `src/Character.ts` | Per-character state machine, physics, behavior |
| `src/CharacterHUD.ts` | Player-side HP card panel |
| `src/Coin.ts` | Coin physics, lifetime, pickup flag |
| `src/Projectile.ts` | Arc projectile movement and splash damage |
| `src/Tower.ts` | HP, auto-fire, frontX geometry |
| `src/Platform.ts` | Single platform; exposes `PlatformData` shape |
| `src/Background.ts` | Pure visual scene dressing |
| `src/DamageLabel.ts` | Floating damage numbers |
| `src/gameConfig.ts` | Single source of truth for all numbers |
| `src/constants.ts` | Flat re-exports of gameConfig values |

## Character system

### Unit types
Six types: `warrior`, `archer`, `rifleman`, `sniper`, `medic`, `heavy`.  
Each has its own `build*Sprite()` method in `Character.ts`. The dispatch is in `buildSprite()`.  
- Melee: `warrior`, `heavy` — deal damage via `takeDamage()` on contact
- Ranged: `archer` (arrow), `rifleman` (bullet, fast fire), `sniper` (bullet, long range, slow fire)
- Support: `medic` (no attack; heals nearby allies; player-only)
- `heavy` has a custom `width`/`height` override in `gameConfig.ts` (28 × 44 vs default 20 × 32)

### Behavior vs State
- **`behavior`** (`'attacking' | 'collecting' | 'harass'`) — the character's strategic intent; player-controlled or set by CPU AI
- **`state`** (`'marching' | 'fighting' | 'collecting' | 'returning' | 'dead'`) — what the character is doing this frame; set inside `update()`

Setting `behavior` via the setter handles side effects automatically:
- Switching away from `'collecting'` while carrying a coin triggers `dropCarriedCoin()`
- `dropCarriedCoin()` sets `pendingCoinDrop` and starts the `coinPickupCooldown` blink

**Harass behavior**: advance toward enemies but stop at `safeX` (enemy tower range + `HARASS_SAFETY_BUFFER`). When no enemies are visible: group near the nearest ally (within 55 px), or rally 80 px in front of own tower if alone.

### UpdateContext
`Character.update(ctx: UpdateContext)` receives everything it needs per-tick. No direct references to `Game.ts` internals. Callbacks:
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

### Promotion system
Characters earn AP: `PROMO_KILL_AP` per kill, `PROMO_COIN_AP` per deposit.  
Thresholds `[5, 15, 30]` → ranks Private → Corporal → Sergeant → Captain.  
Each rank above Private: +20% max HP (restored on promotion), +10% speed, +15% attack power.  
`earnAP()` is private; called by `takeDamage` (killer) and the deposit branch in `updateCollecting`.

## Coin system

### CoinKind
`'gold'` (value 20) | `'silver'` (value 8). Both defined in `gameConfig.ts` → `constants.ts`.

### COIN_PALETTE
Exported from `Coin.ts` as `Record<CoinKind, readonly [outer, mid, inner, highlight]>`.  
Shared by `Coin.drawCoin()` and `Character.showCoinCarry()` — single color definition for both visuals.

### Coin drop
`Game.ts` has two independent timers (gold / silver). Both call `spawnCoin(value, kind)`.  
Sky-dropped coins spawn at `COIN_DROP_START_Y` (near top of canvas) with no initial velocity.  
Dropped-by-character coins are spawned from `pendingCoinDrop` with a random horizontal bounce velocity.

### Pickup / carry / deposit flow
1. Character reaches coin → `coin.pickup()` (sets `isPickedUp`, hides container)
2. Character stores `coinCarryValue` + `coinCarryKind`, calls `showCoinCarry()` (uses `COIN_PALETTE`)
3. Character walks home → within `CHAR_DEPOSIT_DIST` → `onDepositCoin(value)` → Game credits balance
4. If hit while carrying: `dropCarriedCoin()` → `pendingCoinDrop` → new `Coin` spawned → `recoverCoin(coin)` so character chases it; 2s blink cooldown prevents immediate re-pickup

### Coin settle condition
`Coin.update()` sets `isOnGround = true` when `speed < 0.05` (px/frame) AND the coin is near a surface (`y >= GROUND_Y - 35` or within a platform's bounds). A freshly dropped coin can take ~10 bounces to reach this threshold — during which `isOnGround` remains false.

**Pickup reachability**: `updateCollecting` uses `coinReachable = isOnGround || y >= GROUND_Y - 30` so characters can pick up late-stage bouncing coins without freezing. Do not remove the `y >= GROUND_Y - 30` fallback — it prevents a deadlock where `Math.sign(coin.x − char.x) = 0` produces zero movement and `isOnGround` is still false.

## Physics

### Hybrid model
Character X is teleported each tick by AI logic; Y is fully simulated by Matter.js (gravity + ground collision). Coins are fully simulated in both axes.

### Matter.js setup (Physics.ts)
- `gravity: { y: CHAR_GRAVITY / 1000, scale: 0.001 }` — converts px/s² to Matter's internal units
- `Engine.update(engine, dt * 1000)` — called once per game tick; velocities are in **px/frame** (not px/s)
- Coin body: `friction: COIN_FRICTION, frictionAir: COIN_FRICTION_AIR, restitution: COIN_BOUNCE_DAMPING`
- Ground/platform bodies: `friction: SURFACE_FRICTION, restitution: 0`

### Combined friction formula
Matter.js combines friction as `sqrt(bodyA.friction × bodyB.friction)`. If either surface has `friction: 0`, combined friction = 0 and coins **never decelerate horizontally**. Ground and platform bodies must have `friction > 0` (currently `SURFACE_FRICTION = 0.8`). Character bodies keep `friction: 0` — they teleport X, so surface friction would only cause unintended drag.

### Platform landing (characters)
Characters do NOT use Matter.js collision for platform landing — it is handled manually in `syncFromBody` to avoid one-way tunneling issues. Platform bodies use `collisionFilter` to allow coins to bounce off them while characters pass through from below.

### Platform coordinate convention
`p.y` is the **top surface** of the platform. Character feet land at `p.y`. Coins rest at `p.y - 14` (coin centre offset). When checking whether a coin is on a platform: `coin.y <= p.y + 5` (body may be slightly below surface at contact).

Diagonal jumps: `Character.jump(dirX)` sets both `vy = -JUMP_VELOCITY` and `jumpVx = dirX * moveSpeed`; `jumpVx` is applied to `x` each tick while airborne, zeroed on landing.

## CPU AI

`tickCpuCollectAI()` runs each tick before character updates:
- If coins exist and no CPU unit is collecting: assign the marching unit closest to a coin
- If no coins exist: return non-carrying collectors to attacking

Spawn interval scales with pressure (`playerCount - cpuCount`):
- Outnumbered (`≥ CPU_PRESSURE_THRESHOLD`): fast spawn
- Comfortable (`≤ -CPU_PRESSURE_THRESHOLD`): slow spawn
- Neutral: middle range

Unit selection prioritises cheap warriors when outnumbered or broke; riflemen when comfortable and well-funded. CPU does not spawn medics.

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
- **Combined friction zero**: if ground or platform body has `friction: 0`, coin horizontal velocity never dissipates (`sqrt(0 × x) = 0`). Keep `SURFACE_FRICTION > 0` on static bodies; character bodies must stay at `friction: 0` so AI teleportation is unaffected.
- **`lastMoveDir` vs side direction**: use `lastMoveDir` when you need the character's actual travel direction. `side === 'player' ? 1 : -1` is wrong for collecting characters returning home.
- **Adding a new unit type**: update `CharacterConfig.type` union, `buildSprite()` dispatch + new `build*Sprite()` method, `isRanged` and `projectileKind` checks, `Game.ts` configs/cfgMap/typeWeight/UnitType, `CharacterHUD.ts` TYPE_ICON/TYPE_COLOR, `main.ts` button/cost/handler, `index.html` button + CSS, `constants.ts` export + `CHAR_COST`.
