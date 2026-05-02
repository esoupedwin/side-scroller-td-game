import * as PIXI from 'pixi.js';
import Matter from 'matter-js';
import type { Physics } from './Physics';

const SHEEP_W  = 34;
const SHEEP_H  = 22;
const HALF_H   = SHEEP_H / 2;   // 11 — body center to feet
const WALK_SPD = 38;            // px/s — leisurely stroll

export class Sheep {
  x = 0;
  y = 0;

  readonly body:      Matter.Body;
  readonly container: PIXI.Container;
  private  gfx:       PIXI.Graphics;

  private state:         'walking' | 'eating' = 'walking';
  private stateTimer     = 0;
  private stateDuration  = 0;
  private dir:           1 | -1 = 1;
  private legPhase       = 0;
  private isJumping      = false;
  private jumpTimer      = 0;

  private readonly leftBound:  number;
  private readonly rightBound: number;

  constructor(x: number, physics: Physics, towerFaceL: number, towerFaceR: number) {
    this.dir        = Math.random() < 0.5 ? 1 : -1;
    this.leftBound  = towerFaceL + SHEEP_W / 2 + 4;
    this.rightBound = towerFaceR - SHEEP_W / 2 - 4;
    this.nextStateDuration();

    // Drop from above the canvas — body center at y = -150
    this.body = physics.createSheepBody(x, -150);
    this.x    = x;
    this.y    = -150 + HALF_H;

    this.container  = new PIXI.Container();
    this.gfx        = new PIXI.Graphics();
    this.container.addChild(this.gfx);
    this.draw();
    this.container.x = this.x;
    this.container.y = this.y;
  }

  /** Called when a projectile or grenade lands near the sheep. */
  reactToHit(fromX: number) {
    if (this.isJumping) return;
    const awayDir    = this.x >= fromX ? 1 : -1;
    // Velocity in px/frame (Matter.js convention); 1/60 converts px/s → px/frame
    Matter.Body.setVelocity(this.body, {
      x:  awayDir * 200 / 60,
      y: -400      / 60,
    });
    this.isJumping = true;
    this.jumpTimer = 0;
    this.dir       = awayDir as 1 | -1;  // face away after landing
  }

  private nextStateDuration() {
    this.stateDuration = this.state === 'walking'
      ? 3 + Math.random() * 5   // 3–8 s walking
      : 1 + Math.random() * 3;  // 1–4 s eating
    this.stateTimer = 0;
  }

  update(dt: number) {
    // State machine
    this.stateTimer += dt;
    if (this.stateTimer >= this.stateDuration) {
      this.state = this.state === 'walking' ? 'eating' : 'walking';
      if (this.state === 'walking' && Math.random() < 0.5) {
        this.dir = this.dir === 1 ? -1 : 1;
      }
      this.nextStateDuration();
    }

    // Turn around at tower walls (based on last frame's synced position)
    if (!this.isJumping) {
      if (this.x <= this.leftBound  && this.dir === -1) this.dir = 1;
      if (this.x >= this.rightBound && this.dir ===  1) this.dir = -1;
    }

    if (this.isJumping) {
      // Let physics carry the body — just track landing.
      // Minimum 0.3 s airtime prevents false landing at the jump peak.
      this.jumpTimer += dt;
      if (this.jumpTimer > 0.3 && Math.abs(this.body.velocity.y) < 0.5) {
        this.isJumping = false;
      }
    } else {
      // Push horizontal walking velocity; preserve vertical for gravity.
      const walkVx = this.state === 'walking' ? this.dir * WALK_SPD * dt : 0;
      Matter.Body.setVelocity(this.body, { x: walkVx, y: this.body.velocity.y });
    }

    // Sync position from the physics engine (result of the previous step)
    this.x = this.body.position.x;
    this.y = this.body.position.y + HALF_H;

    if (this.state === 'walking') this.legPhase += dt * 9;

    this.draw();
    this.container.x = this.x;
    this.container.y = this.y;
  }

