import * as PIXI from 'pixi.js';
import type { PlatformData } from './Platform';

/** Optional ping-pong animation between (data.x, data.y) and (anim.endX, anim.endY). */
export interface BlockAnim {
  endX:  number;   // other endpoint, world-space px
  endY:  number;
  speed: number;   // travel speed in px/s (along the start→end segment)
}

export interface BlockData extends PlatformData {
  anim?: BlockAnim;
}

export class Block {
  /**
   * Per-instance copy of the source map data. data.x and data.y are mutated
   * during animation to reflect the block's current position, so consumers
   * that read blockData (Character.syncFromBody, Coin.update, Projectile, …)
   * see the live position without any extra plumbing. The original map
   * definition object is left untouched.
   */
  readonly data:      BlockData;
  readonly container: PIXI.Container;
  private  gfx:       PIXI.Graphics;

  // Animation segment origin — captured at construction because data.x/data.y
  // drift away from the source position as the block moves.
  private readonly startX: number;
  private readonly startY: number;
  // 0..1 position along the start→end segment; ping-pongs via `dir`.
  private phase = 0;
  private dir:   1 | -1 = 1;

  constructor(data: BlockData) {
    // Shallow-copy so animation never mutates the underlying map definition.
    this.data = { ...data, anim: data.anim ? { ...data.anim } : undefined };
    this.startX = this.data.x;
    this.startY = this.data.y;

    this.container   = new PIXI.Container();
    this.container.x = this.data.x;
    this.container.y = this.data.y;
    this.gfx         = this.draw();

    if (data.skin) {
      PIXI.Assets.load<PIXI.Texture>(data.skin)
        .then(tex => {
          this.gfx.visible = false;
          const sprite     = new PIXI.Sprite(tex);
          // Drawn at container origin — the container is positioned at the
          // block's current world coords, so the sprite tracks animation.
          sprite.x      = 0;
          sprite.y      = 0;
          sprite.width  = this.data.width;
          sprite.height = this.data.height;
          this.container.addChildAt(sprite, 0);
        })
        .catch(() => { /* keep Graphics fallback */ });
    }
  }

  /**
   * Advance the ping-pong animation by `dt` seconds. Mutates data.x/data.y +
   * container position. Returns the (dx, dy) the block moved this tick so the
   * caller can carry any character standing on top and sync the physics body.
   * Static blocks (no `anim`) return zero delta.
   */
  update(dt: number): { dx: number; dy: number } {
    if (!this.data.anim) return { dx: 0, dy: 0 };
    const { endX, endY, speed } = this.data.anim;
    const segLen = Math.hypot(endX - this.startX, endY - this.startY);
    if (segLen < 0.001 || speed <= 0) return { dx: 0, dy: 0 };

    this.phase += this.dir * (speed * dt) / segLen;
    if (this.phase >= 1)      { this.phase = Math.max(0, 2 - this.phase); this.dir = -1; }
    else if (this.phase <= 0) { this.phase = Math.min(1, -this.phase);    this.dir =  1; }

    const oldX = this.data.x;
    const oldY = this.data.y;
    this.data.x = this.startX + (endX - this.startX) * this.phase;
    this.data.y = this.startY + (endY - this.startY) * this.phase;
    this.container.x = this.data.x;
    this.container.y = this.data.y;
    return { dx: this.data.x - oldX, dy: this.data.y - oldY };
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  // All shapes are drawn at (0, 0); the container is positioned absolutely.

  private draw(): PIXI.Graphics {
    const { width: w, height: h } = this.data;
    const g = new PIXI.Graphics();

    // Drop shadow
    g.beginFill(0x000000, 0.28);
    g.drawRect(4, h, w - 2, 7);
    g.endFill();

    // Main stone body
    g.beginFill(0x6b7280);
    g.drawRect(0, 0, w, h);
    g.endFill();

    // Top surface highlight
    g.beginFill(0x9ca3af, 0.55);
    g.drawRect(1, 1, w - 2, 5);
    g.endFill();

    // Bottom edge shadow
    g.beginFill(0x374151, 0.55);
    g.drawRect(1, h - 5, w - 2, 4);
    g.endFill();

    // Brick mortar lines
    g.lineStyle(1, 0x4b5563, 0.55);
    const brickH = Math.max(8, Math.round(h / 2));
    for (let by = brickH; by < h - 1; by += brickH) {
      g.moveTo(1, by);
      g.lineTo(w - 1, by);
    }
    const brickW = 44;
    for (let row = 0; row * brickH < h; row++) {
      const offset = row % 2 === 0 ? brickW * 0.5 : 0;
      for (let bx = offset; bx < w; bx += brickW) {
        const rowTop = row * brickH;
        const rowBot = Math.min((row + 1) * brickH, h);
        g.moveTo(bx, rowTop + 1);
        g.lineTo(bx, rowBot - 1);
      }
    }
    g.lineStyle(0);

    // Outer border
    g.lineStyle(2, 0x374151, 0.95);
    g.drawRect(0, 0, w, h);
    g.lineStyle(0);

    this.container.addChild(g);
    return g;
  }
}
