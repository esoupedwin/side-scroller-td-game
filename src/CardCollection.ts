import { TRIBE_ROSTERS, type Tribe } from './Tribes';
import { LOADOUT_MAX_CARDS } from './constants';

/**
 * Player card collection + per-map loadout.
 *
 * Collection — which character cards the player OWNS, per tribe. Persisted in
 * localStorage. Today every card in a tribe's roster is owned by default;
 * `grantCard()` is the hook for future earning mechanics (map rewards, drops).
 * Once anything has been granted, the stored set becomes authoritative.
 *
 * Loadout — the up-to-LOADOUT_MAX_CARDS cards the player picked for the
 * current map. Persisted per tribe so the selection screen can preselect the
 * previous choice across sessions.
 */

const COLLECTION_KEY = 'coin_card_collection';
const LOADOUT_KEY    = 'coin_card_loadout';

type PerTribe = Partial<Record<Tribe, string[]>>;

function readStore(key: string): PerTribe {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') as PerTribe; }
  catch { return {}; }
}

function writeStore(key: string, store: PerTribe): void {
  try { localStorage.setItem(key, JSON.stringify(store)); }
  catch { /* localStorage full or unavailable — collection just won't persist */ }
}

/**
 * Cards the player owns for a tribe, in roster display order.
 * Nothing stored yet → the full roster (everything owned by default).
 * A stored list is filtered through the roster so retired types drop out.
 */
export function getOwnedCards(tribe: Tribe): string[] {
  const roster = TRIBE_ROSTERS[tribe];
  const stored = readStore(COLLECTION_KEY)[tribe];
  if (!stored) return [...roster];
  return roster.filter(t => stored.includes(t));
}

/**
 * Add a card to the collection (future earning hook — map rewards, drops).
 * Returns false when the card is already owned or isn't in the tribe's roster.
 */
export function grantCard(tribe: Tribe, type: string): boolean {
  if (!TRIBE_ROSTERS[tribe].includes(type)) return false;
  const store = readStore(COLLECTION_KEY);
  const owned = store[tribe] ?? getOwnedCards(tribe);
  if (owned.includes(type)) return false;
  store[tribe] = [...owned, type];
  writeStore(COLLECTION_KEY, store);
  return true;
}

/**
 * Last saved loadout for a tribe, validated: owned cards only, capped at
 * LOADOUT_MAX_CARDS. Falls back to the first LOADOUT_MAX_CARDS owned cards
 * when nothing valid is stored (first run).
 */
export function loadLoadout(tribe: Tribe): string[] {
  const owned  = getOwnedCards(tribe);
  const stored = readStore(LOADOUT_KEY)[tribe] ?? [];
  const valid  = stored.filter(t => owned.includes(t)).slice(0, LOADOUT_MAX_CARDS);
  return valid.length > 0 ? valid : owned.slice(0, LOADOUT_MAX_CARDS);
}

/** Persist the picked loadout for a tribe. */
export function saveLoadout(tribe: Tribe, types: string[]): void {
  const store = readStore(LOADOUT_KEY);
  store[tribe] = types.slice(0, LOADOUT_MAX_CARDS);
  writeStore(LOADOUT_KEY, store);
}
