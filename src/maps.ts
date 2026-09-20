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
  skin?:     string;   // data URL; replaces the procedural coin-box graphic, scaled to width×height
}

/** Optional per-kind coin skin overrides (data URLs). A missing kind falls
 *  back to the procedural COIN_PALETTE graphic. */
export interface CoinSkinsDef {
  gold?:   string;
  silver?: string;
  blue?:   string;
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
  coinSkins?:      CoinSkinsDef;  // per-kind coin PNG overrides (gold/silver/blue)
  groundSkin?:       string;  // data URL; tiled across the ground plane
  groundSkinTileW?:  number;  // tile width  in world px (default: image natural width)
  groundSkinTileH?:  number;  // tile height in world px (default: image natural height)
  backgroundSkin?:    string;  // data URL; replaces the procedural parallax mountain layer
  backgroundSkinY?:   number;  // screen-space Y offset of the parallax image (default 0 = top of sky)
  backgroundSkinH?:   number;  // rendered height in px of the parallax image (default: ground surface Y)
  backgroundSkin2?:   string;  // data URL; second parallax layer rendered behind backgroundSkin (slower scroll)
  backgroundSkin2Y?:  number;  // screen-space Y offset of the far parallax image (default 0)
  backgroundSkin2H?:  number;  // rendered height in px of the far parallax image (default: ground surface Y)
  durationSec?:      number;  // match countdown in seconds (default: GAME_DURATION_SEC from gameConfig)
  /**
   * Vertical camera pan limits in world px. The camera's visible window is
   * clamped so it never reveals above cameraTopY (default 0 = sky top) or
   * below cameraBottomY (default worldHeight = world bottom). An explicit
   * cameraBottomY replaces the global CAMERA_MAX_PAN_DOWN heuristic.
   */
  cameraTopY?:    number;
  cameraBottomY?: number;
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

// ── Map registry (campaign order) ─────────────────────────────────────────────
// The campaign structure — which maps exist and their order per world — is a
// localStorage-backed registry so the map builder can create new maps and
// reorder existing ones without a code change. Baked maps resolve from
// defaultMapData.json; builder-created maps resolve from the saved-maps store.

export interface MapRegistry {
  worlds: { id: number; name: string; mapIds: string[] }[];
}

const REGISTRY_KEY = 'coin_map_registry';

const DEFAULT_REGISTRY: MapRegistry = {
  worlds: [
    { id: 1, name: 'Grasslands', mapIds: ['w1m1', 'w1m2'] },
    { id: 2, name: 'Highlands',  mapIds: ['w2m1', 'w2m2'] },
  ],
};

export function loadMapRegistry(): MapRegistry {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MapRegistry;
      if (Array.isArray(parsed.worlds) && parsed.worlds.length > 0) return parsed;
    }
  } catch { /* corrupt or unavailable — fall through to default */ }
  return structuredClone(DEFAULT_REGISTRY);
}

export function saveMapRegistry(reg: MapRegistry): void {
  try { localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg)); }
  catch { /* localStorage full or unavailable */ }
}

/**
 * Resolve a map's BASE definition by id: baked defaults first, then
 * builder-created maps in the saved-maps store. Callers still apply
 * loadMapWithOverride so localStorage edits win for baked maps too.
 */
export function resolveMapById(id: string): MapDefinition | null {
  const baked = RAW_MAPS.find(m => m.id === id);
  if (baked) return baked;
  const stored = loadStoredMaps()[id];
  return stored ? migrateStoredMap(stored) : null;
}

/** Append a map id to a world's ordered list (no-op if already registered). */
export function registerMapInWorld(id: string, worldId: number): void {
  const reg = loadMapRegistry();
  if (reg.worlds.some(w => w.mapIds.includes(id))) return;
  let world = reg.worlds.find(w => w.id === worldId);
  if (!world) {
    world = { id: worldId, name: `World ${worldId}`, mapIds: [] };
    reg.worlds.push(world);
    reg.worlds.sort((a, b) => a.id - b.id);
  }
  world.mapIds.push(id);
  saveMapRegistry(reg);
}

/** Move a map one slot up (-1) or down (+1) within its world. */
export function moveMapInWorld(id: string, dir: -1 | 1): boolean {
  const reg = loadMapRegistry();
  for (const w of reg.worlds) {
    const i = w.mapIds.indexOf(id);
    if (i === -1) continue;
    const j = i + dir;
    if (j < 0 || j >= w.mapIds.length) return false;
    [w.mapIds[i], w.mapIds[j]] = [w.mapIds[j], w.mapIds[i]];
    saveMapRegistry(reg);
    return true;
  }
  return false;
}

/**
 * Build the campaign structure from the registry, dropping ids that no longer
 * resolve. Falls back to the baked two-world layout if the registry yields
 * nothing usable.
 */
export function buildWorlds(): WorldDef[] {
  const worlds: WorldDef[] = [];
  for (const w of loadMapRegistry().worlds) {
    const maps = w.mapIds
      .map(id => resolveMapById(id))
      .filter((m): m is MapDefinition => m !== null);
    if (maps.length > 0) worlds.push({ id: w.id, name: w.name, maps });
  }
  if (worlds.length === 0) {
    return [
      { id: 1, name: 'Grasslands', maps: [mapById('w1m1'), mapById('w1m2')] },
      { id: 2, name: 'Highlands',  maps: [mapById('w2m1'), mapById('w2m2')] },
    ];
  }
  return worlds;
}

// ── Campaign structure ────────────────────────────────────────────────────────
// Computed once per page load from the registry. The map builder mutates the
// registry live and re-reads via buildWorlds(); the game picks changes up on
// refresh (same model as saved map edits).

export const WORLDS: WorldDef[] = buildWorlds();

/** Flat ordered list of all maps — first world's first map first. */
export const ALL_MAPS: MapDefinition[] = WORLDS.flatMap(w => [...w.maps]);

/**
 * Canonical first map. Game.ts and the map builder default to this —
 * the first map in campaign order.
 */
export const DEFAULT_MAP: MapDefinition = ALL_MAPS[0] ?? mapById('w1m1');

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

/** Thrown by {@link saveMapToStorage} when the map set no longer fits in localStorage. */
export class MapStorageQuotaError extends Error {
  constructor(public readonly bytes: number) {
    super(`Map data is ${(bytes / 1048576).toFixed(1)} MB — too large for browser storage (~5 MB limit).`);
    this.name = 'MapStorageQuotaError';
  }
}

/**
 * Persist a map by id so the game picks it up on next load.
 *
 * Throws {@link MapStorageQuotaError} when the serialised map set exceeds the
 * browser localStorage quota (~5 MB) — almost always an oversized embedded
 * background/ground PNG. The write is all-or-nothing, so a quota failure means
 * NOTHING was saved: the builder would keep showing the in-memory image while
 * the game still loads the unmodified map. Callers must surface the error.
 */
export function saveMapToStorage(map: MapDefinition): void {
  const all = loadStoredMaps();
  all[map.id] = map;
  const json = JSON.stringify(all);
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
      throw new MapStorageQuotaError(json.length);
    }
    throw e;
  }
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
