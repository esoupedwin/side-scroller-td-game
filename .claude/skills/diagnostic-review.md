---
name: diagnostic-review
description: Analyse a Tower Defence diagnostic markdown export (produced by src/Diagnostics.ts) and propose targeted improvements to CPU AI, pathfinding, character behavior, or physics. Trigger when the user shares a `diagnostic-*.md` file or asks for a diagnostic review.
---

# Diagnostic review

A runtime diagnostic export from this game contains three sections:

1. **Anomalies** — auto-flagged by `src/Diagnostics.ts`. Types: *Path thrash*, *Walking in air*, *Stuck*, *Jump miss* (large `xOvershoot`). Each anomaly carries dense `key=value` context — character id/name, position, behavior, state, path, rebuild counts, jump physics, nearby blockers.
2. **Events** — chronological log: Spawn, Despawn, Behavior change, State change, Jump (hit/miss), Coin deposit, Cheat. Look for *patterns* across events (oscillations, rapid rebuilds, repeated jumps to the same wrong spot), not isolated events.
3. **Snapshots** — every 1.5s, full live-character table (id, side, type, behavior, state, x, y, floorY, airborne, hp, current path). Use to detect stalls (same x across multiple snapshots) and trajectories.

## Methodology

Use this order. Don't bullet-point every event — synthesise findings into a short report.

1. **Skim the header**: how many anomalies, span, population. Set expectations.
2. **Process every anomaly explicitly**. Each one is a confirmed issue worth investigating. For each:
   - Read the cited context fields (path, behavior, floorY, nearestBlock, etc.)
   - Map it to the subsystem (table below) and read the relevant code
   - Diagnose the root cause; cite `file:line` for any change you'd propose
3. **Look for event patterns** the anomaly detector misses:
   - **State oscillation**: ≥3 transitions of `marching↔fighting` for one character within 0.5s ⇒ target acquisition/loss waffle (canSnapHit edge case, target slipping in/out of range)
   - **Behavior oscillation**: ≥3 behavior flips within 1s ⇒ CPU AI assessStance/tickCpuCollectAI flapping (likely score near a stance boundary)
   - **Jump miss tail**: even non-anomalous jumps with `|xOvershoot| > 30` repeatedly to the same target ⇒ jumpVx not calibrated for that height difference
4. **Cross-check snapshots** for stalls: any character whose `x` changes < 10 px across ≥3 consecutive snapshots while behavior is `harass|attacking|collecting` is a stall (likely pathfinding or stuck-detection gap).
5. **Map findings to subsystems** and propose surgical fixes — never broad rewrites.

## Subsystem → code mapping

| Symptom | First place to look |
|---|---|
| Path thrash, fall/walk steps to a wrong x, surface mismatch | `src/Pathfinding.ts` (`findPath`, `surfaceAt`, `snapToNearestSurface`, `astar`) and `Character.requestPath`/`followPath` |
| Stuck while pathing | `Character.tickStuck`, the behavior method (`updateHarass`/`updateDefending`/`updateAttacking`/`updateCollecting`/`updateRushing`) — confirm `requestPath`'s `toFloorY` matches a reachable surface |
| Behavior oscillation (CPU) | `Game.ts` `assessCpuStance`, `tickCpuCollectAI`, `tickCpuBehaviorAI` — stance thresholds, collector count, recall logic |
| State oscillation (`marching↔fighting`) | `Character.nearestEnemy` + `canSnapHit` + per-behavior fight-vs-move branch (`updateAttacking`, `updateHarass`, `updateDefending`) |
| Walking in air | `Character.syncFromBody`'s manual platform/block landing detection; `Pathfinding` step that targeted a non-existent surface |
| Jump miss / overshoot | `Character.jump` (jumpVx assignment), `JUMP_VELOCITY` and `CHAR_GRAVITY` in `gameConfig.ts`, `Pathfinding.buildSteps` (jump trigger placement) |
| Coin oscillation, never-settled coins | `Coin.update` (settle condition), `Physics.updatePlatformPassthrough`, surface friction in `gameConfig.ts` |
| Sheep / power-up physics anomalies | `Physics.ts`, `PowerUp.ts`/`Sheep.ts` body categories and masks |

Refer to `CLAUDE.md` for architectural invariants (split surfaces, mask preservation, lastMoveDir, etc.) before proposing fixes — many "bugs" are actually documented constraints the code should respect.

## Report format

Lead with the **single highest-impact finding**, then up to 3 more in priority order. For each:

- **Symptom** — one line, with character id + timestamp from the diagnostic
- **Root cause** — what's happening in the code, with `file.ts:line` citations
- **Proposed change** — surgical: which file, which function, what to change. Don't write the patch unless the user asks.

Skip findings without an actionable code change. End with a one-line summary like "1 critical, 2 minor". Don't include exhaustive event tables — the user has the file.

## What NOT to do

- Don't propose new features or refactors unrelated to the observed anomalies.
- Don't speculate about physics constants without checking `gameConfig.ts` first.
- Don't claim a bug exists if the diagnostic only shows it once — anomalies marked by `Diagnostics.ts` are debounced and pattern-based; one-off jump misses on a tricky jump are acceptable noise.
- Don't suggest changes that conflict with `CLAUDE.md` invariants without flagging the conflict explicitly.
