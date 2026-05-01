import Matter from 'matter-js';
import {
  GAME_WIDTH, GROUND_Y,
  CHAR_GRAVITY,
  COIN_BOUNCE_DAMPING, COIN_FRICTION, COIN_FRICTION_AIR, SURFACE_FRICTION,
  PLAYER_TOWER_X, ENEMY_TOWER_X, TOWER_WIDTH,
} from './constants';

// Collision categories
export const CAT_GROUND    = 0x0001;
export const CAT_PLATFORM  = 0x0002;
export const CAT_CHARACTER = 0x0004;
export const CAT_COIN      = 0x0008;
export const CAT_WALL      = 0x0010;
export const CAT_TOWER     = 0x0020;

export class Physics {
  readonly engine: Matter.Engine;

  private platformBody!: Matter.Body;
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
        friction: SURFACE_FRICTION, frictionStatic: 0, restitution: 0,
        collisionFilter: { category: CAT_GROUND, mask: CAT_CHARACTER | CAT_COIN },
      },
    );

    this.platformBody = Matter.Bodies.rectangle(
      platformData.x + platformData.width / 2,
      platformData.y + platformData.height / 2,
      platformData.width,
      platformData.height,
      {
        isStatic: true,
        label: 'platform',
        friction: SURFACE_FRICTION, frictionStatic: 0, restitution: 0,
        collisionFilter: { category: CAT_PLATFORM, mask: CAT_CHARACTER | CAT_COIN },
      },
    );

    // Tower boundary walls — block coins only (character X is clamped in code)
    const wallThick  = 20;
    const wallHeight = GROUND_Y + 60;
    const wallCenterY = wallHeight / 2;
    const wallOpts = (label: string): Matter.IBodyDefinition => ({
      isStatic: true, label,
      friction: 0, frictionStatic: 0, restitution: 0.1,
      collisionFilter: { category: CAT_WALL, mask: CAT_COIN },
    });
    const leftWall = Matter.Bodies.rectangle(
      PLAYER_TOWER_X - TOWER_WIDTH / 2 - wallThick / 2, wallCenterY,
      wallThick, wallHeight, wallOpts('wall-left'),
    );
    const rightWall = Matter.Bodies.rectangle(
      ENEMY_TOWER_X + TOWER_WIDTH / 2 + wallThick / 2, wallCenterY,
      wallThick, wallHeight, wallOpts('wall-right'),
    );

    Matter.Composite.add(this.engine.world, [ground, this.platformBody, leftWall, rightWall]);

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

  get platformTopY(): number { return this.platformBody.bounds.min.y; }

  isOnSurface(body: Matter.Body): boolean {
    return this.onSurface.has(body.id);
  }

  // One-way platform: call BEFORE each physics step.
  // Disables platform collision while a body's top is still below the platform surface.
  // Preserves any extra collision bits already on the body (e.g. CAT_WALL | CAT_TOWER for coins).
  updatePlatformPassthrough(body: Matter.Body) {
    const passingThrough = body.bounds.min.y > this.platformBody.bounds.min.y;
    const baseMask = passingThrough
      ? CAT_GROUND                   // only ground while rising through
      : CAT_GROUND | CAT_PLATFORM;   // both once above the surface
    // Keep any bits that are neither ground nor platform (walls, towers, …)
    const extraBits = (body.collisionFilter.mask ?? 0) & ~(CAT_GROUND | CAT_PLATFORM);
    const mask = baseMask | extraBits;
    if (body.collisionFilter.mask !== mask) {
      Matter.Body.set(body, 'collisionFilter', { category: body.collisionFilter.category, mask });
    }
  }

  createCharBody(x: number, feetY: number, w: number, h: number): Matter.Body {
    // Characters collide with ground and solid tower walls.
    // Platform landing is handled manually in syncFromBody (one-way tunneling workaround).
    const body = Matter.Bodies.rectangle(x, feetY - h / 2, w, h, {
      friction: 0, frictionAir: 0, frictionStatic: 0,
      restitution: 0,
      inertia: Infinity, inverseInertia: 0,
      collisionFilter: { category: CAT_CHARACTER, mask: CAT_GROUND | CAT_TOWER },
    });
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  /**
   * Creates a full-height static body for a tower (solid — blocks characters).
   * Extends from the top of the canvas to below the ground so characters
   * cannot jump over it.
   */
  createTowerBody(centerX: number, w: number): Matter.Body {
    const h = GROUND_Y + 60;   // sky-to-ground full height
    const body = Matter.Bodies.rectangle(centerX, h / 2, w, h, {
      isStatic: true,
      label: 'tower',
      friction: 0, frictionStatic: 0, restitution: 0.2,
      collisionFilter: { category: CAT_TOWER, mask: CAT_CHARACTER | CAT_COIN },
    });
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  createCoinBody(x: number, y: number, vx: number, vy: number, dt: number): Matter.Body {
    const body = Matter.Bodies.circle(x, y, 10, {
      friction: COIN_FRICTION, frictionAir: COIN_FRICTION_AIR,
      restitution: COIN_BOUNCE_DAMPING,
      collisionFilter: { category: CAT_COIN, mask: CAT_GROUND | CAT_PLATFORM | CAT_WALL | CAT_TOWER },
    });
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
