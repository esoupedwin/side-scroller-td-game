import * as PIXI from 'pixi.js';
import {
  GAME_HEIGHT, GROUND_Y,
  TOWER_WIDTH, TOWER_ATTACK_RANGE,
  PLAYER_COLOR, ENEMY_COLOR,
} from './constants';
import type { CoinBoxDef } from './maps';

export function buildBackground(stage: PIXI.Container, worldWidth: number) {
  const g = new PIXI.Graphics();

  // Clouds — soft white puffs scattered across the upper half of the sky.
  // Each cloud is a cluster of overlapping circles.
  const rng = mulberry32(42);
  const cloudCount = Math.max(8, Math.round(worldWidth / 280));
  for (let i = 0; i < cloudCount; i++) {
    const cx       = rng() * worldWidth;
    const cy       = 40 + rng() * (GROUND_Y * 0.55 - 40);
    const baseR    = 18 + rng() * 14;
    const puffs    = 4 + Math.floor(rng() * 3);
    g.beginFill(0xffffff, 0.85);
    for (let p = 0; p < puffs; p++) {
      const ox = (rng() - 0.5) * baseR * 2.2;
      const oy = (rng() - 0.5) * baseR * 0.6;
      const r  = baseR * (0.7 + rng() * 0.5);
      g.drawCircle(cx + ox, cy + oy, r);
    }
    g.endFill();
  }

  stage.addChild(g);
}

/** Ground plane — must be added to stage LAST so it renders above all game objects. */
export function buildGround(stage: PIXI.Container, worldWidth: number, groundSkin?: string, groundSkinTileW?: number, groundSkinTileH?: number) {
  const g = new PIXI.Graphics();
  g.beginFill(0x4a7c59);
  g.drawRect(0, GROUND_Y, worldWidth, GAME_HEIGHT - GROUND_Y);
  g.endFill();
  g.beginFill(0x3d6b4a);
  g.drawRect(0, GROUND_Y, worldWidth, 6);
  g.endFill();
  stage.addChild(g);

  if (groundSkin) {
    PIXI.Assets.load<PIXI.Texture>(groundSkin)
      .then(tex => {
        const ts = new PIXI.TilingSprite(tex, worldWidth, GAME_HEIGHT - GROUND_Y);
        ts.x = 0;
        ts.y = GROUND_Y;
        if (groundSkinTileW !== undefined) ts.tileScale.x = groundSkinTileW / tex.width;
        if (groundSkinTileH !== undefined) ts.tileScale.y = groundSkinTileH / tex.height;
        stage.addChild(ts);
      })
      .catch(() => { /* keep Graphics fallback */ });
  }
}

export function buildTowerRangeMarkers(
  stage: PIXI.Container,
  playerTowerX: number,
  enemyTowerX: number,
): PIXI.Container {
  const playerFrontX = playerTowerX + TOWER_WIDTH / 2;
  const enemyFrontX  = enemyTowerX  - TOWER_WIDTH / 2;
  const playerRangeX = playerFrontX + TOWER_ATTACK_RANGE;
  const enemyRangeX  = enemyFrontX  - TOWER_ATTACK_RANGE;
  const lineH = 30;

  const container = new PIXI.Container();

  const g = new PIXI.Graphics();

  // Player (blue) ground strip
  g.beginFill(PLAYER_COLOR, 0.35);
  g.drawRect(playerFrontX, GROUND_Y, TOWER_ATTACK_RANGE, 6);
  g.endFill();

  // Player boundary line + tick
  g.lineStyle(2, PLAYER_COLOR, 0.90);
  g.moveTo(playerRangeX, GROUND_Y + 6);
  g.lineTo(playerRangeX, GROUND_Y - lineH);
  g.moveTo(playerRangeX - 5, GROUND_Y - lineH);
  g.lineTo(playerRangeX + 5, GROUND_Y - lineH);

  // Enemy (red) ground strip
  g.lineStyle(0);
  g.beginFill(ENEMY_COLOR, 0.35);
  g.drawRect(enemyRangeX, GROUND_Y, TOWER_ATTACK_RANGE, 6);
  g.endFill();

  // Enemy boundary line + tick
  g.lineStyle(2, ENEMY_COLOR, 0.90);
  g.moveTo(enemyRangeX, GROUND_Y + 6);
  g.lineTo(enemyRangeX, GROUND_Y - lineH);
  g.moveTo(enemyRangeX - 5, GROUND_Y - lineH);
  g.lineTo(enemyRangeX + 5, GROUND_Y - lineH);

  container.addChild(g);

  const labelStyle = (color: number): Partial<PIXI.ITextStyle> => ({
    fontSize: 8, fill: color, fontWeight: 'bold',
  });

  const pLabel = new PIXI.Text('RANGE', labelStyle(PLAYER_COLOR));
  pLabel.anchor.set(0.5, 1);
  pLabel.x = playerRangeX;
  pLabel.y = GROUND_Y - lineH - 3;
  container.addChild(pLabel);

  const eLabel = new PIXI.Text('RANGE', labelStyle(ENEMY_COLOR));
  eLabel.anchor.set(0.5, 1);
  eLabel.x = enemyRangeX;
  eLabel.y = GROUND_Y - lineH - 3;
  container.addChild(eLabel);

  stage.addChild(container);
  return container;
}

