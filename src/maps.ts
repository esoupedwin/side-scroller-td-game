import type { PlatformData } from './Platform';
import type { BlockData } from './Block';
import { GameConfig } from './gameConfig';

const G  = GameConfig;
const W  = G.worldWidth;
const GY = G.canvas.height - 80;   // GROUND_Y

export interface CoinBoxDef {
  x:         number;   // centre x in world space
  y:         number;   // top y in world space
  width:     number;
  height:    number;
  spreadDeg: number;   // ± degrees coins can spread from vertical
}

export interface MapDefinition {
  id:           string;
  name:         string;
  worldWidth:   number;
  playerTowerX: number;  // centre x of the player tower
  enemyTowerX:  number;  // centre x of the enemy tower
  platforms:    PlatformData[];
  blocks:       BlockData[];
  coinBox:      CoinBoxDef;
}

/** Reproduces the hardcoded defaults from gameConfig.ts. */
export const DEFAULT_MAP: MapDefinition = {
  id:           'default',
  name:         'Classic Battlefield',
  worldWidth:   W,
  playerTowerX: G.towers.playerX,
  enemyTowerX:  G.towers.enemyX,
  platforms: [
    { x: W / 2 - 180, y: GY - 140, width: 360, height: 14 },
  ],
  blocks: [
    { x: W / 2 - 100, y: GY - 80, width: 200, height: 40 },
  ],
  coinBox: {
    x:         W / 2,
    y:         GY - 350,
    width:     G.coinBox.width,
    height:    G.coinBox.height,
    spreadDeg: G.coinBox.spreadDeg,
  },
};

export const HIGHLANDS_MAP: MapDefinition = {
  id:           'highlands',
  name:         'Highlands',
  worldWidth:   W,
  playerTowerX: 80,
  enemyTowerX:  W - 80,
  platforms: [
    { x: W / 2 - 260, y: GY - 110, width: 200, height: 14 },
    { x: W / 2 +  60, y: GY - 110, width: 200, height: 14 },
    { x: W / 2 -  80, y: GY - 240, width: 160, height: 14 },
  ],
  blocks: [],
  coinBox: {
    x:         W / 2,
    y:         GY - 360,
    width:     48,
    height:    48,
    spreadDeg: 30,
  },
};

export const ALL_MAPS: MapDefinition[] = [DEFAULT_MAP, HIGHLANDS_MAP];
