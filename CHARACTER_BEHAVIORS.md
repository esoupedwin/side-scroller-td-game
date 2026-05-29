# Character behaviors

Reference for the five `behavior` values a character can hold — their per-tick logic, the conditions under which each branch runs, and how a behavior gets assigned in the first place.

## Behavior vs state

Two distinct fields, often confused:

- **`behavior`** (`'attacking' | 'collecting' | 'harass' | 'defend' | 'rush'`) — the character's *strategic intent*, assigned externally (CPU AI tick or player HUD click). Persists across ticks until something explicitly changes it.
- **`state`** (`'marching' | 'fighting' | 'collecting' | 'returning' | 'dead'`) — what the character is *doing this frame*. Re-derived by each `update<Behavior>()` from current world conditions. Drives the body/legs animation choice in `tickAnimSprite`.

`update()` ([`Character.ts:1729-1745`](src/Character.ts#L1729-L1745)) dispatches on `behavior` each tick, after a `syncFromBody` and ahead of the locomotion/animation tick. The dispatch order:

```
collecting → updateCollecting
harass     → updateHarass
defend     → updateDefending
rush       → updateRushing
(default)  → updateAttacking     // 'attacking' and any unrecognised value
```

Every branch returns early when `isAirborne` is true (or near-equivalently for collecting/harass), so horizontal AI never fights mid-jump.

## Behavior setter ([`Character.ts:378-393`](src/Character.ts#L378-L393))

`character.behavior = value` is a setter with side effects on *leaving* certain behaviors:

| Leaving | Side effect |
|---|---|
| `collecting` | `targetCoin = null`; if carrying a coin, `dropCarriedCoin()` is invoked so the coin spawns at the character's position and a 2 s `coinPickupCooldown` blink starts. Prevents stealth-stealing — switching off `collecting` mid-carry can't just hide the coin. |
| `defend` | Releases pursuit claim (`defendTargetIntruder = null`) and rally cache (`defendRallyX = null`, `defendWasPursuing = false`). Stops the next defender from inheriting stale targeting. |

No side effects on *entering* a behavior — the new behavior's `update<Behavior>()` is the one that decides what to do next.

---

## `attacking` — march toward enemy tower, engage on the way

[`updateAttacking`, Character.ts:2131](src/Character.ts#L2131)

The default behavior for newly-spawned units. The character walks toward the enemy tower; if anything in `config.attackRange` is hittable, stop and fight. Once the tower itself is in range, switch to chipping it.

### Branches (in order)

1. **Enemy in attack range** → `state = 'fighting'`, call `attackEnemy(nearest, onFire)`.
   - **Ranged kiting:** if `this.isRanged` and the target is a melee type within `RANGED_KITE_THRESHOLD` (80 px), back away at `moveSpeed`, but never past `homeTowerFrontX` (don't retreat into your own tower).
2. **Tower in attack range** (`distToTower <= config.attackRange`) → `state = 'fighting'`, call `attackTower(...)`.
3. **Otherwise** → `state = 'marching'`, `requestPath(enemyTowerFrontX, enemyTowerBaseFloorY, ...)` then `followPath`. The destination uses the tower's **base-floor** Y (not `GROUND_Y`) so paths reach an elevated tower's actual surface, not the ground beneath it.

### Conditions to read

- `nearest = nearestEnemy(enemies, config.attackRange, blocks)` — line-of-sight and `canSnapHit` filtering is inside this helper; if a block clips the shot or the target is on a different Y-plane for snap-firers, `nearest` returns `null` and the character walks on.
- `isAirborne` short-circuits the whole branch — no horizontal intent while mid-jump.

---

## `rush` — charge the tower, jump over blockers, never stop

[`updateRushing`, Character.ts:2169](src/Character.ts#L2169)

Variant of `attacking` that **does not stop to engage**. Used when the player wants to bull-rush units into the enemy tower without letting them get pinned by skirmishes en-route. Set exclusively via the player HUD button cycle.

### Branches

1. **Tower in attack range** → `state = 'fighting'`, hit the tower (same as attacking).
2. **Enemy in attack range** → keep walking, but call `attackEnemy(nearest, onFire)` opportunistically (no state change).
3. **Enemy directly ahead within 90 px and on the same floor (±25 px tolerance)** → `jump(dir, dt)`. Tankers are excluded from the dodge — they're too big to vault.
4. **Otherwise** → `state = 'marching'`, path toward `enemyTowerFrontX` at the enemy tower's base-floor Y.

### Differences from `attacking`

| | attacking | rush |
|---|---|---|
| Stop to fight nearby enemies | yes (`state = 'fighting'`) | no (fires while marching) |
| Jump over blockers | no (relies on pathfinder) | yes (90 px lookahead) |
| Ranged kiting | yes | no — never retreats |

---

## `harass` — advance to a safe line, fire from outside tower range

[`updateHarass`, Character.ts:2341](src/Character.ts#L2341)

Used by the CPU AI for **ranged units** in `push` or `defend` stance (and by the player HUD cycle). Holds a position at `safeX = enemyTowerFrontX − dir × (TOWER_ATTACK_RANGE + HARASS_SAFETY_BUFFER)` — far enough back to stay out of the enemy tower's auto-fire arc, but inside the unit's own attack range.

### Priority order (highest first)

1. **Past the safe line** (closer to the enemy tower than `safeX`) → back off at `moveSpeed`, but still fire at any in-range enemy. Highest priority — never let a harasser stand under the enemy tower's gun.
2. **Enemy in attack range** → `state = 'fighting'`, attack. Kiting applies the same way as `attacking` (ranged unit + melee target + closer than 80 px → retreat).
3. **No in-range enemy, but state was `'fighting'`** → drop back to `'marching'` so the body anim stops showing `attack` while the character walks.
4. **Closest enemy is on a platform, harasser is on the ground** → walk toward the enemy's x, and once on top of the platform's x-span, jump up.
5. **Closest enemy is ahead and out of range (×0.8 buffer)** → path toward it, clamped to `safeX`. Destination floor is the *enemy's* `floorY`, not the harasser's, so the harasser climbs to engage rather than stalling at its current platform's edge.
6. **Closest enemy is behind** — split:
   - Melee harasser within `attackRange × 4` → pursue back (don't drift toward enemy tower without the enemy).
   - Ranged or far behind → path back to `safeX` at the harasser's current `floorY`.
7. **Enemy is in horizontal range but on a different floor (Δfloor > 20 px)** → path toward the enemy's floor so the harasser jumps up or drops down. Without this, the harasser would hold position thinking it's already in range.
8. **No enemies anywhere** → rally near the nearest ally (within 55 px) if one exists, otherwise hold 80 px in front of `homeTowerFrontX`.

### Key constants

| Constant | Value | Role |
|---|---|---|
| `HARASS_SAFETY_BUFFER` | 40 | Extra px outside the enemy tower's range where harassers hold |
| `RANGED_KITE_THRESHOLD` | 80 | Distance at which ranged units back away from melee |
| `TOWER_ATTACK_RANGE` | (from `gameConfig`) | Used twice — defines `safeX` AND triggers kiting checks |

---

## `defend` — patrol home-tower area, engage any intruder in the attack zone

[`updateDefending`, Character.ts:2451](src/Character.ts#L2451)

Used by the CPU AI for **melee units** in `defend` stance. The defender holds a rally point inside the **defence zone** (the slab matching the tower's auto-fire range) but is allowed to step out into the wider **attack zone** to chase an intruder.

### Two zones

```
homeTower ─── defence zone (TOWER_ATTACK_RANGE) ─── attack zone (DEFEND_PURSUIT_RANGE = 600 px) ───→
            ^ rest here                              ^ pursue up to here (clamp)
```

- **Defence zone** — where defenders idle when no threat is present.
- **Attack zone** — used for *detection* and *pursuit clamp*. Any enemy here is a threat, but the defender never wanders past the attack-zone boundary. The wider zone catches ranged enemies firing in from just outside the auto-fire arc (otherwise defenders take chip damage they can't return).

### Tick logic

1. **Pursuit claim deduplication**: collect intruders already targeted by other defenders (each defender exposes its current target via `claimedIntruder`). The current defender excludes those from its own scan to prevent dog-piling.
2. **Pick or keep an intruder**:
   - If we already have a target and it's still alive and inside the attack zone, keep it.
   - Otherwise, nearest unclaimed enemy inside the attack zone.
3. **If intruder found**:
   - In personal `attackRange` with a clean shot (`nearestEnemy` LOS filter passes) → `state = 'fighting'`, attack. Ranged defenders kite back from closing melee but never beyond `homeTowerFrontX`.
   - In attack zone but no shot → path to `clamp(intruder.x, [atkNearX, atkFarX])` at the intruder's `floorY`.
4. **No intruder**:
   - Release pursuit claim.
   - If we were just pursuing, or no rally point is cached, generate a new random rally x inside the defence zone (`defNearX + Math.random() × (defFarX − defNearX)`). Spreads defenders out instead of stacking them.
   - Path back to the rally x at `GROUND_Y` (deliberately not `this.floorY` — the defence zone always sits on the ground; using the defender's current floorY can ask for a non-existent surface and return an empty path, freezing the defender).

### Behavior-leave side effect

When the defender's behavior changes to anything else, the setter clears `defendTargetIntruder`, `defendRallyX`, and `defendWasPursuing`. The next defender to assume the role starts fresh.

---

## `collecting` — fetch coins, deposit at home tower, throw when out of reach

[`updateCollecting`, Character.ts:2209](src/Character.ts#L2209)

Multi-phase: pick a coin, walk to it, pick it up, walk it home, deposit OR throw if too far. Layered on top of opportunistic combat — collectors still fire at in-range enemies as they march.

### Opportunistic combat & evasion (every tick, ahead of the main branches)

- **Attack:** if grounded and an enemy is in `attackRange`, call `attackEnemy(nearest, onFire)` *without* changing direction or stopping.
- **Evasive jump:** if grounded, *not* on a platform (jumping off a platform throws the character off course), `evasiveJumpTimer <= 0`, and an enemy is within 60 px in the direction of travel → 80 % chance to jump over them. Sets `evasiveJumpTimer = 2.0 s` cooldown.

### Carrying-coin branches

1. **Airborne** → `return` (no horizontal AI; wait until landed).
2. **Within `CHAR_DEPOSIT_DIST` of `homeTowerFrontX`** → deposit. Clear `carryingCoin`, call `onDepositCoin(value)`, award `PROMO_COIN_AP`, `state = 'marching'`.
3. **Beyond `COIN_THROW_MIN_DIST` AND not too low to throw** → throw windup. Set `coinThrowTimer = COIN_THROW_HOLD_SEC` (0.5 s), stand still (`state = 'returning'`). When the timer expires, call `throwCarriedCoin(homeTowerFrontX)` (45° arc toward home), scan for a nearby coin (`COIN_THROW_SCAN_RANGE = 80 px`), and fall through to the pickup-search branch.
4. **Otherwise (close-but-not-depositing OR too low to throw)** → keep carrying. Clear any pending throw timer, `state = 'returning'`, path to `(homeTowerFrontX, homeTowerBaseFloorY)`.

   **"Too low to throw"** = `(this.floorY − homeTowerBaseFloorY) >= COIN_THROW_MAX_Y_GAP` (currently 100 px). Prevents arcing coins into the side of an elevated block when the carrier is standing on the ground below the tower. `floorY` (the snapped surface) is used instead of `this.y` so sub-pixel physics bounce doesn't drop the gap just under the threshold.

### Not-carrying branches (post-throw or hunting)

1. **Stale target** (coin is dead or already picked up) → clear `targetCoin`.
2. **No target** → pick the coin closest to `homeTowerFrontX`, excluding coins claimed by another collecting ally (each collector exposes `claimedCoin`). If every coin is claimed, fall back to the full list.
3. **With target** → path to `(coin.x, coin.floorY)`, `state = 'collecting'`. Pickup gates:
   - `dist <= CHAR_PICKUP_DIST` (horizontal).
   - `sameSurface` — `|floorY − coin.floorY| < 30` *or* the character is within 40 px vertically of the coin (catches coins still in flight).
   - `coinReachable` — coin has settled, OR is within 30 px of ground, OR within 40 px vertically. The `y >= GROUND_Y − 30` fallback is **load-bearing**: removing it freezes carriers on coins that haven't quite finished bouncing.
   - `coinPickupCooldown <= 0` (post-drop blink suppresses immediate re-pickup).
4. **No coins anywhere** → drift toward `worldWidth / 2` at half speed (camp the centre where new sky-drops land).

### Pickup → carry transition

When the pickup gates pass: stash `coinCarryValue` + `coinCarryKind`, call `targetCoin.pickup()` (which removes the coin's physics body), clear the path, set `carryingCoin = true`, `state = 'returning'`, and call `showCoinCarry()` to render the carried-coin indicator above the character.

---

## How behaviors are assigned

Behaviors are *not* set by the character itself — they come from one of three external sources.

### CPU AI tick — `Game.tickCpuBehaviorAI` ([Game.ts:1747](src/Game.ts#L1747))

Runs each tick for both sides. Reads the **stance** (`'push' | 'defend' | 'economy'`) computed by the side's strategy module and pushes every non-collecting unit into the appropriate behavior:

| Stance | Melee (warrior/knight/heavy/tanker) | Ranged (archer/rifleman/sniper) |
|---|---|---|
| `defend` | `defend` | `harass` |
| `push` | `attacking` | `harass` |
| `economy` | `attacking` | `attacking` |

Collectors are skipped — once a unit is collecting, the collect AI (next) owns its lifecycle.

### CPU collect AI — `Game.tickCpuCollectAI` ([Game.ts:1694](src/Game.ts#L1694))

Runs each tick. Decides how many collectors the side should field given current stance:

| Stance | Wanted collectors |
|---|---|
| `push` | 1 |
| `defend` | 1 if 3+ total units, else 0 |
| `economy` | 2 |

- If too many non-carrying collectors exist → recall the excess to `'attacking'`.
- If too few and coins are on the field → pick the marching attacker closest to a coin (excluding tankers and heavies — too valuable for collection runs) and set it to `'collecting'`.
- If no coins exist → recall every non-carrying collector to `'attacking'`. Carrying collectors always finish their run.

### Player HUD click — `CharacterHUD` ([CharacterHUD.ts:121](src/CharacterHUD.ts#L121))

Each player-side character card shows a behavior button. Clicking cycles:

```
attacking → collecting → harass → defend → rush → attacking
```

This is the **only** path to `rush` — the CPU AI never sets it. The player overrides any prior AI assignment; subsequent CPU AI ticks operate on the player side too (the AI runs for both sides), so the assignment will be re-evaluated next tick unless the player keeps re-clicking. In practice the player AI's stance is `push` by default so manually-set `rush` units stay `rush` until the player reverts them or the stance changes.

---

## Cross-cutting rules

A few things apply across every behavior:

- **Airborne short-circuit** — every `update<Behavior>` returns early when `isAirborne` is true. Movement during a jump is owned by `jumpVx` and `syncFromBody`, not the AI tick.
- **`lastMoveDir`** — `update()` records `lastMoveDir` after the behavior tick by comparing `this.x` before and after. Anywhere that needs the character's actual travel direction (animation facing, evasion checks) reads `lastMoveDir` rather than `side === 'player' ? 1 : -1`, because a collecting character returning home moves *opposite* its side direction.
- **Knockback lock** — while `isKnockedBack` is true the entire behavior dispatch is skipped (`update()` line 1732). Knockback velocity decays over time per `attackKnockbackDecay`.
- **Tower face clamp** — every tick, `update()` clamps `this.x` between `homeTowerFrontX` and `enemyTowerFrontX` (the two tower faces). Behavior code never needs to enforce this itself.
- **Block-wall clamp** — `clampBlockWalls(blocks)` runs each tick (skipped while airborne so jump arcs survive) to prevent horizontal pass-through of solid blocks. Behavior code can teleport `this.x` freely; the clamp catches over-travel.
