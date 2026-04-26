import Matter from 'matter-js';
import {
  GAME_WIDTH, GROUND_Y,
  CHAR_GRAVITY,
  COIN_BOUNCE_DAMPING,
} from './constants';

// Collision categories — characters and coins only hit static surfaces.
export const CAT_STATIC    = 0x0001;
export const CAT_CHARACTER = 0x0002;
export const CAT_COIN      = 0x0004;

export class Physics {
  readonly engine: Matter.Engine;

  // Set of body ids currently resting on a static surface.
  private onSurface = new Set<number>();

  constructor(platformData: { x: number; y: number; width: number; height: number }) {
    // Verlet: position_delta += force * dt_ms².  With scale=0.001 and dt_ms≈16.67:
    // effective gravity = y * 0.001 * 16.67² ≈ y * 0.278 px/tick.
    // To match CHAR_GRAVITY px/s²: y = CHAR_GRAVITY / 1000 (unit conversion).
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: CHAR_GRAVITY / 1000, scale: 0.001 },
    });

    const groundThickness = 80;
    const ground = Matter.Bodies.rectangle(
      GAME_WIDTH / 2,
      GROUND_Y + groundThickness / 2,
      GAME_WIDTH * 3,
      groundThickness,
      {
        isStatic: true,
        label: 'ground',
        friction: 0, frictionStatic: 0, restitution: 0,
        collisionFilter: { category: CAT_STATIC, mask: CAT_CHARACTER | CAT_COIN },
      },
    );

    const platform = Matter.Bodies.rectangle(
      platformData.x + platformData.width / 2,
      platformData.y + platformData.height / 2,
      platformData.width,
      platformData.height,
      {
        isStatic: true,
        label: 'platform',
        friction: 0, frictionStatic: 0, restitution: 0,
        collisionFilter: { category: CAT_STATIC, mask: CAT_CHARACTER | CAT_COIN },
      },
    );

    Matter.Composite.add(this.engine.world, [ground, platform]);

    Matter.Events.on(this.engine, 'collisionStart', (ev) => {
      for (const pair of ev.pairs) {
        if (pair.bodyA.isStatic) this.onSurface.add(pair.bodyB.id);
        if (pair.bodyB.isStatic) this.onSurface.add(pair.bodyA.id);
      }
    });
    Matter.Events.on(this.engine, 'collisionEnd', (ev) => {
      for (const pair of ev.pairs) {
        if (pair.bodyA.isStatic) this.onSurface.delete(pair.bodyB.id);
        if (pair.bodyB.isStatic) this.onSurface.delete(pair.bodyA.id);
      }
    });
  }

  isOnSurface(body: Matter.Body): boolean {
    return this.onSurface.has(body.id);
  }

  createCharBody(x: number, feetY: number, w: number, h: number): Matter.Body {
    const body = Matter.Bodies.rectangle(x, feetY - h / 2, w, h, {
      friction: 0, frictionAir: 0, frictionStatic: 0,
      restitution: 0,
      inertia: Infinity, inverseInertia: 0,
      collisionFilter: { category: CAT_CHARACTER, mask: CAT_STATIC },
    });
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  createCoinBody(x: number, y: number, vx: number, vy: number, dt: number): Matter.Body {
    const body = Matter.Bodies.circle(x, y, 10, {
      friction: 0.2, frictionAir: 0.005,
      restitution: COIN_BOUNCE_DAMPING,
      collisionFilter: { category: CAT_COIN, mask: CAT_STATIC },
    });
    // Matter.js velocity is px/tick; convert from px/s using current dt
    Matter.Body.setVelocity(body, { x: vx * dt, y: vy * dt });
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  removeBody(body: Matter.Body) {
    Matter.Composite.remove(this.engine.world, body);
    this.onSurface.delete(body.id);
  }

  step(dt: number) {
    Matter.Engine.update(this.engine, dt * 1000);
  }
}
