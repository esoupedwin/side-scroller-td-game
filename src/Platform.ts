import * as PIXI from 'pixi.js';

export interface PlatformData {
  id?:     string;  // stable identifier assigned by map builder
  x:       number;  // left edge
  y:       number;  // top surface y
  width:   number;
  height:  number;
  zIndex?: number;  // render order among platforms; higher = in front (default 0)
  skin?:   string;  // data URL (data:image/...;base64,…)
}

export class Platform {
  readonly data:      PlatformData;
  readonly container: PIXI.Container;
  private  gfx:      PIXI.Graphics;

  constructor(data: PlatformData) {
    this.data             = data;
    this.container        = new PIXI.Container();
    this.container.zIndex = data.zIndex ?? 0;
    this.gfx              = this.draw();

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
    const { x, y, width, height } = this.data;
    const g = new PIXI.Graphics();

    // Drop shadow beneath
    g.beginFill(0x000000, 0.25);
    g.drawRoundedRect(x + 3, y + height, width - 3, 7, 2);
    g.endFill();

    // Main plank body
    g.beginFill(0x8B5E3C);
    g.drawRoundedRect(x, y, width, height, 3);
    g.endFill();

    // Top-surface highlight
    g.beginFill(0xC4894A, 0.65);
    g.drawRect(x + 3, y + 1, width - 6, 4);
    g.endFill();

    // Plank-join lines
    g.lineStyle(1, 0x5c3322, 0.45);
    for (let px = x + 45; px < x + width - 4; px += 45) {
      g.moveTo(px, y + 2);
      g.lineTo(px, y + height - 2);
    }
    g.lineStyle(0);

    // Left & right end-caps (darker wood grain)
    g.beginFill(0x6B4226, 0.6);
    g.drawRoundedRect(x, y, 5, height, 2);
    g.drawRoundedRect(x + width - 5, y, 5, height, 2);
    g.endFill();

    this.container.addChild(g);
    return g;
  }
}
