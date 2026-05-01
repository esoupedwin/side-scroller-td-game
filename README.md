# COIN — Side-Scroller Tower Defence

A browser-based side-scrolling tower defence game built with PixiJS v7, Matter.js, Vite, and TypeScript.

## Gameplay

Two towers face off on a 2808 px scrollable map. Spend coins to spawn units, collect field coins to fund your army, and destroy the enemy tower before yours falls.

- **Spawn units** from your tower using the bottom button bar
- **Assign behaviours** per unit: Attack, Collect, Harass, or Defend
- **Collect field coins** — gold and silver coins drop from the sky; collecting characters pick them up and return them (or relay-throw them) to your tower
- **Grab power-ups** — special drops fall every 40 seconds; whichever unit reaches one first gains an instant effect
- **Survive 5 minutes** or destroy the enemy tower to win

## Unit Roster

| Unit | Role | HP | Speed | Cost |
|---|---|---|---|---|
| Warrior | Melee fighter | 160 | Fast | 25 |
| Archer | Ranged (arrow) | 100 | Medium | 50 |
| Rifleman | Ranged (fast bullet) | 90 | Medium | 70 |
| Sniper | Ranged (long range) | 70 | Slow | 100 |
| Medic | Heals nearby allies | 50 | Slow | 60 |
| Heavy | Tanky melee | 220 | Very slow | 80 |
| Tanker | Slow, devastating ranged | 500 | Very slow | 160 |

## Behaviours

- **Attack** — march toward enemies, engage in range, assault the enemy tower
- **Collect** — chase field coins and deposit them at home; relay-throw coins that are too far to carry back; each unit targets a different coin to maximise efficiency
- **Harass** — advance to the edge of enemy tower range and hold, firing at anything in range; ranged units kite back from closing melee
- **Defend** — patrol within own tower's attack range and engage enemies that enter; ranged units kite back from melee

## Power-ups

Every 40 seconds a power-up drops from the sky. A moving indicator appears 20 seconds before the drop, showing where it will land. Three types:

| Type | Effect |
|---|---|
| Heal | Restores the unit's HP to full |
| Speed | 2.5× move speed for 15 seconds |
| Attack | 2× attack power (lasts until the unit dies) |

Power-ups fall with full physics — they bounce off the ground, land on the platform, and bob gently until collected or they expire after 20 seconds.

## Promotion System

Units earn Achievement Points (AP) for kills and coin deposits. Enough AP promotes them through Private → Corporal → Sergeant → Captain, each rank granting +20% HP, +10% speed, and +15% attack power.

## Tech Stack

| Technology | Version | Role |
|---|---|---|
| [PixiJS](https://pixijs.com/) | v7 | 2D renderer — all visuals drawn with the imperative `Graphics` API, no sprites or textures |
| [Matter.js](https://brm.io/matter-js/) | v0.19 | Physics engine — gravity, ground/platform collision, and full rigid-body coin and power-up simulation |
| [Vite](https://vitejs.dev/) | latest | Build tool and dev server with hot module replacement |
| [TypeScript](https://www.typescriptlang.org/) | 5.x | Language — strict mode, `noUnusedLocals`, `noUnusedParameters` |

**Physics model:** characters use a hybrid approach — AI teleports the X axis each tick while Matter.js simulates Y (gravity and landing). Coins and power-ups are fully simulated in both axes with restitution-based bouncing and surface friction.

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
├── Game.ts           # tick loop, spawning, coin/power-up drops, projectile fire
├── Character.ts      # per-unit state machine, physics, AI behaviours
├── Coin.ts           # coin physics, lifetime, pickup state
├── PowerUp.ts        # power-up physics, visual, pickup, effect dispatch
├── Physics.ts        # Matter.js world setup, collision categories, body factories
├── Tower.ts          # HP, auto-fire, geometry
├── Platform.ts       # elevated central platform
├── Projectile.ts     # arc projectile movement and splash damage
├── Pathfinding.ts    # NavGraph: A* path planning for platform navigation
├── CollisionBox.ts   # debug overlay: renders physics body outlines (B key)
├── Background.ts     # scene dressing, tower range markers, coin box
├── CharacterHUD.ts   # player unit HP card panel
├── DamageLabel.ts    # floating damage numbers
├── names.ts          # random character display names
└── main.ts           # DOM wiring, button handlers, game lifecycle
```
