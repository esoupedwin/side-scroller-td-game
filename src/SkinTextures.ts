import * as PIXI from 'pixi.js';
import { GAME_ZOOM } from './constants';
import { getRenderScale } from './resolution';

/**
 * Skin textures fitted to their rendered size.
 *
 * Map skins (data URLs from the builder) and the stock PNGs are authored far
 * larger than they are ever drawn — a 955-px coin renders 22 px tall, a
 * 2381-px tower template ~800 device px — and a decoded texture costs
 * width × height × 4 bytes for as long as it is cached. `loadFittedTexture`
 * decodes once through `Assets`, shrinks the image to the largest size the
 * current render resolution can actually show (plus SKIN_FIT_HEADROOM), keeps
 * that per URL, and unloads the full-size decode. Images already at or below
 * the target stay in the `Assets` cache untouched.
 *
 * `Game.reset()` evicts a map's skins through `unloadSkinTextures`, which
 * covers both the fitted copies and the pass-through `Assets` entries.
 */
const SKIN_FIT_HEADROOM = 1.25;   // texels per device pixel kept before shrinking

const fitted = new Map<string, Promise<PIXI.Texture>>();

/**
 * @param logicalW/H  Size the skin is drawn at, in the space `worldSpace` names:
 *                    world px (scaled by GAME_ZOOM) or screen px (parallax layers).
 */
export function loadFittedTexture(
  url: string, logicalW: number, logicalH: number, worldSpace = true,
): Promise<PIXI.Texture> {
  const cached = fitted.get(url);
  if (cached) return cached;

  const deviceScale = (worldSpace ? GAME_ZOOM : 1) * getRenderScale() * SKIN_FIT_HEADROOM;
  const targetW = Math.ceil(logicalW * deviceScale);
  const targetH = Math.ceil(logicalH * deviceScale);

  const task = (async () => {
    const tex = await PIXI.Assets.load<PIXI.Texture>(url);
    const ratio = Math.min(targetW / tex.width, targetH / tex.height);
    if (ratio >= 1) return tex;   // not oversampled — keep the Assets entry as-is

    const source = (tex.baseTexture.resource as { source?: CanvasImageSource }).source;
    if (!source) return tex;
    const w = Math.max(1, Math.round(tex.width  * ratio));
    const h = Math.max(1, Math.round(tex.height * ratio));
    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return tex;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, tex.width, tex.height, 0, 0, w, h);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(canvas);
    } finally {
      canvas.width = canvas.height = 0;
    }
    const base = new PIXI.BaseTexture(new PIXI.ImageBitmapResource(bitmap, { ownsImageBitmap: true }), {
      scaleMode: tex.baseTexture.scaleMode,
    });
    await PIXI.Assets.unload(url).catch(() => {});   // drop the full-size decode
    return new PIXI.Texture(base);
  })();
  fitted.set(url, task);
  task.catch(() => fitted.delete(url));   // let a failed load be retried later
  return task;
}

/** Free the textures behind `urls` — fitted copies (bitmap closed) and plain
 *  Assets entries alike. Callers ensure nothing on stage still uses them. */
export async function unloadSkinTextures(urls: Iterable<string>): Promise<void> {
  const plain: string[] = [];
  for (const url of urls) {
    const pending = fitted.get(url);
    fitted.delete(url);
    if (pending) {
      const tex = await pending.catch(() => null);
      // A fitted texture owns its base; a pass-through one is still Assets'.
      if (tex && !PIXI.Assets.cache.has(url)) { tex.destroy(true); continue; }
    }
    plain.push(url);
  }
  if (plain.length > 0) await PIXI.Assets.unload(plain).catch(() => {});
}
