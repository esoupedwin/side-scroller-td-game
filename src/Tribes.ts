import type { Side } from './Tower';

/**
 * Visual/identity grouping for characters. Each side fields a tribe; in the
 * current build the mapping is fixed (player = berserkers, enemy = legion),
 * but the system is set up so additional CPU tribes can be added later and
 * picked at game start.
 *
 * Sprite assets live under `public/sprites/<tribe>/<type>/<anim>.png`.
 */
export type Tribe = 'berserkers' | 'legion';

export interface TribeInfo {
  id:          Tribe;
  displayName: string;
}

export const TRIBES: Record<Tribe, TribeInfo> = {
  berserkers: { id: 'berserkers', displayName: 'Berserkers' },
  legion:     { id: 'legion',     displayName: 'Legion'     },
};

export const PLAYER_TRIBE: Tribe = 'berserkers';
export const ENEMY_TRIBE:  Tribe = 'legion';

export function tribeForSide(side: Side): Tribe {
  return side === 'player' ? PLAYER_TRIBE : ENEMY_TRIBE;
}
