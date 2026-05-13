---
name: add-env-element
description: Add a new environment element to the map (a Platform/Block-style obstacle, hazard, or surface). Trigger when the user asks to add a new terrain feature, obstacle, hazard, ladder, spike, or similar map-level entity. Codifies the physics/visual/pathfinding wiring so no subsystem is left out.
---

# Add a new environment element

Environment elements interact with at least four subsystems: physics bodies, character landing, pathfinding, and map authoring. Use `Platform` (one-way passthrough) or `Block` (solid all-sides) as templates depending on the new element's behavior.

## Step 0 — Decide the interaction model

Ask the user, then pick a template:
- **One-way (jump up through, land on top)** → model after `Platform`. Examples: floating ledge, thin floor.
- **Solid (collide from every direction)** → model after `Block`. Examples: wall, stone block.
- **Damaging on touch** → model after `Block` for collision but add a `tickDamage` hook in `Game.tick()`.
- **Trigger volume (no collision, just detection)** → no physics body; check intersection manually each tick.

## Step 1 — Collision category (`src/Physics.ts`)

Add a new `CAT_<NAME>` bit constant. Existing bits go up to `0x0100` (`CAT_BLOCK`) so the next free bit is `0x0200`. Add a `createXBody()` factory mirroring `createBlockBody` or the platform body creation in the constructor.

Decide the **mask** — which other categories collide with it. Update masks on existing bodies (characters, coins, power-ups, sheep) if they should collide with the new element. Pay attention to `updatePlatformPassthrough` — its `extraBits` calculation must continue to preserve the new bit (it uses `~(CAT_GROUND | CAT_PLATFORM)`, which already preserves everything else).

## Step 2 — Visual class (`src/<NewElement>.ts`)

Create a class mirroring `Platform.ts` or `Block.ts`:
- Constructor takes a `data: <Name>Data` parameter, builds the `PIXI.Container`.
- Exposes a `data` getter for the `MapDefinition` plumbing.
- Optionally exports a `<Name>Data` type alias (matches `PlatformData = { x; y; width; height }` if dimensions are the same).

## Step 3 — Map definition (`src/maps.ts`)

- Add a field to `MapDefinition`: e.g. `hazards: HazardData[];`
- Update `DEFAULT_MAP` and `HIGHLANDS_MAP` with an empty array `[]` so existing maps still validate.
- If the map builder should support it, also update `src/map-builder.ts` (canvas rendering, drag handles, JSON import/export).

## Step 4 — Game scene wiring (`src/Game.ts`)

In `build()`:
- Add a private `<element>s: <Class>[] = []` field (and a `<element>Data: <Name>Data[] = []` array if needed by other systems).
- After reading `m.<field>`, instantiate each one, push to the array, and `this.world.addChild(elt.container)`.
- After creating `this.physics`, register each element's body via the new factory.
- Add to `staticCollisionBoxes` so the debug overlay (`B` key) renders the new element.

In `reset()`: clear the arrays (the existing `this.world.removeChildren()` handles visuals, but the typed arrays must be reset).

## Step 5 — Character interaction (`src/Character.ts`)

Decide what happens when a character touches the element:
- **One-way**: extend `syncFromBody(platforms, blocks, ...)` to accept the new array and apply the same tunneling-safe crossing check used for platforms/blocks. Add edge walk-off detection in the same pass.
- **Solid**: same crossing check for landing on top; the side collision is handled automatically by the physics body if the character's body has the new bit in its mask.
- **Trigger / damaging**: detect in `Game.tick()` between physics step and character updates.

Update the `UpdateContext` interface (top of `Character.ts`) if the new element needs to be passed to behavior methods (e.g., for AI to navigate around hazards).

## Step 6 — Pathfinding (`src/Pathfinding.ts`)

If the element is **walkable** (Block-like top, or new platform variant): register it in `NavGraph.build()` as a `NavSurface`. Use the existing block-top loop as a template — `solid: true` for solid blocks, `solid: false` for one-way platforms. The split-surface logic that splits longer surfaces at solid-block intersections will automatically include the new element.

If the element is **non-walkable** (lava, spike strip): no NavGraph change needed, but consider whether characters should route around it (would require a cost increase on edges that cross over).

## Step 7 — Validate

1. `npx tsc --noEmit` — clean.
2. Refresh dev server. The element renders.
3. Walk a unit toward it — verify landing/collision behavior matches the chosen template.
4. Toggle the collision-box debug overlay (`B` key) — the new body should appear with the correct shape.
5. Spawn a unit that needs to path around/over the element — verify pathfinding routes correctly (use `/diagnostic-review` after a brief run if pathing is suspect).
6. Open the map builder (`/map-builder.html`) and confirm the element is editable if you wired Step 3's optional builder support.

## Common pitfalls

- **Forgetting NavGraph registration** — characters get stuck routing through what they can't walk through, or refuse to step onto what they can.
- **Mask not updated on existing bodies** — coins/power-ups fall through the new element (or unexpectedly collide with it). Coin and power-up bodies use the full mask; check both.
- **`syncFromBody` not updated** — character physics body lands correctly but `floorY` stays stale; AI thinks it's still in the air.
- **`staticCollisionBoxes` skipped** — debug overlay misleads you during testing.
- **`extraBits` regression in `updatePlatformPassthrough`** — if you simplify it without preserving non-ground/platform bits, coins start ignoring walls, towers, and your new element. Do not touch that line without re-reading CLAUDE.md's note on it.
