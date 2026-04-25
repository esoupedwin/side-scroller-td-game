import * as PIXI from 'pixi.js';
import { GAME_WIDTH, GAME_HEIGHT, GROUND_Y } from './constants';

export function buildBackground(stage: PIXI.Container) {
  const g = new PIXI.Graphics();

  // Sky gradient approximation with two rects
  g.beginFill(0x1a1a2e);
  g.drawRect(0, 0, GAME_WIDTH, GROUND_Y);
  g.endFill();

  // Distant mountains
  g.beginFill(0x2d2d44);
  const mts = [
    [0, 200], [104, 140], [208, 180], [312, 130], [442, 160],
    [572, 120], [702, 155], [832, 135], [962, 165], [1092, 140],
    [1196, 170], [GAME_WIDTH, 200],
  ];
  g.moveTo(0, GROUND_Y);
  for (const [mx, my] of mts) g.lineTo(mx, my);
  g.lineTo(GAME_WIDTH, GROUND_Y);
  g.closePath();
  g.endFill();

  // Ground
  g.beginFill(0x4a7c59);
  g.drawRect(0, GROUND_Y, GAME_WIDTH, GAME_HEIGHT - GROUND_Y);
  g.endFill();

  // Ground stripe
  g.beginFill(0x3d6b4a);
  g.drawRect(0, GROUND_Y, GAME_WIDTH, 6);
  g.endFill();

  // Stars
  g.beginFill(0xffffff);
  const rng = mulberry32(42);
  for (let i = 0; i < 60; i++) {
    const sx = rng() * GAME_WIDTH;
    const sy = rng() * (GROUND_Y - 40);
    const sr = rng() * 1.5 + 0.3;
    g.drawCircle(sx, sy, sr);
  }
  g.endFill();

  stage.addChild(g);
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
