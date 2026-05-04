import {
  GROUND_Y, TOWER_WIDTH,
  JUMP_VELOCITY, CHAR_GRAVITY,
} from './constants';

// ── Types ────────────────────────────────────────────────────────────────────

export interface NavSurface {
  id:    number;
  x:     number;   // left edge
  y:     number;   // top surface Y (character feet position)
  width: number;
  solid: boolean;  // true = block (impassable sides); false = platform (one-way, walkable under)
}

export interface PathStep {
  action:        'walk' | 'jump' | 'fall';
  targetX:       number;  // destination X on this step's target surface
  floorY:        number;  // floor Y of the target surface
  jumpTriggerX?: number;  // for jump: walk here first, then jump
}

// ── Physics limits (derived from game constants) ─────────────────────────────

const MAX_JUMP_HEIGHT = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * CHAR_GRAVITY) + 10; // ≈ 179 px
const JUMP_TOTAL_TIME = (2 * JUMP_VELOCITY) / CHAR_GRAVITY;                         // ≈ 1.3 s
// Horizontal clearance a character moving at max speed can cover during a full jump.
// Used to decide whether a platform edge is reachable from a given ground position.
const MAX_JUMP_H_RANGE = 120 * JUMP_TOTAL_TIME;  // 120 px/s × 1.3 s ≈ 156 px

// Time (seconds) from jump start until the character falls back down to height `dy`.
// Uses the positive root of: dy = JUMP_VELOCITY*t - 0.5*CHAR_GRAVITY*t²
function arcLandingTime(dy: number): number {
  const d = JUMP_VELOCITY * JUMP_VELOCITY - 2 * CHAR_GRAVITY * dy;
  if (d <= 0) return JUMP_TOTAL_TIME;
  return (JUMP_VELOCITY + Math.sqrt(d)) / CHAR_GRAVITY;
}

// Representative speed for positioning the jump trigger under a one-way platform.
// Errs toward slower characters so the trigger stays reachable for all unit types.
const PLATFORM_JUMP_SPEED = 80;   // px/s

// How far before a solid block's near edge to start the jump (block cannot be entered).
const BLOCK_JUMP_LEAD = 40;       // px

// ── Internal graph types ─────────────────────────────────────────────────────

interface SurfEdge {
  toId:          number;
  cost:          number;
  action:        'jump' | 'fall';
  // x on the source surface to be at when executing the transition
  triggerX:      number;
  // x on the target surface where character lands / arrives
  landX:         number;
}

// ── NavGraph ─────────────────────────────────────────────────────────────────

export class NavGraph {
  private surfaces: NavSurface[]               = [];
  private edges:    Map<number, SurfEdge[]>    = new Map();

