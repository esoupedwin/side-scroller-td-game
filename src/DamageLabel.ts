import * as PIXI from 'pixi.js';
import { DMG_LABEL_LIFETIME, DMG_LABEL_RISE, DMG_LABEL_FONT_SIZE, DMG_LABEL_STROKE, GAME_ZOOM } from './constants';
import { getRenderScale } from './resolution';

// Damage numbers are BitmapText, not PIXI.Text. A PIXI.Text rasterises its
// string onto a fresh canvas and uploads it as a new GPU texture on first
// render, then frees both about a second later — once per hit. In a busy
// fight that is tens of canvas draws, texImage2D uploads and texture destroys
// per second, visible in profiles as texture churn and GC. A bitmap font
// rasterises each glyph once; every label after that is a few quads from the
// shared atlas, and its colour is a per-label tint.
const FONT_NAME = 'coin-damage';
let fontReady = false;

function ensureFont(): void {
  if (fontReady) return;
  fontReady = true;
  PIXI.BitmapFont.from(FONT_NAME, {
    fontSize:        DMG_LABEL_FONT_SIZE,
    fontWeight:      'bold',
    fontFamily:      'Segoe UI, sans-serif',
    fill:            0xffffff,   // white, so `tint` gives the per-label colour …
    stroke:          0x000000,   // … while the black outline stays black under any tint
    strokeThickness: DMG_LABEL_STROKE,
  }, {
    // Digits plus the words the game floats ("Missed", "Blocked", rank names).
    chars:      [...PIXI.BitmapFont.ALPHANUMERIC, '+-!?.%×'],
    // Glyphs are rasterised at this multiple of the font size so they stay
    // crisp under the world zoom and a supersampled backing store.
    resolution: Math.min(4, Math.max(1, Math.ceil(GAME_ZOOM * getRenderScale()))),
    padding:    DMG_LABEL_STROKE + 2,
  });
}

export class DamageLabel {
  readonly container: PIXI.Container;
  isDead = false;

  private elapsed = 0;
  private startY:  number;

  constructor(x: number, y: number, amount: number, color: number, label?: string) {
    ensureFont();
    this.startY    = y;
    this.container = new PIXI.Container();

    const text = new PIXI.BitmapText(label ?? String(Math.round(amount)), { fontName: FONT_NAME, fontSize: DMG_LABEL_FONT_SIZE, tint: color });
    text.anchor.set(0.5, 1);
    this.container.addChild(text);
    this.container.x = x;
    this.container.y = y;
  }

  update(dt: number) {
    this.elapsed += dt;
    const t = Math.min(this.elapsed / DMG_LABEL_LIFETIME, 1);

    // Ease-out rise: fast at start, slows near top
    this.container.y = this.startY - DMG_LABEL_RISE * (1 - (1 - t) * (1 - t));

    // Fade: stay opaque for first 40 %, then fade out
    this.container.alpha = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;

    if (this.elapsed >= DMG_LABEL_LIFETIME) this.isDead = true;
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
