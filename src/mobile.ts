/**
 * Mobile / fullscreen support.
 *
 * Feature-detected, not UA-sniffed: "touch device" here means a coarse-pointer
 * screen with no hover, which is what actually changes how the game must
 * behave — no keyboard, browser chrome eating the viewport, portrait by
 * default. The one UA check (isIOS) exists because iOS is the platform where
 * the Fullscreen API is simply absent and needs a different story.
 *
 * Fullscreen splits by platform:
 * - Android Chrome (and every desktop browser): the Fullscreen API works from
 *   a user gesture, and once fullscreen the orientation can be locked.
 * - iOS — Safari AND Chrome, both are WebKit: no Fullscreen API on anything
 *   but <video>, and no orientation lock. The only chrome-less mode is
 *   launching from the home screen (web manifest + apple-mobile-web-app-capable
 *   in index.html), which shows up as display-mode: standalone/fullscreen.
 */

const coarseNoHover = matchMedia('(pointer: coarse) and (hover: none)').matches;

/** Phone / tablet class device: touch is the primary input and there is no keyboard to rely on. */
export const isTouchDevice: boolean = coarseNoHover && navigator.maxTouchPoints > 0;

/** iPhone / iPod / iPad, including iPadOS 13+ which reports itself as a Mac with touch points. */
export const isIOS: boolean =
  /iP(hone|od|ad)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Launched from the home screen (PWA) — already chrome-less, no fullscreen needed. */
export const isStandalone: boolean =
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: fullscreen)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

type FullscreenDoc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const doc = document as FullscreenDoc;

/** Whether the page can go fullscreen at all. False on iPhone. */
export const canFullscreen: boolean = doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true;

export function isFullscreen(): boolean {
  return !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

/**
 * Go fullscreen and try to lock landscape. Must be called from a user gesture
 * (tap/click) or the browser rejects it. Resolves false when unsupported or
 * refused; nothing else changes in that case, so callers can fire-and-forget.
 */
export async function enterFullscreen(): Promise<boolean> {
  if (isFullscreen()) return true;
  const el = document.documentElement as FullscreenEl;
  try {
    if (el.requestFullscreen)            await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    else return false;
  } catch {
    return false;
  }
  // Orientation lock is only honoured while fullscreen (and never on iOS) —
  // best effort. lock() is not in lib.dom on every TS version, hence the cast.
  try {
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch { /* unsupported, or the device refused — the CSS rotate overlay covers portrait */ }
  return true;
}

export async function exitFullscreen(): Promise<void> {
  if (!isFullscreen()) return;
  try {
    if (doc.exitFullscreen)            await doc.exitFullscreen();
    else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
  } catch { /* already gone */ }
}

/** Fires on both the standard and the webkit-prefixed event. */
export function onFullscreenChange(cb: () => void): void {
  document.addEventListener('fullscreenchange', cb);
  document.addEventListener('webkitfullscreenchange', cb);
}