  /**
   * (Re)build the graph from the current platform list.
   * Call this whenever the map changes.
   */
  build(
    platforms:    { x: number; y: number; width: number; height?: number }[],
    playerTowerX: number,
    enemyTowerX:  number,
    blocks:       { x: number; y: number; width: number; height?: number }[] = [],
  ): void {
    this.surfaces = [];
    this.edges    = new Map();

    const groundLeft  = playerTowerX + TOWER_WIDTH / 2;
    const groundRight = enemyTowerX  - TOWER_WIDTH / 2;

    let nextId = 0;

    // A solid block obstructs a non-solid surface when its bounding box
    // straddles that surface's plane (top above, bottom at or below). This
    // splits the surface into walkable subsegments — A* must then route a
    // jump over the block to cross.
    const splitSurface = (sx: number, sy: number, sw: number) => {
      const blockers = blocks
        .filter(b =>
          b.y < sy &&
          b.y + (b.height ?? 0) >= sy &&
          b.x < sx + sw && b.x + b.width > sx,
        )
        .map(b => ({ left: Math.max(b.x, sx), right: Math.min(b.x + b.width, sx + sw) }))
        .sort((a, b) => a.left - b.left);

      let cursor = sx;
      for (const blk of blockers) {
        if (blk.left > cursor) {
          this.surfaces.push({ id: nextId++, x: cursor, y: sy, width: blk.left - cursor, solid: false });
        }
        cursor = Math.max(cursor, blk.right);
      }
      if (cursor < sx + sw) {
        this.surfaces.push({ id: nextId++, x: cursor, y: sy, width: sx + sw - cursor, solid: false });
      }
    };

    splitSurface(groundLeft, GROUND_Y, groundRight - groundLeft);
    for (const p of platforms) splitSurface(p.x, p.y, p.width);
    for (const b of blocks) {
      this.surfaces.push({ id: nextId++, x: b.x, y: b.y, width: b.width, solid: true });
    }

    for (const s of this.surfaces) this.edges.set(s.id, []);

    // Build jump / fall edges between every pair of surfaces
    for (let i = 0; i < this.surfaces.length; i++) {
      for (let j = 0; j < this.surfaces.length; j++) {
        if (i === j) continue;
        const a = this.surfaces[i];
        const b = this.surfaces[j];
        const dy = a.y - b.y;   // positive → a is lower, b is higher

        if (dy > 0 && dy <= MAX_JUMP_HEIGHT) {
          // a (lower) → b (higher): jump
          // Trigger: character must be horizontally within b's span (or close)
          // Use the nearest edge of b as the trigger point for conservative routing.
          const triggerLeft  = Math.max(a.x, b.x);
          const triggerRight = Math.min(a.x + a.width, b.x + b.width);
          if (triggerRight - triggerLeft < -MAX_JUMP_H_RANGE) continue; // too far apart

          const triggerX = triggerLeft <= triggerRight
            ? (triggerLeft + triggerRight) / 2          // jump from below middle of b
            : (b.x + b.width / 2);                      // b is off to the side
          const landX = b.x + b.width / 2;              // aim for centre of b
          const hDist = Math.abs(triggerX - landX);

          if (hDist <= MAX_JUMP_H_RANGE) {
            this.edges.get(a.id)!.push({
              toId: b.id, action: 'jump',
              cost: dy * 1.5 + hDist,
              triggerX, landX,
            });
          }
        } else if (dy < 0) {
          // a (higher) → b (lower): fall
          // Walk to the nearer edge of a, drop off, land roughly below
          const edgeX = b.x + b.width / 2 < a.x + a.width / 2
            ? a.x                  // left edge of a is closer to b
            : a.x + a.width;       // right edge
          const landX = Math.max(b.x, Math.min(b.x + b.width, edgeX));
          this.edges.get(a.id)!.push({
            toId: b.id, action: 'fall',
            cost: Math.abs(dy) * 0.4 + Math.abs(edgeX - landX),
            triggerX: edgeX, landX,
          });
        }
      }
    }
  }

  /**
   * Surface the character is on. With non-solid surfaces split into
   * subsegments by intersecting solid blocks, an x is required to pick
   * the correct subsegment when multiple share the same y.
   */
  surfaceAt(floorY: number, x?: number): NavSurface | null {
    let yMatch: NavSurface | null = null;
    for (const s of this.surfaces) {
      if (Math.abs(s.y - floorY) >= 15) continue;
      if (x === undefined) return s;
      if (x >= s.x && x <= s.x + s.width) return s;
      yMatch = yMatch ?? s;     // fallback to any same-y surface if x misses every span
    }
    return yMatch;
  }

  /**
   * A* path from (fromX, fromFloorY) to (toX, toFloorY).
   * Returns a minimal list of PathSteps; falls back to a single walk step
   * when surfaces are unknown or unreachable.
   */
  findPath(fromX: number, fromFloorY: number, toX: number, toFloorY: number): PathStep[] {
    const fromSurf = this.surfaceAt(fromFloorY, fromX);
    const toSurf   = this.surfaceAt(toFloorY, toX);

    if (!fromSurf || !toSurf || fromSurf.id === toSurf.id) {
      return [{ action: 'walk', targetX: toX, floorY: toFloorY }];
    }

    const surfPath = this.astar(fromSurf.id, toSurf.id, toX, toFloorY);
    if (!surfPath || surfPath.length < 2) {
      return [{ action: 'walk', targetX: toX, floorY: toFloorY }];
    }

    return this.buildSteps(surfPath, fromX, toX, toFloorY);
  }

  // ── Private: A* over surfaces ─────────────────────────────────────────────

