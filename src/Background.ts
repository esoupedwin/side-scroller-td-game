import * as PIXI from 'pixi.js';
import {
  GAME_HEIGHT, GROUND_Y,
  TOWER_WIDTH, TOWER_ATTACK_RANGE,
  PLAYER_COLOR, ENEMY_COLOR,
} from './constants';
import type { CoinBoxDef } from './maps';

export function buildBackground(stage: PIXI.Container, worldWidth: number) {
  const g = new PIXI.Graphics();

  // Sky
  g.beginFill(0x1a1a2e);
  g.drawRect(0, 0, worldWidth, GROUND_Y);
  g.endFill();

  // Distant mountains — proportionally scaled to world width
  g.beginFill(0x2d2d44);
  const fracs: [number, number][] = [
    [0,     200], [0.037, 140], [0.074, 180], [0.111, 130], [0.157, 160],
    [0.204, 120], [0.250, 155], [0.296, 135], [0.343, 165], [0.389, 140],
    [0.426, 170], [1.0,   200],
  ];
  g.moveTo(0, GROUND_Y);
  for (const [f, my] of fracs) g.lineTo(f * worldWidth, my);
  g.lineTo(worldWidth, GROUND_Y);
  g.closePath();
  g.endFill();

  // Stars
  g.beginFill(0xffffff);
  const rng = mulberry32(42);
  for (let i = 0; i < 60; i++) {
    const sx = rng() * worldWidth;
    const sy = rng() * (GROUND_Y - 40);
    const sr = rng() * 1.5 + 0.3;
    g.drawCircle(sx, sy, sr);
  }
  g.endFill();

  stage.addChild(g);
}

/** Ground plane — must be added to stage LAST so it renders above all game objects. */
export function buildGround(stage: PIXI.Container, worldWidth: number) {
  const g = new PIXI.Graphics();
  g.beginFill(0x4a7c59);
  g.drawRect(0, GROUND_Y, worldWidth, GAME_HEIGHT - GROUND_Y);
  g.endFill();
  g.beginFill(0x3d6b4a);
  g.drawRect(0, GROUND_Y, worldWidth, 6);
  g.endFill();
  stage.addChild(g);
}

export function buildTowerRangeMarkers(
  stage: PIXI.Container,
  playerTowerX: number,
  enemyTowerX: number,
) {
  const playerFrontX = playerTowerX + TOWER_WIDTH / 2;
  const enemyFrontX  = enemyTowerX  - TOWER_WIDTH / 2;
  const playerRangeX = playerFrontX + TOWER_ATTACK_RANGE;
  const enemyRangeX  = enemyFrontX  - TOWER_ATTACK_RANGE;
  const lineH = 30;

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

  stage.addChild(g);

  const labelStyle = (color: number): Partial<PIXI.ITextStyle> => ({
    fontSize: 8, fill: color, fontWeight: 'bold',
  });

  const pLabel = new PIXI.Text('RANGE', labelStyle(PLAYER_COLOR));
  pLabel.anchor.set(0.5, 1);
  pLabel.x = playerRangeX;
  pLabel.y = GROUND_Y - lineH - 3;
  stage.addChild(pLabel);

  const eLabel = new PIXI.Text('RANGE', labelStyle(ENEMY_COLOR));
  eLabel.anchor.set(0.5, 1);
  eLabel.x = enemyRangeX;
  eLabel.y = GROUND_Y - lineH - 3;
  stage.addChild(eLabel);
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

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
