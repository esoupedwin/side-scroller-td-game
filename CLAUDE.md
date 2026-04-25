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

### Behavior vs State
- **`behavior`** (`'attacking' | 'collecting'`) — the character's strategic intent; player-controlled or set by CPU AI
- **`state`** (`'marching' | 'fighting' | 'collecting' | 'returning' | 'dead'`) — what the character is doing this frame; set inside `update()`

Setting `behavior` via the setter handles side effects automatically:
- Switching away from `'collecting'` while carrying a coin triggers `dropCarriedCoin()`
- `dropCarriedCoin()` sets `pendingCoinDrop` and starts the `coinPickupCooldown` blink

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

## Coin system

### CoinKind
`'gold'` (value 20) | `'silver'` (value 8). Both defined in `gameConfig.ts` → `constants.ts`.

### COIN_PALETTE
Exported from `Coin.ts` as `Record<CoinKind, readonly [outer, mid, inner, highlight]>`.  
Shared by `Coin.drawCoin()` and `Character.showCoinCarry()` — single color definition for both visuals.

### Coin drop
`Game.ts` has two independent timers (gold / silver). Both call `spawnCoin(value, kind)`.  
Dropped-by-character coins are spawned from `pendingCoinDrop` with a random bounce velocity.

### Pickup / carry / deposit flow
1. Character reaches coin → `coin.pickup()` (sets `isPickedUp`, hides container)
2. Character stores `coinCarryValue` + `coinCarryKind`, calls `showCoinCarry()` (uses `COIN_PALETTE`)
3. Character walks home → within `CHAR_DEPOSIT_DIST` → `onDepositCoin(value)` → Game credits balance
4. If hit while carrying: `dropCarriedCoin()` → `pendingCoinDrop` → new `Coin` spawned → `recoverCoin(coin)` so character chases it; 2s blink cooldown prevents immediate re-pickup

## Physics

Characters and coins share the same platform-landing logic (check `vy > 0`, test each `PlatformData`).  
Diagonal jumps: `Character.jump(dirX)` sets both `vy = -JUMP_VELOCITY` and `jumpVx = dirX * moveSpeed`; `jumpVx` is applied to `x` each tick while airborne, zeroed on landing.

## CPU AI

`tickCpuCollectAI()` runs each tick before character updates:
- If coins exist and no CPU unit is collecting: assign the marching unit closest to a coin
- If no coins exist: return non-carrying collectors to attacking

Spawn interval scales with pressure (`playerCount - cpuCount`):
- Outnumbered (`≥ CPU_PRESSURE_THRESHOLD`): fast spawn
- Comfortable (`≤ -CPU_PRESSURE_THRESHOLD`): slow spawn
- Neutral: middle range

Unit selection prioritises cheap warriors when outnumbered or broke; riflemen when comfortable and well-funded.

## Medic

`type: 'medic'` — support unit with no attack ability.

- Each tick, `tickHeal(dt, allChars)` scans living friendlies within `CHAR_HEAL_RANGE` (55 px) and heals the most-injured one by `CHAR_HEAL_RATE * dt` (8 HP/s).
- `tickHeal` is called from `update()` before the behavior branch, so healing happens regardless of `behavior` (attacking or collecting).
- In `updateAttacking`, the medic marches toward the enemy but stops 100 px short of the enemy tower (no melee/ranged attack).
- `heal(amount)` is a public method on `Character` that clamps HP to `config.hp` and redraws the bar.
- CPU does not spawn medics — player-only unit.

## Common pitfalls

- **`as const` literal types**: `GameConfig` fields become literal types (e.g. `500` not `number`). When assigning to a mutable `hp: number` field, annotate the field type explicitly.
- **`replace_all` on import lines**: targeted edits for imports; `replace_all` for usage sites. Mixing them produces double-prefixed names.
- **Platform coordinate convention**: `p.y` is the top surface of the platform (character feet land at `p.y`). Coin uses `p.y - 14` (coin centre offset).
- **`noUnusedParameters`**: prefix intentionally-unused params with `_` (e.g. `_dt`). Remove the param entirely if nothing uses it.
