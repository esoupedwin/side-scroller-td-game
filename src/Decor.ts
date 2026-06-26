import * as PIXI from 'pixi.js';

/**
 * Sentinel z-index that puts a decor object IN FRONT of characters. Decor whose
 * `zIndex` is >= this value renders in a dedicated foreground layer above the
 * unit layer; any lower z sorts in the shared scene layer alongside platforms
 * and blocks (behind characters). The "Infront of Characters" toggle in the map
 * builder sets the decor's zIndex to exactly this value.
 */
export const DECOR_FRONT_Z = 999;

/**
 * A purely-decorative scene object (flower, rock, stone, …). Placed like a
 * platform/block but has NO physics body and is not part of the nav graph —
 * characters, coins, and projectiles pass straight through it. Its appearance
 * is driven entirely by a user-supplied PNG `skin`.
 */
export interface DecorData {
  id?:     string;  // stable identifier assigned by the map builder
  x:       number;  // left edge
  y:       number;  // top edge
  width:   number;
  height:  number;
  // Render order in the shared scene z-space (same space as platforms & blocks).
  // zIndex >= DECOR_FRONT_Z renders in front of characters; otherwise behind them.
  zIndex?: number;
  opacity?: number; // 0 (transparent) .. 1 (opaque); default 1
  skin?:   string;  // data URL (data:image/...;base64,…)
}

export class Decor {
  readonly data:      DecorData;
  readonly container: PIXI.Container;
  private  gfx:       PIXI.Graphics;

  constructor(data: DecorData) {
    this.data = { ...data };

    this.container        = new PIXI.Container();
    this.container.zIndex = this.data.zIndex ?? 0;
    this.container.alpha  = this.data.opacity ?? 1;
    this.container.x      = this.data.x;
    this.container.y      = this.data.y;
    this.gfx              = this.drawPlaceholder();

    if (data.skin) {
      // Same skin-load path as Platform: load the data URL into a Sprite sized
      // to the decor's box, hiding the placeholder once it arrives.
      PIXI.Assets.load<PIXI.Texture>(data.skin)
        .then(tex => {
          this.gfx.visible = false;
          const sprite     = new PIXI.Sprite(tex);
          sprite.x      = 0;
          sprite.y      = 0;
          sprite.width  = this.data.width;
          sprite.height = this.data.height;
          this.container.addChildAt(sprite, 0);
        })
        .catch(() => { /* keep the placeholder if the skin fails to load */ });
    }
  }

  // Faint placeholder shown only until/unless a skin is present — most decor
  // carries a skin, so this is mainly a "missing art" affordance.
  private drawPlaceholder(): PIXI.Graphics {
    const { width, height } = this.data;
    const g = new PIXI.Graphics();
    g.beginFill(0x000000, this.data.skin ? 0 : 0.12);
    g.drawRoundedRect(0, 0, width, height, 4);
    g.endFill();
    this.container.addChild(g);
    return g;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
