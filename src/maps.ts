import type { PlatformData } from './Platform';
import type { BlockData } from './Block';
import { GameConfig } from './gameConfig';

const G  = GameConfig;
const W  = G.worldWidth;
const GY = G.canvas.height - 80;   // GROUND_Y

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
  playerTowerX: number;  // centre x of the player tower
  enemyTowerX:  number;  // centre x of the enemy tower
  platforms:       PlatformData[];
  blocks:          BlockData[];
  coinBox:         CoinBoxDef;
  playerTowerSkin?:  string;  // data URL (data:image/...;base64,…)
  playerTowerSkinW?: number;  // rendered width  (default: TOWER_WIDTH)
  playerTowerSkinH?: number;  // rendered height (default: TOWER_HEIGHT)
  enemyTowerSkin?:   string;
  enemyTowerSkinW?:  number;
  enemyTowerSkinH?:  number;
  groundSkin?:       string;  // data URL; tiled across the ground plane
  groundSkinTileW?:  number;  // tile width  in world px (default: image natural width)
  groundSkinTileH?:  number;  // tile height in world px (default: image natural height)
  backgroundSkin?:   string;  // data URL; replaces the procedural parallax mountain layer
  backgroundSkinY?:  number;  // screen-space Y offset of the parallax image (default 0 = top of sky)
  durationSec?:      number;  // match countdown in seconds (default: GAME_DURATION_SEC from gameConfig)
}

/** One world in the campaign — contains an ordered list of maps. */
export interface WorldDef {
  readonly id:   number;    // 1-indexed
  readonly name: string;
  readonly maps: readonly MapDefinition[];
}

// ── World 1: Grasslands ───────────────────────────────────────────────────────

const W1M1: MapDefinition = {
  id:           'w1m1',
  name:         'Classic Battlefield',
  worldWidth:   2808,
  playerTowerX: 60,
  enemyTowerX:  2748,
  platforms: [
    { id: 'p1', x: 1219, y: 330, width: 390, height: 70 },
    { id: 'p2', x: 1293, y: 224, width: 240, height: 14 },
  ],
  blocks: [
    { x:  540, y: 360, width: 200, height: 40 },
    { x: 2112, y: 360, width: 200, height: 40 },
  ],
  coinBox: { x: 1404, y: 30, width: 48, height: 48, spreadDeg: 25 },
};

const W1M2: MapDefinition = {
  id:           'w1m2',
  name:         'Divided Plains',
  worldWidth:   3200,
  playerTowerX: 70,
  enemyTowerX:  3130,
  platforms: [
    { id: 'p1', x:  780, y: GY - 130, width: 280, height: 18 },
    { id: 'p2', x: 1460, y: GY - 240, width: 380, height: 18 },
    { id: 'p3', x: 2140, y: GY - 130, width: 280, height: 18 },
    { id: 'p4', x: 1540, y: GY - 360, width: 180, height: 14 },
  ],
  blocks: [
    { x: 1240, y: GY - 70, width: 180, height: 40 },
    { x: 1780, y: GY - 70, width: 180, height: 40 },
  ],
  coinBox: { x: 1600, y: 30, width: 48, height: 48, spreadDeg: 30 },
};

// ── World 2: Highlands ────────────────────────────────────────────────────────

const W2M1: MapDefinition = {
  id:           'w2m1',
  name:         'Highlands',
  worldWidth:   W,
  playerTowerX: 80,
  enemyTowerX:  W - 80,
  platforms: [
    { id: 'p1', x: W / 2 - 260, y: GY - 110, width: 200, height: 14 },
    { id: 'p2', x: W / 2 +  60, y: GY - 110, width: 200, height: 14 },
    { id: 'p3', x: W / 2 -  80, y: GY - 240, width: 160, height: 14 },
  ],
  blocks: [],
  coinBox: { x: W / 2, y: GY - 360, width: 48, height: 48, spreadDeg: 30 },
};

const W2M2: MapDefinition = {
  id:           'w2m2',
  name:         'Mountain Pass',
  worldWidth:   3600,
  playerTowerX: 80,
  enemyTowerX:  3520,
  platforms: [
    { id: 'p1', x:  560, y: GY - 130, width: 240, height: 18 },
    { id: 'p2', x: 1120, y: GY - 250, width: 200, height: 14 },
    { id: 'p3', x: 1680, y: GY - 150, width: 280, height: 18 },
    { id: 'p4', x: 2200, y: GY - 280, width: 200, height: 14 },
    { id: 'p5', x: 2800, y: GY - 130, width: 240, height: 18 },
    { id: 'p6', x: 1760, y: GY - 310, width: 140, height: 14 },
  ],
  blocks: [
    { x:  880, y: GY - 60, width: 200, height: 40 },
    { x: 2520, y: GY - 60, width: 200, height: 40 },
  ],
  coinBox: { x: 1800, y: 30, width: 48, height: 48, spreadDeg: 35 },
};

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
 * Return the stored version of the map if one exists, otherwise the original.
 * Called at game startup so saved edits are reflected immediately on refresh.
 */
export function loadMapWithOverride(map: MapDefinition): MapDefinition {
  return loadStoredMaps()[map.id] ?? map;
}
