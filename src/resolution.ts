import { VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from './constants';
import { isTouchDevice } from './mobile';

/**
 * Render-resolution setting. The logical viewport is fixed (VIEWPORT_HEIGHT
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
  { label: '1920 × 1200', height: 1200 },
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

/**
 * Device pixels per logical px that the screen can actually show: the
 * scale-to-fit factor for the logical frame on this screen, times the DPR.
 * Uses `screen` (not the window) so a URL bar or a portrait moment at load
 * does not bake a too-small value in; landscape is assumed since the game
 * refuses to run in portrait.
 */
function displayScale(): number {
  const long  = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  return (window.devicePixelRatio || 1) * Math.min(long / VIEWPORT_WIDTH, short / VIEWPORT_HEIGHT);
}

/**
 * PIXI renderer resolution (backing-store px per logical px): selected
 * vertical resolution ÷ the logical viewport height.
 *
 * Touch devices are capped at displayScale(): a phone shows the frame at
 * ~0.4× in CSS px, so a 1440p backing store is mostly discarded on the way
 * to the screen — yet this value also sizes every sprite atlas and fitted
 * skin (SpriteRegistry.atlasScaleFor, SkinTextures), so the waste is paid
 * in memory, not just fill rate. Desktop is left alone: there the setting
 * doubles as supersampling and the player chose it.
 */
export function getRenderScale(): number {
  const fromSetting = getResolutionHeight() / VIEWPORT_HEIGHT;
  return isTouchDevice ? Math.min(fromSetting, displayScale()) : fromSetting;
}
