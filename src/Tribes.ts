import type { Side } from './Tower';

/**
 * Visual / identity grouping for characters. Each side fields a tribe; the
 * player tribe is mutable at runtime (toggled via the dev panel) and the
 * enemy tribe always picks the *other* registered tribe so a match never
 * pits a tribe against itself.
 *
 * Sprite assets live under `public/sprites/<tribe>/<type>/<anim>.png`.
 */
export type Tribe = 'kattgard' | 'lapinor';

export interface TribeInfo {
  id:          Tribe;
  displayName: string;
}

export const TRIBES: Record<Tribe, TribeInfo> = {
  kattgard: { id: 'kattgard', displayName: 'Kattgard' },
  lapinor: { id: 'lapinor', displayName: 'Lapinor' },
};

/**
 * The fixed roster of unit types each tribe can field. The player UI hides
 * spawn buttons for types not in the active tribe's roster, and the CPU AI
 * filters its spawn-order arrays through the same list.
 *
 * Heavy melee differs per tribe (Viking for Kattgard, Knight for Lapinor) — the
 * `heavyMeleeForTribe` helper translates between them when the AI's pre-baked
 * order arrays mention one but the tribe has the other.
 */
export const TRIBE_ROSTERS: Record<Tribe, readonly string[]> = {
  kattgard: ['conscript', 'warrior', 'archer', 'rifleman', 'sniper', 'viking', 'shocktrooper', 'grenadier', 'rocketeer'],
  lapinor: ['conscript', 'warrior', 'archer', 'rifleman', 'gunslinger', 'sniper', 'knight', 'grenadier', 'rocketeer'],
};

export function heavyMeleeForTribe(t: Tribe): 'viking' | 'knight' {
  return t === 'kattgard' ? 'viking' : 'knight';
}

// ── Runtime tribe state ─────────────────────────────────────────────────────
// Both tribes are independently mutable. On map load, Game.reset() seeds
// both from the map's per-placeholder defaults ("map drives both sides").
// The dev panel can still override the player tribe afterwards; the enemy
// tribe is set only via map load today (no dev-panel knob).

let _playerTribe: Tribe = 'kattgard';
let _enemyTribe:  Tribe = 'lapinor';

export function getPlayerTribe(): Tribe { return _playerTribe; }
export function getEnemyTribe():  Tribe { return _enemyTribe; }

export function setPlayerTribe(t: Tribe): void { _playerTribe = t; }
export function setEnemyTribe(t: Tribe):  void { _enemyTribe  = t; }

export function tribeForSide(side: Side): Tribe {
  return side === 'player' ? getPlayerTribe() : getEnemyTribe();
}
