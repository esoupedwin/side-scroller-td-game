import type { Character } from './Character';
import type { PlatformData } from './Platform';
import type { BlockData } from './Block';
import { GROUND_Y, JUMP_VELOCITY, CHAR_GRAVITY } from './constants';

const MAX_JUMP_HEIGHT = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * CHAR_GRAVITY) - 10;

type EntryCategory = 'event' | 'anomaly' | 'snapshot';

interface LogEntry {
  t:        number;
  category: EntryCategory;
  msg:      string;
  data?:    Record<string, unknown>;
}

interface CharSnapshot {
  id:       number;
  name:     string;
  side:     string;
  type:     string;
  rank:     number;
  hp:       number;
  maxHp:    number;
  x:        number;
  y:        number;
  floorY:   number;
  airborne: boolean;
  behavior: string;
  state:    string;
  pathLen:  number;
  pathStep: string | null;
}

interface TickInput {
  time:      number;
  chars:     Character[];
  platforms: PlatformData[];
  blocks:    BlockData[];
}

interface CharTrack {
  lastAirborneLogTime: number;
  lastStuckLogTime:    number;
  lastThrashLogTime:   number;
  lastBehavior:        string;
  lastState:           string;
  noMoveSince:         number;
  lastX:               number;
  // Counter snapshots from the start of the current "no-move" window.
  noMoveClamps:        number;
  noMoveRebuilds:      number;
  // Sliding 1-second window for path-rebuild rate.
  rebuildWindowStart:  number;
  rebuildWindowBase:   number;
}

const SNAPSHOT_INTERVAL_S = 1.5;
const ANOMALY_DEBOUNCE_S  = 2;
const STUCK_THRESHOLD_S   = 2;
const THRASH_REBUILDS_PER_SEC = 8;   // path rebuilt this often = something keeps clearing it

export class Diagnostics {
  private active            = false;
  private startedAtGameTime = 0;
  private log:               LogEntry[] = [];
  private nextSnapshotAt    = 0;
  private trackById:        Map<number, CharTrack> = new Map();
  private knownIds:         Set<number>            = new Set();

  isActive(): boolean { return this.active; }
  entryCount(): number { return this.log.length; }

  start(now: number) {
    this.active            = true;
    this.startedAtGameTime = now;
    this.log               = [];
    this.nextSnapshotAt    = now;
    this.trackById.clear();
    this.knownIds.clear();
    this.note(now, 'event', 'Diagnose mode started');
  }

  stop(now: number) {
    if (!this.active) return;
    this.note(now, 'event', 'Diagnose mode stopped');
    this.active = false;
  }

  /** Manual event log from outside (spawn, death, tower hit, etc.). */
  noteEvent(now: number, msg: string, data?: Record<string, unknown>) {
    if (!this.active) return;
    this.note(now, 'event', msg, data);
  }

  private note(now: number, category: EntryCategory, msg: string, data?: Record<string, unknown>) {
    this.log.push({ t: now, category, msg, data });
  }