export function buildCoinBox(world: PIXI.Container, coinBox: CoinBoxDef) {
  const { x, y, width: w, height: h } = coinBox;
  const g = new PIXI.Graphics();

  // Drop shadow
  g.beginFill(0x000000, 0.22);
  g.drawRect(x - w / 2 + 4, y + 4, w, h);
  g.endFill();

  // Main body
  g.beginFill(0xc8790a);
  g.drawRect(x - w / 2, y, w, h);
  g.endFill();

  // Top highlight band
  g.beginFill(0xf5a623, 0.65);
  g.drawRect(x - w / 2 + 3, y + 3, w - 6, h * 0.30);
  g.endFill();

  // Dark border
  g.lineStyle(3, 0x7a4a06);
  g.drawRect(x - w / 2, y, w, h);
  g.lineStyle(0);

  // Corner studs
  const cs = 9;
  g.beginFill(0x7a4a06, 0.55);
  g.drawRect(x - w / 2,       y,         cs, cs);
  g.drawRect(x + w / 2 - cs,  y,         cs, cs);
  g.drawRect(x - w / 2,       y + h - cs, cs, cs);
  g.drawRect(x + w / 2 - cs,  y + h - cs, cs, cs);
  g.endFill();

  world.addChild(g);

  // Star icon centred in the box
  const cx = x;
  const cy = y + h / 2;
  const outerR = 15, innerR = 6, points = 5;
  const starPts: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r     = i % 2 === 0 ? outerR : innerR;
    const angle = (i * Math.PI) / points - Math.PI / 2;
    starPts.push(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
  }
  g.lineStyle(4, 0x7a4a06, 1);
  g.beginFill(0xffffff);
  g.drawPolygon(starPts);
  g.endFill();
  g.lineStyle(0);
}

/**
 * Parallax mountain backdrop drawn in screen-space (on app.stage, not the world container).
 * drawWidth must be wide enough to cover the viewport at maximum camera offset:
 *   VIEWPORT_WIDTH + maxCameraX * parallaxFactor
 */
export function buildParallaxMountains(drawWidth: number): PIXI.Graphics {
  const g   = new PIXI.Graphics();
  const rng = mulberry32(137);

  // Layer 1 — farthest, haziest: tall peaks blending into the sky
  mountainRange(g, rng, drawWidth, 0xa8bcc9, 0.45, 110, 320, 175);

  // Layer 2 — mid-distance: slightly more defined, sits lower
  mountainRange(g, rng, drawWidth, 0x7b98aa, 0.60, 300, 470, 125);

  return g;
}

/**
 * Draw one mountain-range silhouette as a filled polygon.
 * peakMinY / peakMaxY are screen-space y values (small = high up).
 * The polygon closes along baseY (screen GROUND_Y).
 */
function mountainRange(
  g:              PIXI.Graphics,
  rng:            () => number,
  drawWidth:      number,
  color:          number,
  alpha:          number,
  peakMinY:       number,
  peakMaxY:       number,
  nominalSpacing: number,
) {
  g.beginFill(color, alpha);
  g.moveTo(0, GROUND_Y);

  let x = 0;
  while (x < drawWidth + nominalSpacing) {
    // Rise to a peak
    const px = x + nominalSpacing * (0.45 + rng() * 0.65);
    const py = peakMinY + rng() * (peakMaxY - peakMinY);
    g.lineTo(Math.min(px, drawWidth), py);

    // Fall to a valley (shallow dip, staying well above ground)
    const vx = px + nominalSpacing * (0.35 + rng() * 0.45);
    const vy = peakMaxY - rng() * (peakMaxY - peakMinY) * 0.25;
    g.lineTo(Math.min(vx, drawWidth), Math.min(vy, GROUND_Y - 30));

    x = vx;
  }

  g.lineTo(drawWidth, GROUND_Y);
  g.closePath();
  g.endFill();
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
