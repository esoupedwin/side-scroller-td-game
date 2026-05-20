import type { Side } from './Tower';

/**
 * Visual/identity grouping for characters. Each side fields a tribe; in the
 * current build the mapping is fixed (player = tomaro, enemy = meowee),
 * but the system is set up so additional CPU tribes can be added later and
 * picked at game start.
 *
 * Sprite assets live under `public/sprites/<tribe>/<type>/<anim>.png`.
 */
export type Tribe = 'tomaro' | 'meowee';

export interface TribeInfo {
  id:          Tribe;
  displayName: string;
}

export const TRIBES: Record<Tribe, TribeInfo> = {
  tomaro: { id: 'tomaro', displayName: 'Tomaro' },
  meowee: { id: 'meowee', displayName: 'Meowee' },
};

export const PLAYER_TRIBE: Tribe = 'tomaro';
export const ENEMY_TRIBE:  Tribe = 'meowee';

export function tribeForSide(side: Side): Tribe {
  return side === 'player' ? PLAYER_TRIBE : ENEMY_TRIBE;
}