  tick(input: TickInput) {
    if (!this.active) return;
    const { time, chars, platforms, blocks } = input;

    const liveIds = new Set<number>();
    for (const c of chars) {
      liveIds.add(c.id);
      if (!this.knownIds.has(c.id)) {
        this.note(time, 'event', `Spawn #${c.id} ${c.name} (${c.side} ${c.config.type})`);
      }
    }
    for (const id of this.knownIds) {
      if (!liveIds.has(id)) this.note(time, 'event', `Despawn #${id}`);
    }
    this.knownIds = liveIds;

    for (const c of chars) {
      const info = c.diagnosticInfo;
      let track = this.trackById.get(c.id);
      if (!track) {
        track = {
          lastAirborneLogTime: -Infinity,
          lastStuckLogTime:    -Infinity,
          lastThrashLogTime:   -Infinity,
          lastBehavior:        c.behavior,
          lastState:           c.state,
          noMoveSince:         time,
          lastX:               c.x,
          noMoveClamps:        info.clampedCount,
          noMoveRebuilds:      info.pathRebuildCount,
          rebuildWindowStart:  time,
          rebuildWindowBase:   info.pathRebuildCount,
        };
        this.trackById.set(c.id, track);
      }

      // Behavior / state transitions
      if (c.behavior !== track.lastBehavior) {
        this.note(time, 'event', `Behavior #${c.id} ${c.name}: ${track.lastBehavior} → ${c.behavior}`);
        track.lastBehavior = c.behavior;
      }
      if (c.state !== track.lastState) {
        this.note(time, 'event', `State #${c.id} ${c.name}: ${track.lastState} → ${c.state}`);
        track.lastState = c.state;
      }

      // Jump outcomes: every landing produced since the previous tick.
      for (const o of c.consumeJumpOutcomes()) {
        const onTarget = Math.abs(o.landFloorY - o.targetFloorY) < 1;
        const targetSurface =
          o.targetFloorY >= GROUND_Y - 1 ? 'ground' :
          blocks.some(b => Math.abs(b.y - o.targetFloorY) < 1) ? 'block' :
          platforms.some(p => Math.abs(p.y - o.targetFloorY) < 1) ? 'platform' : 'unknown';
        const landSurface =
          o.landFloorY >= GROUND_Y - 1 ? 'ground' :
          blocks.some(b => Math.abs(b.y - o.landFloorY) < 1) ? 'block' :
          platforms.some(p => Math.abs(p.y - o.landFloorY) < 1) ? 'platform' : 'unknown';
        const actualTravel  = o.landX - o.startX;
        const sumOfDeltas   = o.expectedTravel + o.knockbackTravel;
        const unexplained   = actualTravel - sumOfDeltas;
        const data = {
          startX:          round(o.startX),
          startFloorY:     round(o.startFloorY),
          targetX:         round(o.targetX),
          targetFloorY:    round(o.targetFloorY),
          targetSurface,
          landX:           round(o.landX),
          landFloorY:      round(o.landFloorY),
          landSurface,
          xOvershoot:      round(o.landX - o.targetX),
          jumpVx:          round(o.jumpVx),
          ticks:           o.ticks,
          durationS:       Number(o.durationS.toFixed(3)),
          actualTravel:    round(actualTravel),
          jumpVxTravel:    round(o.expectedTravel),       // sum of jumpVx*dt
          knockbackTravel: round(o.knockbackTravel),
          unexplainedX:    round(unexplained),            // actual − (jumpVx*dt + knockback*dt)
          dtMinMs:         Number((o.dtMin * 1000).toFixed(2)),
          dtMaxMs:         Number((o.dtMax * 1000).toFixed(2)),
          dtAvgMs:         o.ticks > 0 ? Number(((o.durationS / o.ticks) * 1000).toFixed(2)) : 0,
        };
        if (onTarget) {
          this.note(time, 'event', `Jump #${c.id} ${c.name}: hit ${targetSurface} (Δx=${data.xOvershoot})`, data);
        } else {
          this.note(time, 'anomaly', `Jump miss #${c.id} ${c.name}: aimed ${targetSurface} y=${data.targetFloorY}, landed ${landSurface} y=${data.landFloorY}`, data);
        }
      }

      // Walking-in-air anomaly: not airborne, on elevated surface, but no
      // platform/block matches both the character's x and floorY.
      if (!info.isAirborne && info.floorY < GROUND_Y - 0.5) {
        const onPlat  = platforms.some(p =>
          c.x >= p.x && c.x <= p.x + p.width && Math.abs(p.y - info.floorY) < 1);
        const onBlock = blocks.some(b =>
          c.x >= b.x && c.x <= b.x + b.width && Math.abs(b.y - info.floorY) < 1);
        if (!onPlat && !onBlock && time - track.lastAirborneLogTime > ANOMALY_DEBOUNCE_S) {
          track.lastAirborneLogTime = time;
          this.note(time, 'anomaly', `Walking in air: #${c.id} ${c.name}`, {
            x: round(c.x), y: round(c.y), floorY: round(info.floorY),
            behavior: c.behavior, state: c.state,
          });
        }
      }

      // Stuck-with-active-path anomaly. Triggers when the character has a
      // current path but x hasn't moved for STUCK_THRESHOLD_S.
      if (info.pathLen > 0 && !info.isAirborne) {
        if (Math.abs(c.x - track.lastX) > 4) {
          track.noMoveSince     = time;
          track.lastX           = c.x;
          track.noMoveClamps    = info.clampedCount;
          track.noMoveRebuilds  = info.pathRebuildCount;
        } else if (time - track.noMoveSince > STUCK_THRESHOLD_S
                && time - track.lastStuckLogTime > ANOMALY_DEBOUNCE_S * 2) {
          track.lastStuckLogTime = time;
          const windowS = (time - track.noMoveSince).toFixed(1);
          const clampDelta   = info.clampedCount     - track.noMoveClamps;
          const rebuildDelta = info.pathRebuildCount - track.noMoveRebuilds;
          this.note(time, 'anomaly',
            `Stuck (${windowS}s no movement, path active): #${c.id} ${c.name}`,
            buildBlockerContext(c, info, blocks, { clampsInWindow: clampDelta, pathRebuildsInWindow: rebuildDelta }));
        }
      } else {
        track.noMoveSince     = time;
        track.lastX           = c.x;
        track.noMoveClamps    = info.clampedCount;
        track.noMoveRebuilds  = info.pathRebuildCount;
      }

      // Path-thrash anomaly: path rebuilt many times in a 1-second window.
      // Triggers even when the path is being cleared every frame (so Stuck
      // can't fire). Carries the same blocker context as Stuck so a reviewer
      // can see WHY the path keeps thrashing.
      const windowDur = time - track.rebuildWindowStart;
      if (windowDur >= 1) {
        const rebuildsInWindow = info.pathRebuildCount - track.rebuildWindowBase;
        if (rebuildsInWindow >= THRASH_REBUILDS_PER_SEC
            && time - track.lastThrashLogTime > ANOMALY_DEBOUNCE_S) {
          track.lastThrashLogTime = time;
          this.note(time, 'anomaly',
            `Path thrash: #${c.id} ${c.name} rebuilt path ${rebuildsInWindow}× in ${windowDur.toFixed(1)}s`,
            buildBlockerContext(c, info, blocks, {
              rebuildsInThisWindow: rebuildsInWindow,
              clampedCountTotal:    info.clampedCount,
              pathRebuildsTotal:    info.pathRebuildCount,
            }));
        }
        track.rebuildWindowStart = time;
        track.rebuildWindowBase  = info.pathRebuildCount;
      }
    }

    for (const id of Array.from(this.trackById.keys())) {
      if (!liveIds.has(id)) this.trackById.delete(id);
    }

    if (time >= this.nextSnapshotAt) {
      this.nextSnapshotAt = time + SNAPSHOT_INTERVAL_S;
      const snaps: CharSnapshot[] = chars.map(c => {
        const info = c.diagnosticInfo;
        return {
          id:       c.id,
          name:     c.name,
          side:     c.side,
          type:     c.config.type,
          rank:     c.rank,
          hp:       Math.round(c.hp),
          maxHp:    Math.round(c.maxHp),
          x:        round(c.x),
          y:        round(c.y),
          floorY:   round(info.floorY),
          airborne: info.isAirborne,
          behavior: c.behavior,
          state:    c.state,
          pathLen:  info.pathLen,
          pathStep: info.pathStep
            ? `${info.pathStep.action}→x${Math.round(info.pathStep.targetX)}@y${Math.round(info.pathStep.floorY)}`
            : null,
        };
      });
      this.log.push({ t: time, category: 'snapshot', msg: 'snapshot', data: { chars: snaps } });
    }
  }

