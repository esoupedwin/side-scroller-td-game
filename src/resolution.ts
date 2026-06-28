import { GAME_HEIGHT } from './constants';

/**
 * Render-resolution setting. The game's logical layout is fixed (GAME_HEIGHT
 * tall); this only controls the PIXI renderer's backing-store density, so a
 * higher setting renders crisper without changing what's visible or the
 * canvas's displayed size (the HTML UI overlays stay aligned).
 */
export interface ResolutionOption {
  label:  string;   // shown in the menu, e.g. '2560 × 1440'
  height: number;   // vertical resolution that drives the render scale
}

// Listed high → low, matching the requested options.
export const RESOLUTIONS: readonly ResolutionOption[] = [
  { label: '3840 × 2160', height: 2160 },
  { label: '2560 × 1440', height: 1440 },
  { label: '1920 × 1080', height: 1080 },
];

const STORAGE_KEY    = 'coin_resolution_height';
const DEFAULT_HEIGHT = 1440;

/** Currently selected vertical resolution (defaults to 1440, validated against the list). */
export function getResolutionHeight(): number {
  try {
    const stored = parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10);
    if (RESOLUTIONS.some(r => r.height === stored)) return stored;
  } catch { /* localStorage unavailable — fall through to default */ }
  return DEFAULT_HEIGHT;
}

export function setResolutionHeight(height: number): void {
  try { localStorage.setItem(STORAGE_KEY, String(height)); } catch { /* ignore */ }
}

/** PIXI renderer resolution (backing-store px per logical px): selected
 *  vertical resolution ÷ the game's logical height. */
export function getRenderScale(): number {
  return getResolutionHeight() / GAME_HEIGHT;
}
