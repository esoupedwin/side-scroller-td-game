import type { Tribe } from './Tribes';

/**
 * Per-tribe tower visuals. Shared across all maps — the map only stores
 * tower POSITIONS and a default tribe per placeholder; the actual skin/W/H
 * comes from whichever tribe ends up on that side at runtime.
 *
 * `skin` is a data URL (the map-builder modal uses FileReader.readAsDataURL
 * to capture the upload). `w` / `h` are the rendered tower dimensions in
 * world space; both fall back to TOWER_WIDTH / TOWER_HEIGHT when unset.
 *
 * `collision` and `spawn` are stored in **skin-local pixel coordinates** —
 * origin at the top-left of the rendered skin (so x ranges 0..w, y ranges
 * 0..h, with y growing downward). The convention assumes an east-facing
 * skin; the enemy side mirrors them at runtime to match its flipped sprite.
 *  - `collision` = solid bounding rect. The runtime physics body uses the
 *    horizontal extent only (towers stay full-height walls).
 *  - `spawn` = where this tribe's units appear when spawned at its tower.
 */
export interface TowerTemplate {
  skin?:      string;
  w?:         number;
  h?:         number;
  collision?: { x: number; y: number; w: number; h: number };
  spawn?:     { x: number; y: number };
}

const KEY = 'coin_tribe_tower_templates';

const cache: Record<Tribe, TowerTemplate> = {
  kattgard: {},
  lapinor: {},
};

export function loadTemplates(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Record<Tribe, TowerTemplate>>;
    for (const tribe of Object.keys(cache) as Tribe[]) {
      const tpl = parsed[tribe];
      if (tpl && typeof tpl === 'object') cache[tribe] = { ...tpl };
    }
  } catch {
    // Corrupt JSON — ignore; keep the empty cache so the game still runs.
  }
}

export function saveTemplates(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // localStorage may be full or unavailable; nothing to fall back to.
  }
}

export function getTowerTemplate(t: Tribe): TowerTemplate {
  return cache[t];
}

export function setTowerTemplate(t: Tribe, tpl: TowerTemplate): void {
  // Wholesale replace, not merge — the modal's Save path passes a full draft
  // and expects cleared fields (e.g. a removed skin) to actually disappear.
  cache[t] = { ...tpl };
  saveTemplates();
}

export function exportTemplatesJson(): string {
  return JSON.stringify(cache, null, 2);
}

export function importTemplatesJson(json: string): void {
  const parsed = JSON.parse(json) as Partial<Record<Tribe, TowerTemplate>>;
  for (const tribe of Object.keys(cache) as Tribe[]) {
    const tpl = parsed[tribe];
    if (tpl && typeof tpl === 'object') cache[tribe] = { ...tpl };
  }
  saveTemplates();
}
