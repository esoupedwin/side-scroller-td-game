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
  action:        'walk' | 'jump' | 'fall' | 'drop';
  targetX:       number;  // destination X on this step's target surface
  floorY:        number;  // floor Y of the target surface
  jumpTriggerX?: number;  // for jump: walk here first, then jump
  sourceFloorY?: number;  // for jump: floor the character should be on at trigger time;
                          // followPath re-plans if the character has drifted off it.
}

// ── Physics limits (derived from game constants) ─────────────────────────────

// True apex is JUMP_VELOCITY² / (2·CHAR_GRAVITY) ≈ 169 px. Subtract a margin so
// the planner only creates edges the character can actually clear with room to
// drop through the target platform's top during descent — without the margin,
// edges close to the apex are physically unreachable (feet stop just short) and
// the character lands on whatever intermediate surface is in the way.
const MAX_JUMP_HEIGHT = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * CHAR_GRAVITY) - 10; // ≈ 159 px
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

// Fallback speed for positioning the jump trigger when a caller doesn't pass
// a character-specific moveSpeed. Errs toward slower characters.
const DEFAULT_JUMP_SPEED = 80;   // px/s

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
  private surfaces:    NavSurface[]            = [];
  private edges:       Map<number, SurfEdge[]> = new Map();
  private surfaceById: Map<number, NavSurface> = new Map();

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
    this.surfaces    = [];
    this.edges       = new Map();
    this.surfaceById = new Map();

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

    for (const s of this.surfaces) {
      this.edges.set(s.id, []);
      this.surfaceById.set(s.id, s);
    }

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
   * Surface that contains (x, floorY). Returns null if x lies in a gap (e.g.
   * inside a solid block's horizontal span on a split surface). Callers that
   * want a "best effort" surface should use snapToNearestSurface.
   */
  surfaceAt(floorY: number, x?: number): NavSurface | null {
    for (const s of this.surfaces) {
      if (Math.abs(s.y - floorY) >= 15) continue;
      if (x === undefined) return s;
      if (x >= s.x && x <= s.x + s.width) return s;
    }
    return null;
  }

  /**
   * Snap an (x, floorY) to the nearest valid surface span at that floor. Used
   * when a character or path target falls inside a block — pathfinding can't
   * route to a position physically inside a block, so we aim at the closest
   * reachable x on the same floor.
   */
  private snapToNearestSurface(floorY: number, x: number): { surface: NavSurface; x: number } | null {
    let best: { surface: NavSurface; dist: number; x: number } | null = null;
    for (const s of this.surfaces) {
      if (Math.abs(s.y - floorY) >= 15) continue;
      const clampedX = Math.max(s.x, Math.min(s.x + s.width, x));
      const dist     = Math.abs(clampedX - x);
      if (!best || dist < best.dist) best = { surface: s, dist, x: clampedX };
    }
    return best;
  }

  /**
   * A* path from (fromX, fromFloorY) to (toX, toFloorY).
   * Returns a minimal list of PathSteps; falls back to a single walk step
   * when surfaces are unknown or unreachable.
   *
   * `jumpSpeed` controls where the jump trigger is placed — should be the
   * character's actual horizontal speed so the arc lands on the destination.
   * Defaults to DEFAULT_JUMP_SPEED for legacy callers.
   */
  findPath(
    fromX: number, fromFloorY: number,
    toX:   number, toFloorY: number,
    jumpSpeed: number = DEFAULT_JUMP_SPEED,
  ): PathStep[] {
    let fromSurf = this.surfaceAt(fromFloorY, fromX);
    let toSurf   = this.surfaceAt(toFloorY, toX);

    // Target inside a block at toFloorY: snap to the nearest reachable x so
    // the character heads for a valid spot instead of clamping forever.
    if (!toSurf) {
      const snapped = this.snapToNearestSurface(toFloorY, toX);
      if (snapped) {
        toSurf = snapped.surface;
        toX    = snapped.x;
      }
    }
    // Source position can also be transiently inside a block during clamp
    // transitions; route from the nearest valid edge.
    if (!fromSurf) {
      const snapped = this.snapToNearestSurface(fromFloorY, fromX);
      if (snapped) fromSurf = snapped.surface;
    }

    if (!fromSurf || !toSurf || fromSurf.id === toSurf.id) {
      return [{ action: 'walk', targetX: toX, floorY: toFloorY }];
    }

    const surfPath = this.astar(fromSurf.id, toSurf.id, toX, toFloorY);
    if (!surfPath || surfPath.length < 2) {
      return [{ action: 'walk', targetX: toX, floorY: toFloorY }];
    }

    return this.buildSteps(surfPath, fromX, toX, toFloorY, jumpSpeed);
  }

  // ── Private: A* over surfaces ─────────────────────────────────────────────

  private astar(fromId: number, toId: number, toX: number, toFloorY: number): number[] | null {
    const heuristic = (id: number) => {
      const s = this.surfaceById.get(id)!;
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

  private buildSteps(
    surfPath:  number[],
    fromX:     number,
    toX:       number,
    toFloorY:  number,
    jumpSpeed: number,
  ): PathStep[] {
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
        // Horizontal distance the character covers during the arc from jump start
        // to landing at this height. Scales with the character's own moveSpeed —
        // slow units (archers) and fast units (warriors) both target a reachable
        // spot instead of a fixed lead that fits only the fast units.
        const hDist = jumpSpeed * arcLandingTime(dy);
        let jumpTriggerX: number;
        let actualLandX = landX;

        if (next.solid) {
          // Solid block: trigger must be outside the block's x-span. Clamp the
          // landing X so the trigger sits just past the block's near edge — for
          // slow units this means landing near the edge rather than overshooting
          // and falling short of the centre.
          if (approachFromLeft) {
            actualLandX  = Math.min(landX, next.x + hDist - 1);
            jumpTriggerX = actualLandX - hDist;
          } else {
            actualLandX  = Math.max(landX, next.x + next.width - hDist + 1);
            jumpTriggerX = actualLandX + hDist;
          }
        } else {
          // One-way platform: characters can walk under it, so trigger directly
          // below the intended landing spot.
          jumpTriggerX = approachFromLeft ? landX - hDist : landX + hDist;
        }

        // Clamp the trigger to the source surface's x-span so the character
        // doesn't have to walk past the edge of `cur` to reach it. Falling off
        // the source mid-approach previously made the jump fire from a lower
        // floor than the pathfinder planned for — usually unreachable.
        jumpTriggerX = Math.max(cur.x, Math.min(cur.x + cur.width, jumpTriggerX));

        steps.push({ action: 'walk', targetX: jumpTriggerX, floorY: cur.y });
        steps.push({ action: 'jump', targetX: actualLandX, floorY: next.y, jumpTriggerX, sourceFloorY: cur.y });
        curX = actualLandX;
      } else if (!cur.solid && curX >= next.x && curX <= next.x + next.width) {
        // Drop straight down through the current platform — the destination
        // surface spans our current x, so there's no need to walk to the edge.
        // Only emitted for non-solid platforms; blocks always force walk-off.
        steps.push({ action: 'drop', targetX: curX, floorY: next.y });
        // curX unchanged — we land directly below.
      } else {
        // Walk to the fall-off edge, then fall. Pick the side closer to the final
        // destination toX rather than the precomputed edge — otherwise a character
        // who needs to keep travelling past `cur` can drop off the wrong edge and
        // walk straight back into whatever was in their way.
        const goingRight = toX > cur.x + cur.width / 2;
        const fallEdgeX  = goingRight ? cur.x + cur.width : cur.x;
        // Step past the edge so followPath's 5-px stop tolerance still leaves the
        // character past the boundary, where syncFromBody flips them airborne.
        const FALL_STEP_OFF = 10;
        const stepOffX  = goingRight ? fallEdgeX + FALL_STEP_OFF : fallEdgeX - FALL_STEP_OFF;
        const safeLandX = Math.max(next.x, Math.min(next.x + next.width, stepOffX));
        // Always clamp into the destination surface's span — even on the
        // last transition. If toX lies inside a block at next.y the fall
        // would otherwise drop the character into the block.
        const fallLandX  = isLastTransition
          ? Math.max(next.x, Math.min(next.x + next.width, toX))
          : safeLandX;
        steps.push({ action: 'walk', targetX: stepOffX, floorY: cur.y });
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
