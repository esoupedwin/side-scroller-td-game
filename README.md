# COIN — Side-Scroller Tower Defence

A browser-based side-scrolling tower defence game built with PixiJS v7, Matter.js, Vite, and TypeScript.

## Gameplay

Two towers face off on a 2246 px scrollable map. Spend coins to spawn units, collect field coins to fund your army, and destroy the enemy tower before yours falls.

- **Spawn units** from your tower using the bottom button bar
- **Assign behaviours** per unit: Attack, Collect, or Harass
- **Collect field coins** — gold and silver coins drop from the sky; collecting characters pick them up and return them (or relay-throw them) to your tower
- **Survive 5 minutes** or destroy the enemy tower to win

## Unit Roster

| Unit | Role | HP | Speed | Cost |
|---|---|---|---|---|
| Warrior | Melee fighter | 100 | Fast | 25 |
| Archer | Ranged (arrow) | 60 | Medium | 50 |
| Rifleman | Ranged (fast bullet) | 75 | Medium | 70 |
| Sniper | Ranged (long range) | 50 | Slow | 100 |
| Medic | Heals nearby allies | 50 | Slow | 60 |
| Heavy | Tanky melee | 160 | Very slow | 80 |

## Behaviours

- **Attack** — march toward enemies, engage in range, assault the enemy tower
- **Collect** — chase field coins and deposit them at home; relay-throw coins that are too far to carry back
- **Harass** — advance to the edge of enemy tower range and hold, firing at anything in range

## Promotion System

Units earn Achievement Points (AP) for kills and coin deposits. Enough AP promotes them through Private → Corporal → Sergeant → Captain, each rank granting +20% HP, +10% speed, and +15% attack power.

## Tech Stack

| Technology | Version | Role |
|---|---|---|
| [PixiJS](https://pixijs.com/) | v7 | 2D renderer — all visuals drawn with the imperative `Graphics` API, no sprites or textures |
| [Matter.js](https://brm.io/matter-js/) | v0.19 | Physics engine — gravity, ground/platform collision, and full rigid-body coin simulation |
| [Vite](https://vitejs.dev/) | latest | Build tool and dev server with hot module replacement |
| [TypeScript](https://www.typescriptlang.org/) | 5.x | Language — strict mode, `noUnusedLocals`, `noUnusedParameters` |

**Physics model:** characters use a hybrid approach — AI teleports the X axis each tick while Matter.js simulates Y (gravity and landing). Coins are fully simulated in both axes with restitution-based bouncing and surface friction.

## Getting Started

```bash
npm install
npm run dev      # dev server with HMR
npm run build    # production bundle
```

Open `http://localhost:5173` in a browser.

## Project Structure

```
src/
├── gameConfig.ts     # single source of truth for all tunable numbers
├── constants.ts      # flat re-exports from gameConfig
├── Game.ts           # tick loop, spawning, coin drops, projectile fire
├── Character.ts      # per-unit state machine, physics, AI behaviours
├── Coin.ts           # coin physics, lifetime, pickup state
├── Physics.ts        # Matter.js world setup, collision categories
├── Tower.ts          # HP, auto-fire, geometry
├── Platform.ts       # elevated central platform
├── Projectile.ts     # arc projectile movement and splash damage
├── Background.ts     # scene dressing, tower range markers
├── CharacterHUD.ts   # player unit HP card panel
├── DamageLabel.ts    # floating damage numbers
└── main.ts           # DOM wiring, button handlers, game lifecycle
```
