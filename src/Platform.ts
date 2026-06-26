import * as PIXI from 'pixi.js';

/** Optional ping-pong animation between (data.x, data.y) and (anim.endX, anim.endY). */
export interface PlatformAnim {
  endX:  number;
  endY:  number;
  speed: number;   // px/s along the start→end segment
}

export interface PlatformData {
  id?:     string;  // stable identifier assigned by map builder
  x:       number;  // left edge
  y:       number;  // top surface y
  width:   number;
  height:  number;
  zIndex?: number;  // render order among platforms; higher = in front (default 0)
  skin?:   string;  // data URL (data:image/...;base64,…)
  skinTileW?: number;  // tile width  in world px — when set, skin is tiled instead of stretched (default: stretch to width)
  skinTileH?: number;  // tile height in world px — when set, skin is tiled instead of stretched (default: stretch to height)
  anim?:   PlatformAnim;
}

// Slight rounding applied to the two TOP corners of every platform (bottom stays
// square so platforms still read as resting flat). Mirrored in map-builder.ts.
const PLATFORM_TOP_RADIUS = 8;

/** A white mask Graphics shaped like the platform but with only the TOP corners
 *  rounded. `extra` extends the square bottom past `height` so drop shadows drawn
 *  below the surface survive the mask. */
function makeRoundedTopMask(width: number, height: number, extra = 0): PIXI.Graphics {
  const r = Math.max(0, Math.min(PLATFORM_TOP_RADIUS, width / 2, height));
  const g = new PIXI.Graphics();
  g.beginFill(0xffffff);
  g.moveTo(0, height + extra);
  g.lineTo(0, r);
  g.arcTo(0, 0, r, 0, r);
  g.lineTo(width - r, 0);
  g.arcTo(width, 0, width, r, r);
  g.lineTo(width, height + extra);
  g.closePath();
  g.endFill();
  return g;
}

export class Platform {
  /**
   * Per-instance copy of the source map data. data.x and data.y are mutated
   * during animation to reflect the platform's current position so consumers
   * that read platformData (Character.syncFromBody, Coin.update, …) see the
   * live position with no extra plumbing.
   */
  readonly data:      PlatformData;
  readonly container: PIXI.Container;
  private  gfx:       PIXI.Graphics;

  private readonly startX: number;
  private readonly startY: number;
  private phase = 0;
  private dir:   1 | -1 = 1;

  constructor(data: PlatformData) {
    this.data = { ...data, anim: data.anim ? { ...data.anim } : undefined };
    this.startX = this.data.x;
    this.startY = this.data.y;

    this.container        = new PIXI.Container();
    this.container.zIndex = this.data.zIndex ?? 0;
    this.container.x      = this.data.x;
    this.container.y      = this.data.y;
    this.gfx              = this.draw();

    if (data.skin) {
      const { skinTileW, skinTileH } = this.data;
      PIXI.Assets.load<PIXI.Texture>(data.skin)
        .then(tex => {
          this.gfx.visible = false;
          let layer: PIXI.Sprite | PIXI.TilingSprite;
          if (skinTileW !== undefined || skinTileH !== undefined) {
            // Tiled skin: repeat the image across the platform instead of stretching.
            const ts = new PIXI.TilingSprite(tex, this.data.width, this.data.height);
            ts.x = 0;
            ts.y = 0;
            if (skinTileW !== undefined) ts.tileScale.x = skinTileW / tex.width;
            if (skinTileH !== undefined) ts.tileScale.y = skinTileH / tex.height;
            layer = ts;
          } else {
            const sprite  = new PIXI.Sprite(tex);
            sprite.x      = 0;
            sprite.y      = 0;
            sprite.width  = this.data.width;
            sprite.height = this.data.height;
            layer = sprite;
          }
          this.container.addChildAt(layer, 0);
          // Round the top corners by clipping the skin to a rounded-top mask.
          const mask = makeRoundedTopMask(this.data.width, this.data.height);
          this.container.addChild(mask);
          layer.mask = mask;
        })
        .catch(() => { /* keep Graphics fallback */ });
    }
  }

  /** Advance ping-pong animation by `dt` seconds, return (dx, dy) for the
   *  caller to sync the physics body and carry standers on top. */
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
    const { width, height } = this.data;
    const g = new PIXI.Graphics();

    // Drop shadow beneath
    g.beginFill(0x000000, 0.25);
    g.drawRoundedRect(3, height, width - 3, 7, 2);
    g.endFill();

    // Main plank body
    g.beginFill(0x8B5E3C);
    g.drawRoundedRect(0, 0, width, height, 3);
    g.endFill();

    // Top-surface highlight
    g.beginFill(0xC4894A, 0.65);
    g.drawRect(3, 1, width - 6, 4);
    g.endFill();

    // Plank-join lines
    g.lineStyle(1, 0x5c3322, 0.45);
    for (let px = 45; px < width - 4; px += 45) {
      g.moveTo(px, 2);
      g.lineTo(px, height - 2);
    }
    g.lineStyle(0);

    // Left & right end-caps (darker wood grain)
    g.beginFill(0x6B4226, 0.6);
    g.drawRoundedRect(0, 0, 5, height, 2);
    g.drawRoundedRect(width - 5, 0, 5, height, 2);
    g.endFill();

    this.container.addChild(g);
    // Clip the top corners round. The mask extends past the bottom so the drop
    // shadow (drawn below `height`) is preserved.
    const mask = makeRoundedTopMask(width, height, 8);
    this.container.addChild(mask);
    g.mask = mask;
    return g;
  }
}