  private astar(fromId: number, toId: number, toX: number, toFloorY: number): number[] | null {
    const heuristic = (id: number) => {
      const s = this.surfaces.find(s => s.id === id)!;
      return Math.abs((s.x + s.width / 2) - toX) + Math.abs(s.y - toFloorY);
    };

    const gScore   = new Map<number, number>([[fromId, 0]]);
    const fScore   = new Map<number, number>([[fromId, heuristic(fromId)]]);
    const cameFrom = new Map<number, number>();
    const openSet  = new Set<number>([fromId]);

    while (openSet.size > 0) {
      let cur = -1, lowestF = Infinity;
      for (const id of openSet) {
        const f = fScore.get(id) ?? Infinity;
        if (f < lowestF) { lowestF = f; cur = id; }
      }

      if (cur === toId) {
        const path = [cur];
        let c = cur;
        while (cameFrom.has(c)) { c = cameFrom.get(c)!; path.unshift(c); }
        return path;
      }

      openSet.delete(cur);

      for (const edge of (this.edges.get(cur) ?? [])) {
        const tentG = (gScore.get(cur) ?? Infinity) + edge.cost;
        if (tentG < (gScore.get(edge.toId) ?? Infinity)) {
          cameFrom.set(edge.toId, cur);
          gScore.set(edge.toId, tentG);
          fScore.set(edge.toId, tentG + heuristic(edge.toId));
          openSet.add(edge.toId);
        }
      }
    }

    return null;
  }

  // ── Private: surface sequence → PathStep list ─────────────────────────────

  private buildSteps(surfPath: number[], fromX: number, toX: number, toFloorY: number): PathStep[] {
    const steps: PathStep[] = [];
    let curX = fromX;

    for (let i = 0; i < surfPath.length - 1; i++) {
      const curId  = surfPath[i];
      const nextId = surfPath[i + 1];
      const cur    = this.surfaces.find(s => s.id === curId)!;
      const next   = this.surfaces.find(s => s.id === nextId)!;

      // Pick the edge that connects curId → nextId
      const edge = (this.edges.get(curId) ?? []).find(e => e.toId === nextId);
      if (!edge) continue;

      const isLastTransition = i === surfPath.length - 2;
      const landX = isLastTransition ? toX : edge.landX;

      if (edge.action === 'jump') {
        const approachFromLeft = curX < next.x + next.width / 2;
        const dy               = cur.y - next.y;  // height to climb (positive)
        let jumpTriggerX: number;

        if (next.solid) {
          // Solid block: cannot enter horizontally — jump from BLOCK_JUMP_LEAD px
          // before the near edge so the arc carries the character up and over.
          jumpTriggerX = approachFromLeft
            ? next.x - BLOCK_JUMP_LEAD
            : next.x + next.width + BLOCK_JUMP_LEAD;
        } else {
          // One-way platform: characters can walk under it, so position the trigger
          // directly below the intended landing spot using the physics arc distance.
          const hDist = PLATFORM_JUMP_SPEED * arcLandingTime(dy);
          jumpTriggerX = approachFromLeft ? landX - hDist : landX + hDist;
        }

        steps.push({ action: 'walk', targetX: jumpTriggerX, floorY: cur.y });
        steps.push({ action: 'jump', targetX: landX, floorY: next.y, jumpTriggerX });
        curX = landX;
      } else {
        // Walk to the fall-off edge, then fall. Pick the side closer to the final
        // destination toX rather than the precomputed edge — otherwise a character
        // who needs to keep travelling past `cur` can drop off the wrong edge and
        // walk straight back into whatever was in their way.
        const goingRight = toX > cur.x + cur.width / 2;
        const fallEdgeX  = goingRight ? cur.x + cur.width : cur.x;
        const safeLandX  = Math.max(next.x, Math.min(next.x + next.width, fallEdgeX));
        const fallLandX  = isLastTransition ? toX : safeLandX;
        steps.push({ action: 'walk', targetX: fallEdgeX, floorY: cur.y });
        steps.push({ action: 'fall', targetX: fallLandX, floorY: next.y });
        curX = fallLandX;
      }
    }

    // Final walk to exact destination on the target surface
    steps.push({ action: 'walk', targetX: toX, floorY: toFloorY });

    // Collapse consecutive walk steps on the same surface
    return this.mergeWalks(steps);
  }

  private mergeWalks(steps: PathStep[]): PathStep[] {
    const out: PathStep[] = [];
    for (const step of steps) {
      const prev = out.length > 0 ? out[out.length - 1] : undefined;
      if (step.action === 'walk' && prev?.action === 'walk' && Math.abs(prev.floorY - step.floorY) < 5) {
        prev.targetX = step.targetX; // keep the later target
      } else {
        out.push({ ...step });
      }
    }
    return out;
  }
}
