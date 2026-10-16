import * as PIXI from 'pixi.js';
import {
  CHAR_CMD_BTN_RADIUS, CHAR_CMD_ARC_RADIUS, CHAR_CMD_HEAD_GAP,
  CHAR_CMD_BOX_WIDTH, CHAR_CMD_BOX_HEIGHT, CHAR_CMD_BOX_PAD, CHAR_CMD_BOX_CORNER, CHAR_CMD_BOX_LINE,
} from './constants';
import type { Character } from './Character';

/** The three behaviours a tap on a player unit can issue. */
export type CharCommand = 'collecting' | 'defend' | 'rush';

// Button order left → right across the arc. Angles are measured from the
// arc's centre (just above the unit's head), 0° = right, 90° = straight up,
// so the ring reads collect / defend / rush like the reference mock-up.
const BUTTONS: ReadonlyArray<{ cmd: CharCommand; file: string; angleDeg: number; fallback: string }> = [
  { cmd: 'collecting', file: 'command_collect', angleDeg: 150, fallback: '🪙' },
  { cmd: 'defend',     file: 'command_defend',  angleDeg: 90,  fallback: '🛡' },
  { cmd: 'rush',       file: 'command_rush',    angleDeg: 30,  fallback: '🗡' },
];
const ACTIVE_RING_COLOR = 0xffd166;

export type Bounds = { left: number; right: number; top: number; bottom: number };

/** The fixed hover / selection frame for any unit: CHAR_CMD_BOX_WIDTH ×
 *  CHAR_CMD_BOX_HEIGHT world px, centred on the unit, bottom at its feet. Same
 *  size for every type by design (the tap hit-test still uses visualBounds). */
export function unitBox(char: Character): Bounds {
  return { left: char.x - CHAR_CMD_BOX_WIDTH / 2, right: char.x + CHAR_CMD_BOX_WIDTH / 2, top: char.y - CHAR_CMD_BOX_HEIGHT, bottom: char.y };
}

/**
 * Redraw `g` as a corner-bracket box around `b` (world-space bounds, offset
 * by `ox, oy` into g's parent space): four white L-shapes, open sides. Used
 * for the selected unit (inside the ring) and the hover highlight (Game).
 */
