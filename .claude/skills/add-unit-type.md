---
name: add-unit-type
description: Add a new character unit type to the game. Trigger when the user asks to add a new unit (e.g. "add a flamethrower unit", "create a scout class") or asks how to introduce one. Codifies the cross-file recipe so no step is missed.
---

# Add a new unit type

Adding a unit touches ~8 files. Skipping any one usually fails silently (no compile error, but the unit can't be spawned, the CPU never picks it, or the HUD card is blank). Work through the steps in order — type definitions first, then config, then sprite, then UI wiring.

## Step 0 — Confirm the design with the user

Before touching code, get short answers to:
- **Combat archetype**: melee, ranged (snap-aim arrow/bullet), ballistic (grenade/rocket), or support (heal).
- **HP, attack power, attack range, fire rate, move speed, critical (miss) rate, cost.**
- **Spawn-boost participation**: same as other units (default yes — `withSpawnBoosts` is called in both `spawnPlayer` and `spawnCpu`).

Don't invent stats. Ask.

## Step 1 — Config (`src/gameConfig.ts`)

Add a block under `characters:` matching the existing ones (warrior, archer, etc.). Include `width`/`height` only if non-default. Re-export the config from `src/constants.ts` (look for the existing `WARRIOR`/`ARCHER`/… exports) and add the cost to the `CHAR_COST` object.

## Step 2 — Type union (`src/Character.ts`)

Extend `CharacterConfig.type` to include the new string literal. The compiler will then surface every place that switches on type.

## Step 3 — Sprite (`src/Character.ts`)

- Add a `private build<TypeName>Sprite()` method following the structure of `buildArcherSprite` (range) or `buildWarriorSprite` (melee). Use `this.config.width`/`height` and `PLAYER_COLOR`/`ENEMY_COLOR`.
- Add a case in `buildSprite()` that dispatches to the new method.

## Step 4 — Combat archetype hooks (`src/Character.ts`)

Depending on the archetype:
- **Melee** — add to `Character.isMeleeType()` static if it deals damage on contact in `attackEnemy` (the warrior/heavy branch).
- **Snap-aim ranged** — add to the `isRanged` getter if it should respect line-of-sight checks. Add to `projectileKind` getter (returns 'arrow' or 'bullet'). The existing `canSnapHit` filter will pick it up automatically.
- **Ballistic (new grenade/rocket variant)** — add a new branch to `attackEnemy`/`attackTower` that calls `onFire` with the right `projectileKind`. Add an early-return in `canSnapHit` so it isn't snap-filtered.
- **Support (no attack)** — model after `medic`; ensure `attackRange` is 0 or the unit stops short in `updateAttacking`.

## Step 5 — Game registry (`src/Game.ts`)

- Add to the `CHAR_CONFIGS` map at the top of the file.
- Decide where the new unit fits in **each stance's spawn-order array** inside `spawnCpu` (push/defend/economy). If the CPU should never spawn it (like medic exception in some branches), skip those branches deliberately.
- If the unit's strategic weight differs, add it to the `typeWeight` function inside `assessCpuStance`.

## Step 6 — Player spawn UI (`src/main.ts`, `index.html`)

- Append the type literal to `UNIT_TYPES` in `src/main.ts`.
- Add a `<button id="spawn-<type>-btn" class="spawn-btn">` in `index.html` with an icon and a `<span class="btn-cost" id="<type>-cost">` element. Match the visual style of an existing button.
- The existing loops in `main.ts` (handler registration + cost population + enabled-state refresh) will pick up the new entry automatically.

## Step 7 — HUD (`src/CharacterHUD.ts`)

Add entries to `TYPE_ICON` (single emoji) and `TYPE_COLOR` (hex). Without these the HUD card renders without a badge.

## Step 8 — Validate

1. `npx tsc --noEmit` — must be clean. If `noUnusedParameters` complains in `buildSprite()`, the new branch is unreachable.
2. Refresh the dev server. Spawn the unit from the player button — verify the sprite renders, HUD card shows the icon/color, and the unit moves/attacks per archetype.
3. Enable CPU vs CPU in the dev panel and confirm the CPU eventually spawns the new unit under at least one stance.

## Common pitfalls

- **Forgetting the spawn-order arrays in `spawnCpu`** — the unit is buyable by the player but the CPU never picks it. The CPU AI section is the easiest step to miss.
- **Missing `CHAR_CONFIGS` entry** — `Game.ts` constructs Characters via `CHAR_CONFIGS[type]`; missing entry = silent runtime error when CPU tries to spawn it.
- **Forgetting `withSpawnBoosts` parity** — `spawnPlayer` doesn't apply boosts but `spawnCpu` does. New units don't need extra wiring here — both flows reach `CHAR_CONFIGS[type]`.
- **Skipping `projectileKind` for a ranged variant** — defaults to `'arrow'`, which may use the wrong splash radius and visual.
