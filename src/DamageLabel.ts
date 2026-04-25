import * as PIXI from 'pixi.js';
import { DMG_LABEL_LIFETIME, DMG_LABEL_RISE } from './constants';

export class DamageLabel {
  readonly container: PIXI.Container;
  isDead = false;

  private elapsed = 0;
  private startY:  number;

  constructor(x: number, y: number, amount: number, color: number, label?: string) {
    this.startY    = y;
    this.container = new PIXI.Container();

    const text = new PIXI.Text(label ?? String(Math.round(amount)), {
      fontSize:        13,
      fontWeight:      'bold',
      fontFamily:      'Segoe UI, sans-serif',
      fill:            color,
      stroke:          0x000000,
      strokeThickness: 3,
      dropShadow:      false,
    });
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
