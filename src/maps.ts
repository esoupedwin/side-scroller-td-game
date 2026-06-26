import type { PlatformData } from './Platform';
import type { BlockData } from './Block';
import type { DecorData } from './Decor';
import type { Tribe } from './Tribes';
import defaultMapData from './defaultMapData.json';

export interface CoinBoxDef {
  x:         number;   // centre x in world space
  y:         number;   // top y in world space
  width:     number;
  height:    number;
  spreadDeg: number;   // ± degrees coins can spread from vertical
}

export interface MapDefinition {
  id:           string;
  name:         string;
  worldWidth:   number;
  worldHeight?: number;  // canvas height in px (default: GameConfig.canvas.height)
  groundHeight?: number; // height of the green ground strip below GROUND_Y (default: worldHeight - GROUND_Y)
  groundZ?:      number; // render order of the ground plane in the shared scene z-space (platforms/blocks/decor). Default 0.
  playerTowerX: number;  // centre x of the player tower
  playerTowerY?: number; // base y (bottom) of the player tower (default: GROUND_Y)
  enemyTowerX:  number;  // centre x of the enemy tower
  enemyTowerY?: number;  // base y (bottom) of the enemy tower (default: GROUND_Y)
  /**
   * Default tribe for each placeholder. Drives the runtime tribe selection
   * on map load (Game.reset() seeds both via setPlayerTribe / setEnemyTribe).
   * Tower skin + W + H come from per-tribe templates in TribeTowerTemplates,
   * NOT from this map.
   */
  playerTowerTribe?: Tribe;  // default 'kattgard'
  enemyTowerTribe?:  Tribe;  // default 'lapinor'
  playerTowerZ?:     number; // render layer order relative to blocks & platforms (default 0)
  enemyTowerZ?:      number;
  platforms:       PlatformData[];
  blocks:          BlockData[];
  decor?:          DecorData[];  // purely-visual props (flowers, rocks, …); no collision
  coinBox:         CoinBoxDef;
  groundSkin?:       string;  // data URL; tiled across the ground plane
  groundSkinTileW?:  number;  // tile width  in world px (default: image natural width)
  groundSkinTileH?:  number;  // tile height in world px (default: image natural height)
  backgroundSkin?:    string;  // data URL; replaces the procedural parallax mountain layer
  backgroundSkinY?:   number;  // screen-space Y offset of the parallax image (default 0 = top of sky)
  backgroundSkin2?:   string;  // data URL; second parallax layer rendered behind backgroundSkin (slower scroll)
  backgroundSkin2Y?:  number;  // screen-space Y offset of the far parallax image (default 0)
  durationSec?:      number;  // match countdown in seconds (default: GAME_DURATION_SEC from gameConfig)
}

/** One world in the campaign — contains an ordered list of maps. */
export interface WorldDef {
  readonly id:   number;    // 1-indexed
  readonly name: string;
  readonly maps: readonly MapDefinition[];
}

// ── Map definitions ───────────────────────────────────────────────────────────
//
// The four base maps (geometry + platform/decor/background/ground skins) are
// baked from the map-builder export in `defaultMapData.json` — the committed
// default layout. `loadMapWithOverride` still lets a localStorage edit win at
// runtime, so editing in the map builder continues to work on top of these.
const RAW_MAPS = defaultMapData.maps as unknown as MapDefinition[];

function mapById(id: string): MapDefinition {
  const m = RAW_MAPS.find(x => x.id === id);
  if (!m) throw new Error(`defaultMapData.json is missing map '${id}'`);
  return m;
}

const W1M1 = mapById('w1m1');
const W1M2 = mapById('w1m2');
const W2M1 = mapById('w2m1');
const W2M2 = mapById('w2m2');

// ── Campaign structure ────────────────────────────────────────────────────────

export const WORLDS: WorldDef[] = [
  { id: 1, name: 'Grasslands', maps: [W1M1, W1M2] },
  { id: 2, name: 'Highlands',  maps: [W2M1, W2M2] },
];

/** Flat ordered list of all maps — World 1 Map 1 first. */
export const ALL_MAPS: MapDefinition[] = WORLDS.flatMap(w => [...w.maps]);

/**
 * Canonical first map.  Game.ts and the map builder default to this.
 * Always resolves to World 1 Map 1.
 */
export const DEFAULT_MAP: MapDefinition = W1M1;

/**
 * Returns the map that follows `current` in campaign order, or `null` if
 * `current` is the last map of the last world.
 */
export function nextMap(current: MapDefinition): MapDefinition | null {
  const idx = ALL_MAPS.findIndex(m => m.id === current.id);
  return idx >= 0 && idx < ALL_MAPS.length - 1 ? ALL_MAPS[idx + 1] : null;
}

/**
 * Returns `{ world, mapIndex }` (both 1-indexed) for a given map id,
 * or `null` if not found.
 */
export function mapCoords(id: string): { worldIndex: number; mapIndex: number } | null {
  for (const world of WORLDS) {
    const mi = world.maps.findIndex(m => m.id === id);
    if (mi >= 0) return { worldIndex: world.id, mapIndex: mi + 1 };
  }
  return null;
}

// ── localStorage persistence ──────────────────────────────────────────────────

const STORAGE_KEY = 'coin_saved_maps';

function loadStoredMaps(): Record<string, MapDefinition> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); }
  catch { return {}; }
}

/** Persist a map by id so the game picks it up on next load. */
export function saveMapToStorage(map: MapDefinition): void {
  const all = loadStoredMaps();
  all[map.id] = map;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/**
 * Strip pre-refactor inline tower-skin fields from a stored map. Old saves
 * embedded per-side data URLs and W/H here; those now live in
 * TribeTowerTemplates. We silently drop the stale fields so the loader keeps
 * working — the next saveMapToStorage() persists the clean shape.
 */
function migrateStoredMap(raw: unknown): MapDefinition {
  const m = { ...(raw as Record<string, unknown>) };
  delete m.playerTowerSkin;
  delete m.playerTowerSkinW;
  delete m.playerTowerSkinH;
  delete m.enemyTowerSkin;
  delete m.enemyTowerSkinW;
  delete m.enemyTowerSkinH;
  return m as unknown as MapDefinition;
}

/**
 * Return the stored version of the map if one exists, otherwise the original.
 * Called at game startup so saved edits are reflected immediately on refresh.
 */
export function loadMapWithOverride(map: MapDefinition): MapDefinition {
  const stored = loadStoredMaps()[map.id];
  return stored ? migrateStoredMap(stored) : map;
}