  private draw() {
    const g   = this.gfx;
    const dir = this.dir;
    const eat = this.state === 'eating';
    // Head bobs down while eating
    const headY = eat ? -30 + Math.sin(this.stateTimer * 7) * 4 : -33;
    g.clear();

    // ── Legs (drawn first so wool covers the attachment points) ──────────────
    // Alternating gait: legs 0 & 2 swing forward, legs 1 & 3 swing back.
    // Legs flail outward when jumping.
    const sw = this.isJumping ? 7 : Math.sin(this.legPhase) * 3;
    g.beginFill(0x9a9988);
    g.drawRect(-12 + sw,  -14, 5, 14);  // front-left
    g.drawRect( -5 - sw,  -14, 5, 14);  // back-left
    g.drawRect(  1 + sw,  -14, 5, 14);  // front-right
    g.drawRect(  8 - sw,  -14, 5, 14);  // back-right
    g.endFill();

    // Hooves (darker tips)
    g.beginFill(0x444433);
    g.drawRect(-13 + sw, -4, 6, 4);
    g.drawRect( -6 - sw, -4, 6, 4);
    g.drawRect(  0 + sw, -4, 6, 4);
    g.drawRect(  7 - sw, -4, 6, 4);
    g.endFill();

    // ── Tail (fluffy puff, opposite side from head) ───────────────────────────
    g.beginFill(0xf2f2ee);
    g.drawCircle(-dir * 16, -18, 5);
    g.endFill();

    // ── Wool body (layered fluffy clusters) ───────────────────────────────────
    g.beginFill(0xeeeee8);
    g.drawEllipse(  0, -20, 17, 11);  // main torso
    g.drawCircle(-13, -22,  9);       // left fluff
    g.drawCircle( 13, -22,  9);       // right fluff
    g.drawCircle( -5, -28,  8);       // upper-left
    g.drawCircle(  5, -28,  8);       // upper-right
    g.drawCircle(  0, -30,  7);       // top centre
    g.endFill();

    // Light belly shading
    g.beginFill(0xd5d5ce, 0.45);
    g.drawEllipse(0, -16, 13, 6);
    g.endFill();

    // ── Head ──────────────────────────────────────────────────────────────────
    const hx = dir * 19;
    g.beginFill(0xc8b89e);
    g.drawCircle(hx, headY, 8);
    g.endFill();

    // Muzzle
    g.beginFill(0xd8c8ae);
    g.drawEllipse(hx + dir * 5, headY + 3, 5, 4);
    g.endFill();

    // Nostrils
    g.beginFill(0x776655);
    g.drawCircle(hx + dir * 4, headY + 2, 1.2);
    g.drawCircle(hx + dir * 6, headY + 3.5, 1.2);
    g.endFill();

    // Eye — wider when scared
    const eyeR = this.isJumping ? 3.2 : 2;
    g.beginFill(0x111100);
    g.drawCircle(hx + dir * 2.5, headY - 2, eyeR);
    g.endFill();
    g.beginFill(0xffffff, 0.9);
    g.drawCircle(hx + dir * 3,   headY - 2.5, eyeR * 0.4);
    g.endFill();

    // Ear (floppy, on the side away from the face direction)
    g.beginFill(0xc0aa88);
    g.drawEllipse(hx - dir * 4, headY - 7, 4, 7);
    g.endFill();

    // ── Eating grass effect ───────────────────────────────────────────────────
    if (eat) {
      const t = this.stateTimer;
      g.beginFill(0x44bb33);
      g.drawRect(hx + dir * 2, 0, 2, -5 + Math.sin(t * 5) * 1);
      g.drawRect(hx + dir * 4, 0, 2, -4 + Math.sin(t * 7) * 1);
      g.drawRect(hx + dir * 6, 0, 2, -3 + Math.sin(t * 6) * 1);
      g.endFill();
    }
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
