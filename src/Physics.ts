import Matter from 'matter-js';
import {
  GROUND_Y,
  CHAR_GRAVITY,
  COIN_BOUNCE_DAMPING, COIN_FRICTION, COIN_FRICTION_AIR, SURFACE_FRICTION,
  TOWER_WIDTH,
} from './constants';
import type { PlatformData } from './Platform';

// Collision categories
export const CAT_GROUND    = 0x0001;
export const CAT_PLATFORM  = 0x0002;
export const CAT_CHARACTER = 0x0004;
export const CAT_COIN      = 0x0008;
export const CAT_WALL      = 0x0010;
export const CAT_TOWER     = 0x0020;
export const CAT_POWERUP   = 0x0040;
export const CAT_SHEEP     = 0x0080;
export const CAT_BLOCK     = 0x0100;

export class Physics {
  readonly engine: Matter.Engine;

  private platformBodies: Matter.Body[] = [];
  private onSurface = new Set<number>();

  constructor(
    worldWidth:   number,
    playerTowerX: number,
    enemyTowerX:  number,
    platforms:    PlatformData[],
  ) {
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: CHAR_GRAVITY / 1000, scale: 0.001 },
    });

    const groundThickness = 80;
    const ground = Matter.Bodies.rectangle(
      worldWidth / 2,
      GROUND_Y + groundThickness / 2,
      worldWidth * 3,
      groundThickness,
      {
        isStatic: true,
        label: 'ground',
        friction: SURFACE_FRICTION, frictionStatic: 0, restitution: 0,
        collisionFilter: { category: CAT_GROUND, mask: CAT_CHARACTER | CAT_COIN | CAT_POWERUP | CAT_SHEEP },
      },
    );

    // Tower boundary walls — block coins/power-ups/sheep (character X is clamped in code)
    const wallThick   = 20;
    const wallHeight  = GROUND_Y + 60;
    const wallCenterY = wallHeight / 2;
    const wallOpts = (label: string): Matter.IBodyDefinition => ({
      isStatic: true, label,
      friction: 0, frictionStatic: 0, restitution: 0.1,
      collisionFilter: { category: CAT_WALL, mask: CAT_COIN | CAT_POWERUP | CAT_SHEEP },
    });
    const leftWall = Matter.Bodies.rectangle(
      playerTowerX - TOWER_WIDTH / 2 - wallThick / 2, wallCenterY,
      wallThick, wallHeight, wallOpts('wall-left'),
    );
    const rightWall = Matter.Bodies.rectangle(
      enemyTowerX + TOWER_WIDTH / 2 + wallThick / 2, wallCenterY,
      wallThick, wallHeight, wallOpts('wall-right'),
    );

    Matter.Composite.add(this.engine.world, [ground, leftWall, rightWall]);

    for (const p of platforms) {
      const pb = Matter.Bodies.rectangle(
        p.x + p.width / 2,
        p.y + p.height / 2,
        p.width,
        p.height,
        {
          isStatic: true,
          label: 'platform',
          friction: SURFACE_FRICTION, frictionStatic: 0, restitution: 0,
          collisionFilter: { category: CAT_PLATFORM, mask: CAT_CHARACTER | CAT_COIN | CAT_POWERUP | CAT_SHEEP },
        },
      );
      this.platformBodies.push(pb);
      Matter.Composite.add(this.engine.world, pb);
    }

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

  // One-way platform: call BEFORE each physics step.
  // Disables platform collision while a body is RISING through a platform surface.
  // The velocity check ensures multi-platform correctness: a falling body always lands
  // on the first platform below it rather than falling through due to a lower-level check.
  updatePlatformPassthrough(body: Matter.Body) {
    const isRising       = body.velocity.y < -0.1;
    const passingThrough = isRising &&
      this.platformBodies.some(pb => body.bounds.min.y > pb.bounds.min.y);

    const baseMask = passingThrough
      ? CAT_GROUND
      : CAT_GROUND | CAT_PLATFORM;
    // Keep any bits that are neither ground nor platform (walls, towers, …)
    const extraBits = (body.collisionFilter.mask ?? 0) & ~(CAT_GROUND | CAT_PLATFORM);
    const mask = baseMask | extraBits;
    if (body.collisionFilter.mask !== mask) {
      Matter.Body.set(body, 'collisionFilter', { category: body.collisionFilter.category, mask });
    }
  }

  createCharBody(x: number, feetY: number, w: number, h: number): Matter.Body {
    const body = Matter.Bodies.rectangle(x, feetY - h / 2, w, h, {
      friction: 0, frictionAir: 0, frictionStatic: 0,
      restitution: 0,
      inertia: Infinity, inverseInertia: 0,
      collisionFilter: { category: CAT_CHARACTER, mask: CAT_GROUND | CAT_TOWER },
    });
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  createTowerBody(centerX: number, w: number): Matter.Body {
    const h = GROUND_Y + 60;
    const body = Matter.Bodies.rectangle(centerX, h / 2, w, h, {
      isStatic: true,
      label: 'tower',
      friction: 0, frictionStatic: 0, restitution: 0.2,
      collisionFilter: { category: CAT_TOWER, mask: CAT_CHARACTER | CAT_COIN | CAT_POWERUP | CAT_SHEEP },
    });
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  createPowerUpBody(x: number, y: number): Matter.Body {
    const body = Matter.Bodies.circle(x, y, 20, {
      friction: 0.05, frictionAir: 0.004, restitution: 0.5,
      collisionFilter: { category: CAT_POWERUP, mask: CAT_GROUND | CAT_PLATFORM | CAT_WALL | CAT_TOWER | CAT_BLOCK },
    });
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  createCoinBody(x: number, y: number, vx: number, vy: number, dt: number): Matter.Body {
    const body = Matter.Bodies.circle(x, y, 10, {
      friction: COIN_FRICTION, frictionAir: COIN_FRICTION_AIR,
      restitution: COIN_BOUNCE_DAMPING,
      collisionFilter: { category: CAT_COIN, mask: CAT_GROUND | CAT_PLATFORM | CAT_WALL | CAT_TOWER | CAT_BLOCK },
    });
    Matter.Body.setVelocity(body, { x: vx * dt, y: vy * dt });
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  createSheepBody(x: number, centerY: number): Matter.Body {
    const body = Matter.Bodies.rectangle(x, centerY, 34, 22, {
      friction:        0.6,
      frictionAir:     0.04,
      frictionStatic:  0,
      restitution:     0.05,
      inertia: Infinity, inverseInertia: 0,
      collisionFilter: {
        category: CAT_SHEEP,
        mask:     CAT_GROUND | CAT_PLATFORM | CAT_WALL | CAT_TOWER | CAT_BLOCK,
      },
    });
    Matter.Composite.add(this.engine.world, body);
    return body;
  }

  createBlockBody(x: number, y: number, w: number, h: number): Matter.Body {
    const body = Matter.Bodies.rectangle(x + w / 2, y + h / 2, w, h, {
      isStatic: true,
      label: 'block',
      friction: SURFACE_FRICTION, frictionStatic: 0, restitution: 0.05,
      collisionFilter: { category: CAT_BLOCK, mask: CAT_CHARACTER | CAT_COIN | CAT_POWERUP | CAT_SHEEP },
    });
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