  produceMarkdown(): string {
    const lines: string[] = [];
    lines.push('# Tower Defence — Diagnostic Report');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Entries: ${this.log.length}`);

    if (this.log.length === 0) {
      lines.push('');
      lines.push('_No events recorded. Click "Diagnose" to begin logging, then play for a while._');
      return lines.join('\n') + '\n';
    }

    const start = this.startedAtGameTime;
    const end   = this.log[this.log.length - 1].t;
    lines.push(`Span: ${formatTime(start)} → ${formatTime(end)} (${(end - start).toFixed(1)}s of game time)`);
    lines.push('');

    const events    = this.log.filter(l => l.category === 'event');
    const anomalies = this.log.filter(l => l.category === 'anomaly');
    const snapshots = this.log.filter(l => l.category === 'snapshot');

    lines.push(`## Anomalies (${anomalies.length})`);
    lines.push('');
    lines.push('Automatically detected behavior that likely indicates a bug.');
    lines.push('');
    if (anomalies.length === 0) {
      lines.push('_None detected during this session._');
    } else {
      for (const a of anomalies) {
        lines.push(`- \`${formatTime(a.t)}\` **${a.msg}**${formatData(a.data)}`);
      }
    }
    lines.push('');

    lines.push(`## Events (${events.length})`);
    lines.push('');
    if (events.length === 0) {
      lines.push('_None._');
    } else {
      for (const e of events) {
        lines.push(`- \`${formatTime(e.t)}\` ${e.msg}${formatData(e.data)}`);
      }
    }
    lines.push('');

    lines.push(`## Snapshots (${snapshots.length}, every ${SNAPSHOT_INTERVAL_S}s)`);
    lines.push('');
    for (const s of snapshots) {
      const chars = (s.data as { chars: CharSnapshot[] }).chars;
      lines.push(`### \`${formatTime(s.t)}\` — ${chars.length} live`);
      lines.push('');
      if (chars.length === 0) {
        lines.push('_(no live characters)_');
        lines.push('');
        continue;
      }
      lines.push('| ID | Name | Side | Type | Behavior | State | x | y | floorY | air | hp | path |');
      lines.push('|---:|------|------|------|----------|-------|--:|--:|-------:|:---:|----|------|');
      for (const c of chars) {
        const path = c.pathLen > 0 ? `${c.pathLen}: ${c.pathStep ?? ''}` : '—';
        lines.push(`| ${c.id} | ${c.name} | ${c.side} | ${c.type} | ${c.behavior} | ${c.state} | ${c.x} | ${c.y} | ${c.floorY} | ${c.airborne ? '✓' : ''} | ${c.hp}/${c.maxHp} | ${path} |`);
      }
      lines.push('');
    }

    return lines.join('\n') + '\n';
  }
}

