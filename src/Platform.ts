import * as PIXI from 'pixi.js';

export interface PlatformData {
  x:      number;  // left edge
  y:      number;  // top surface y
  width:  number;
  height: number;
}

export class Platform {
  readonly data:      PlatformData;
  readonly container: PIXI.Container;

  constructor(data: PlatformData) {
    this.data      = data;
    this.container = new PIXI.Container();
    this.draw();
  }

  private draw() {
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
  }
}
