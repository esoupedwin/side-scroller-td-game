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

export const DEFAULT_MAP: MapDefinition = {
  id:           'default',
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
  coinBox: {
    x:         1404,
    y:         30,
    width:     48,
    height:    48,
    spreadDeg: 25,
  },
};

export const HIGHLANDS_MAP: MapDefinition = {
  id:           'highlands',
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
  coinBox: {
    x:         W / 2,
    y:         GY - 360,
    width:     48,
    height:    48,
    spreadDeg: 30,
  },
};

export const ALL_MAPS: MapDefinition[] = [DEFAULT_MAP, HIGHLANDS_MAP];

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
