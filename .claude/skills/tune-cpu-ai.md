---
name: tune-cpu-ai
description: Adjust CPU AI strategic behavior — stance thresholds, spawn priorities, type weights, or stance-driven spawn-rate multipliers. Trigger when the user reports the CPU as too passive/aggressive, spawning the wrong units, switching stances at the wrong score, or behaving oddly in some scenarios. Pairs with the `diagnostic-review` skill for evidence-based tuning.
---

# Tune CPU AI

The CPU's strategy lives entirely in **`src/Game.ts`** across four methods: `assessCpuStance`, `spawnCpu`, `tickCpuCollectAI`, `tickCpuBehaviorAI`. All operate per-side (`'enemy'` or `'player'`) since CPU vs CPU was added. There is no separate config file — every magic number is inline. The job of this skill is to guide *which* number to change for a given symptom.

## Methodology

1. **Reproduce in CPU vs CPU mode.** Enable from the dev panel (button in the bottom bar). This isolates AI behavior from human play.
2. **Record a diagnostic.** Click *Diagnose*, run for 30–60 s, click *Produce Diagnostic Data*.
3. **Invoke `diagnostic-review`** on the file. The report flags anomalies and oscillations.
4. **Map the symptom to a knob below**, change one value, re-run.
5. **Iterate** — don't change multiple knobs at once. The CPU's stance machine has feedback loops; isolated changes are reproducible.

## Symptom → knob map

| Symptom | Where to look | What to nudge |
|---|---|---|
| CPU never pushes even when ahead | `assessCpuStance` score thresholds | Lower the `push` threshold (currently `score > 0.8`) toward `0.5` |
| CPU panics into defend too easily | `assessCpuStance` thresholds | Make the `defend` threshold more negative (currently `< −0.7`) |
| CPU goes into defend / push when tower is fine | `assessCpuStance` critical-tower override | Lower the `< 0.28` ratio to e.g. `< 0.20` |
| Stance flips every tick (oscillation) | Anomaly: behavior oscillation in diagnostic | Widen hysteresis: require `score > 0.8 + ε` to enter push, `score < 0.7` to exit (currently no hysteresis — both checks use the same value) |
| Spawn interval too slow in pressure | `resetSpawnTimer` | Reduce `CPU_SPAWN_MIN_MS` in `gameConfig.ts` or lower the urgent factor |
| Spawn interval too fast when comfortable | Same | Raise `CPU_SPAWN_MAX_MS` or the comfort factor |
| Stance modifier too aggressive on push | `resetSpawnTimer` `stanceMult` | Raise the `0.70` toward `0.85` |
| Wrong unit type spawned in stance X | `spawnCpu` `order` arrays | Reorder the array for that stance |
| CPU never spawns a specific unit | `spawnCpu` order arrays | Confirm the unit is present in at least one branch (medic is intentionally absent from some) |
| CPU misvalues a unit type | `assessCpuStance` `typeWeight` | Adjust the weight (tanker=2.5, heavy=1.8, sniper=1.4, rifleman=1.3, archer=1.2, medic=0.5, default=1.0) |
| CPU collector count wrong for situation | `tickCpuCollectAI` `wantedCollectors` | `push`: 1, `defend`: 1 if ≥3 chars else 0, `economy`: 2 — adjust the rule |
| CPU keeps recalling and re-assigning collectors | Diagnostic: rapid collecting↔attacking flips | The `wantedCollectors` rule is bouncing across a boundary; consider hysteresis or a min-time-in-role |
| Melee charges when they should defend | `tickCpuBehaviorAI` | Confirm `isMelee` / `isRangedUnit` classification; reassign in the relevant stance branch |

## Knobs that look tempting but usually aren't the right fix

- **`PROMO_*` constants** — affect both sides. Not a CPU-specific knob.
- **Per-unit `attackRange` / `fireRate`** — these are global balance changes, not AI tuning. Use the `add-unit-type` flow's design phase, not here.
- **`assessCpuStance` weights `1.5 / 2.5 / 0.5`** — composite-score weighting; changing these shifts every threshold's effective meaning at once. Touch only when symptoms span multiple stances simultaneously.

## After any change

1. `npx tsc --noEmit` (rarely fails for number-only edits but confirms structural changes).
2. Re-run CPU vs CPU, record a new diagnostic, run `diagnostic-review` again. The same anomaly type should disappear or weaken.
3. Sanity-check the OTHER side too — a change tuned against an enemy weakness can make the player AI too strong, since both sides use the same code.
4. If the change is a stance threshold, **also** check the case it used to cover well — don't fix push at the cost of defend.

## When to recommend a structural change instead of a knob twist

If you find yourself wanting to tune **three or more** knobs to fix one symptom, suggest a structural change instead — e.g., add hysteresis around stance thresholds (a `lastStanceChangeAt` timestamp with a minimum dwell time), or convert `wantedCollectors` from stance-derived to opportunity-derived. Surface this to the user before making it; structural changes are larger than a knob tweak and warrant a plan.
