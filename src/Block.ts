import * as PIXI from 'pixi.js';
import type { PlatformData } from './Platform';

export type BlockData = PlatformData;

export class Block {
  readonly data:      BlockData;
  readonly container: PIXI.Container;
  private  gfx:      PIXI.Graphics;

  constructor(data: BlockData) {
    this.data      = data;
    this.container = new PIXI.Container();
    this.gfx       = this.draw();

    if (data.skin) {
      PIXI.Assets.load<PIXI.Texture>(data.skin)
        .then(tex => {
          this.gfx.visible  = false;
          const sprite      = new PIXI.Sprite(tex);
          sprite.x          = data.x;
          sprite.y          = data.y;
          sprite.width      = data.width;
          sprite.height     = data.height;
          this.container.addChildAt(sprite, 0);
        })
        .catch(() => { /* keep Graphics fallback */ });
    }
  }

  private draw(): PIXI.Graphics {
    const { x, y, width: w, height: h } = this.data;
    const g = new PIXI.Graphics();

    // Drop shadow
    g.beginFill(0x000000, 0.28);
    g.drawRect(x + 4, y + h, w - 2, 7);
    g.endFill();

    // Main stone body
    g.beginFill(0x6b7280);
    g.drawRect(x, y, w, h);
    g.endFill();

    // Top surface highlight
    g.beginFill(0x9ca3af, 0.55);
    g.drawRect(x + 1, y + 1, w - 2, 5);
    g.endFill();

    // Bottom edge shadow
    g.beginFill(0x374151, 0.55);
    g.drawRect(x + 1, y + h - 5, w - 2, 4);
    g.endFill();

    // Brick mortar lines
    g.lineStyle(1, 0x4b5563, 0.55);
    const brickH = Math.max(8, Math.round(h / 2));
    // Horizontal mortar
    for (let by = brickH; by < h - 1; by += brickH) {
      g.moveTo(x + 1, y + by);
      g.lineTo(x + w - 1, y + by);
    }
    // Vertical mortar (staggered per row)
    const brickW = 44;
    for (let row = 0; row * brickH < h; row++) {
      const offset = row % 2 === 0 ? brickW * 0.5 : 0;
      for (let bx = offset; bx < w; bx += brickW) {
        const rowTop = y + row * brickH;
        const rowBot = Math.min(y + (row + 1) * brickH, y + h);
        g.moveTo(x + bx, rowTop + 1);
        g.lineTo(x + bx, rowBot - 1);
      }
    }
    g.lineStyle(0);

    // Outer border
    g.lineStyle(2, 0x374151, 0.95);
    g.drawRect(x, y, w, h);
    g.lineStyle(0);

    this.container.addChild(g);
    return g;
  }
}
