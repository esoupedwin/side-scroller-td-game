import type { Side } from './Tower';
import { GameConfig } from './gameConfig';

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
 * The roster of unit types each tribe can field — DERIVED from the tribe's
 * character block keys in gameConfig.ts, in declaration order (which is also
 * the UI display order). Adding a character block to a tribe automatically
 * fields it: spawn button, loadout card, sprite lookup, and CPU AI all read
 * this list. Types in `characters.common` (heavy, tanker) belong to no roster.
 */
export const TRIBE_ROSTERS: Record<Tribe, readonly string[]> = {
  kattgard: Object.keys(GameConfig.characters.kattgard),
  lapinor:  Object.keys(GameConfig.characters.lapinor),
};

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