export function drawCornerBox(g: PIXI.Graphics, b: Bounds, ox = 0, oy = 0, alpha = 1) {
  const l = b.left - CHAR_CMD_BOX_PAD - ox, r = b.right  + CHAR_CMD_BOX_PAD - ox;
  const t = b.top  - CHAR_CMD_BOX_PAD - oy, d = b.bottom + CHAR_CMD_BOX_PAD - oy;
  const c = Math.min(CHAR_CMD_BOX_CORNER, (r - l) / 2, (d - t) / 2);
  g.clear().lineStyle({ width: CHAR_CMD_BOX_LINE, color: 0xffffff, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
  g.moveTo(l, t + c).lineTo(l, t).lineTo(l + c, t);   // top-left
  g.moveTo(r - c, t).lineTo(r, t).lineTo(r, t + c);   // top-right
  g.moveTo(r, d - c).lineTo(r, d).lineTo(r - c, d);   // bottom-right
  g.moveTo(l + c, d).lineTo(l, d).lineTo(l, d - c);   // bottom-left
}

// The three PNGs are shared UI art (never part of a map's asset set), loaded
// once per session on the first ring and kept resident.
let texturesPromise: Promise<Map<CharCommand, PIXI.Texture>> | null = null;
function loadButtonTextures(): Promise<Map<CharCommand, PIXI.Texture>> {
  if (!texturesPromise) {
    texturesPromise = Promise.all(BUTTONS.map(b =>
      PIXI.Assets.load<PIXI.Texture>(`/sprites/misc/${b.file}.png`)
        .then(t => [b.cmd, t] as const)
        .catch(() => null),   // missing art → the Graphics fallback stays
    )).then(entries => new Map(entries.filter((e): e is readonly [CharCommand, PIXI.Texture] => e !== null)));
  }
  return texturesPromise;
}

/**
 * World-space command ring shown over a selected player unit: three circular
 * buttons on an arc above its head plus the fixed corner-bracket unit box.
 * Purely visual — Game does the pointer hit-testing through `hitTest` and owns
 * the selection, slow-mo and camera follow.
 */
export class CharCommandRing {
  readonly container = new PIXI.Container();
  private readonly box = new PIXI.Graphics();
  private readonly buttons: { cmd: CharCommand; node: PIXI.Container; active: PIXI.Graphics; x: number; y: number }[] = [];
  private destroyed = false;

  constructor() {
    this.container.visible = false;
    this.container.addChild(this.box);
    for (const def of BUTTONS) {
      const node = new PIXI.Container();
      const r    = CHAR_CMD_BTN_RADIUS;
      // Dark disc + emoji: the face until the PNG arrives (or if it never does).
      const disc = new PIXI.Graphics().beginFill(0x2b3345).lineStyle(3, 0x1a1f2e).drawCircle(0, 0, r).endFill();
      const glyph = new PIXI.Text(def.fallback, { fontSize: r * 1.1 });
      glyph.anchor.set(0.5);
      // Gold ring marking the unit's current behaviour.
      const active = new PIXI.Graphics().lineStyle(4, ACTIVE_RING_COLOR).drawCircle(0, 0, r + 4);
      active.visible = false;
      node.addChild(disc, glyph, active);
      this.container.addChild(node);
      this.buttons.push({ cmd: def.cmd, node, active, x: 0, y: 0 });
    }
    loadButtonTextures().then(tex => {
      if (this.destroyed) return;
      for (const b of this.buttons) {
        const t = tex.get(b.cmd);
        if (!t) continue;
        const sprite = new PIXI.Sprite(t);
        sprite.anchor.set(0.5);
        sprite.width = sprite.height = CHAR_CMD_BTN_RADIUS * 2;
        // Replace disc + glyph, keep the active ring on top.
        b.node.removeChildren(0, 2).forEach(c => c.destroy());
        b.node.addChildAt(sprite, 0);
      }
    });
  }

  /** Attach to `char`: lay the arc out for its height. */
  show(char: Character) {
    const headY = -(char.config.height + CHAR_CMD_HEAD_GAP);
    for (let i = 0; i < this.buttons.length; i++) {
      const b   = this.buttons[i];
      const rad = BUTTONS[i].angleDeg * Math.PI / 180;
      b.x = Math.cos(rad) * CHAR_CMD_ARC_RADIUS;
      b.y = headY - Math.sin(rad) * CHAR_CMD_ARC_RADIUS;
      b.node.position.set(b.x, b.y);
    }
    this.container.visible = true;
    this.update(char);
  }

  hide() { this.container.visible = false; }

  /** Per tick while shown: track the unit and highlight its behaviour. */
  update(char: Character | null) {
    if (!char || !this.container.visible) return;
    this.container.position.set(char.x, char.y);
    drawCornerBox(this.box, unitBox(char), char.x, char.y);
    for (const b of this.buttons) b.active.visible = char.behavior === b.cmd;
  }

  /** Which button (if any) a world-space point lands on. */
  hitTest(wx: number, wy: number): CharCommand | null {
    if (!this.container.visible) return null;
    const lx = wx - this.container.x, ly = wy - this.container.y;
    const r2 = (CHAR_CMD_BTN_RADIUS * 1.15) ** 2;   // a little slop for touch
    for (const b of this.buttons) {
      const dx = lx - b.x, dy = ly - b.y;
      if (dx * dx + dy * dy <= r2) return b.cmd;
    }
    return null;
  }

  destroy() {
    this.destroyed = true;
    this.container.destroy({ children: true });
  }
}