function round(n: number): number { return Math.round(n); }

type CharLike = { id: number; name: string; x: number; y: number; behavior: string; state: string };
type DiagInfo = Character['diagnosticInfo'];

function formatPath(steps: { action: string; targetX: number; floorY: number; jumpTriggerX?: number }[]): string {
  if (steps.length === 0) return '(empty)';
  return steps.map(s =>
    s.action === 'jump'
      ? `jump@x${Math.round(s.jumpTriggerX ?? s.targetX)}→x${Math.round(s.targetX)}@y${Math.round(s.floorY)}`
      : `${s.action}→x${Math.round(s.targetX)}@y${Math.round(s.floorY)}`,
  ).join(' | ');
}

/**
 * Build the rich context payload shared by Stuck and Path-thrash anomalies.
 * Includes both the current and last-built paths, jump-step presence,
 * nearest-block geometry and jumpability.
 */
function buildBlockerContext(
  c: CharLike,
  info: DiagInfo,
  blocks: BlockData[],
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const remaining = info.pathRemaining;
  const lastBuilt = info.lastBuiltPath;
  const hasJumpStep     = remaining.some(s => s.action === 'jump');
  const lastHadJumpStep = lastBuilt.some(s => s.action === 'jump');
  const nearest = nearestBlockOnAxis(c.x, blocks);
  const nearestBlockInfo = nearest
    ? {
        gap:      Math.round(nearest.gap),
        side:     nearest.side,
        x:        Math.round(nearest.block.x),
        y:        Math.round(nearest.block.y),
        width:    Math.round(nearest.block.width),
        height:   Math.round(nearest.block.height),
        topAbove: Math.round(GROUND_Y - nearest.block.y),
        jumpable: (GROUND_Y - nearest.block.y) <= MAX_JUMP_HEIGHT,
      }
    : null;
  return {
    x: round(c.x), y: round(c.y), floorY: round(info.floorY),
    behavior: c.behavior, state: c.state,
    pathLen: info.pathLen, hasJumpStep, path: formatPath(remaining),
    lastBuiltPathLen: lastBuilt.length, lastHadJumpStep, lastBuiltPath: formatPath(lastBuilt),
    nearestBlock: nearestBlockInfo,
    maxJumpHeight: Math.round(MAX_JUMP_HEIGHT),
    ...extra,
  };
}

/**
 * Returns the block whose horizontal span is nearest the character's x
 * (touching counts as gap=0). `side` is which side of the block the
 * character sits on, useful for understanding clamp/jump geometry.
 */
function nearestBlockOnAxis(x: number, blocks: BlockData[]):
  { block: BlockData; gap: number; side: 'left' | 'right' | 'inside' } | null {
  let best: { block: BlockData; gap: number; side: 'left' | 'right' | 'inside' } | null = null;
  for (const b of blocks) {
    let gap: number; let side: 'left' | 'right' | 'inside';
    if (x < b.x)              { gap = b.x - x;                   side = 'left'; }
    else if (x > b.x + b.width){ gap = x - (b.x + b.width);      side = 'right'; }
    else                       { gap = 0;                         side = 'inside'; }
    if (best === null || gap < best.gap) best = { block: b, gap, side };
  }
  return best;
}

function formatTime(t: number): string {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function formatData(d?: Record<string, unknown>): string {
  if (!d) return '';
  const parts = Object.entries(d).map(([k, v]) =>
    `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return ' — ' + parts.join(', ');
}
