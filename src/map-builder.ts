import { DEFAULT_MAP, ALL_MAPS, saveMapToStorage, loadMapWithOverride, type MapDefinition } from './maps';
import { GameConfig } from './gameConfig';

// ── Layout constants ─────────────────────────────────────────────────────────

const TOWER_W  = GameConfig.towers.width;
const TOWER_H  = GameConfig.towers.height;
const GROUND_Y = GameConfig.groundY;
const WORLD_H  = GameConfig.canvas.height;

const DISPLAY_W = 1248;
const SCALE     = DISPLAY_W / DEFAULT_MAP.worldWidth;   // ≈ 0.444
const DISPLAY_H = Math.round(WORLD_H * SCALE);          // ≈ 213

// ── Types ────────────────────────────────────────────────────────────────────

type DragKind =
  | { kind: 'platform-move';   idx: number; ox: number; oy: number }
  | { kind: 'platform-left';   idx: number; origX: number; origW: number }
  | { kind: 'platform-right';  idx: number; origW: number }
  | { kind: 'block-move';      idx: number; ox: number; oy: number }
  | { kind: 'block-left';      idx: number; origX: number; origW: number }
  | { kind: 'block-right';     idx: number; origW: number }
  | { kind: 'coinbox';         ox: number; oy: number }
  | { kind: 'tower-player' }
  | { kind: 'tower-enemy' };

// ── MapBuilder class ─────────────────────────────────────────────────────────

class MapBuilder {
  private map: MapDefinition;
  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private selected:     number | null        = null;
  private selectedKind: 'platform' | 'block' = 'platform';
  private drag: DragKind | null              = null;
  private mouseX = 0;
  private mouseY = 0;

  constructor() {
    this.map    = structuredClone(loadMapWithOverride(DEFAULT_MAP));
    this.canvas = document.getElementById('builder-canvas') as HTMLCanvasElement;
    this.canvas.width  = DISPLAY_W;
    this.canvas.height = DISPLAY_H;
    this.ctx2d  = this.canvas.getContext('2d')!;

    this.bindControls();
    this.bindCanvas();
    this.populatePresets();
    this.syncInputsFromMap();
    this.loop();
  }

  // ── World ↔ Canvas transforms ─────────────────────────────────────────────

  private wx(worldX: number): number { return worldX * SCALE; }
  private wy(worldY: number): number { return worldY * SCALE; }
  private cw(canvasX: number): number { return canvasX / SCALE; }
  private ch(canvasY: number): number { return canvasY / SCALE; }

  // ── Render ────────────────────────────────────────────────────────────────

  private loop() {
    this.render();
    requestAnimationFrame(() => this.loop());
  }

  private render() {
    const ctx = this.ctx2d;
    const m   = this.map;

    ctx.clearRect(0, 0, DISPLAY_W, DISPLAY_H);

    // Sky
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

    // Mountains (simplified shape)
    ctx.fillStyle = '#2d2d44';
    const fracs = [0, 0.037, 0.074, 0.111, 0.157, 0.204, 0.25, 0.296, 0.343, 0.389, 0.426, 1];
    const mys   = [200, 140, 180, 130, 160, 120, 155, 135, 165, 140, 170, 200];
    ctx.beginPath();
    ctx.moveTo(0, this.wy(GROUND_Y));
    for (let i = 0; i < fracs.length; i++) {
      ctx.lineTo(this.wx(fracs[i] * m.worldWidth), this.wy(mys[i]));
    }
    ctx.lineTo(this.wx(m.worldWidth), this.wy(GROUND_Y));
    ctx.closePath();
    ctx.fill();

    // Ground
    ctx.fillStyle = '#4a7c59';
    ctx.fillRect(0, this.wy(GROUND_Y), DISPLAY_W, DISPLAY_H - this.wy(GROUND_Y));
    ctx.fillStyle = '#3d6b4a';
    ctx.fillRect(0, this.wy(GROUND_Y), DISPLAY_W, this.wy(6));

    // Player tower
    ctx.fillStyle = '#00b4d8';
    ctx.fillRect(
      this.wx(m.playerTowerX - TOWER_W / 2),
      this.wy(GROUND_Y - TOWER_H),
      this.wx(TOWER_W),
      this.wy(TOWER_H),
    );
    ctx.strokeStyle = '#007fa3';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      this.wx(m.playerTowerX - TOWER_W / 2),
      this.wy(GROUND_Y - TOWER_H),
      this.wx(TOWER_W),
      this.wy(TOWER_H),
    );

    // Enemy tower
    ctx.fillStyle = '#e63946';
    ctx.fillRect(
      this.wx(m.enemyTowerX - TOWER_W / 2),
      this.wy(GROUND_Y - TOWER_H),
      this.wx(TOWER_W),
      this.wy(TOWER_H),
    );
    ctx.strokeStyle = '#a02830';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      this.wx(m.enemyTowerX - TOWER_W / 2),
      this.wy(GROUND_Y - TOWER_H),
      this.wx(TOWER_W),
      this.wy(TOWER_H),
    );

    // Blocks (drawn below platforms so platforms render on top)
    for (let i = 0; i < m.blocks.length; i++) {
      const b   = m.blocks[i];
      const sel = this.selectedKind === 'block' && i === this.selected;
      ctx.fillStyle   = sel ? '#a5b4fc' : '#6b7280';
      ctx.strokeStyle = sel ? '#6366f1' : '#374151';
      ctx.lineWidth   = sel ? 2 : 1;
      ctx.fillRect(this.wx(b.x), this.wy(b.y), this.wx(b.width), this.wy(b.height));
      ctx.strokeRect(this.wx(b.x), this.wy(b.y), this.wx(b.width), this.wy(b.height));

      if (sel) {
        const hw = 6, hh = 10;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(this.wx(b.x) - hw / 2,           this.wy(b.y + b.height / 2) - hh / 2, hw, hh);
        ctx.fillRect(this.wx(b.x + b.width) - hw / 2, this.wy(b.y + b.height / 2) - hh / 2, hw, hh);
      }
    }

    // Platforms
    for (let i = 0; i < m.platforms.length; i++) {
      const p   = m.platforms[i];
      const sel = i === this.selected;
      ctx.fillStyle   = sel ? '#f5c542' : '#8B5E3C';
      ctx.strokeStyle = sel ? '#e0a500' : '#5c3322';
      ctx.lineWidth   = sel ? 2 : 1;
      ctx.beginPath();
      ctx.rect(this.wx(p.x), this.wy(p.y), this.wx(p.width), this.wy(p.height));
      ctx.fill();
      ctx.stroke();

      // Resize handles on selected platform
      if (sel) {
        const hw = 6, hh = 10;
        ctx.fillStyle = '#ffffff';
        // Left handle
        ctx.fillRect(this.wx(p.x) - hw / 2, this.wy(p.y + p.height / 2) - hh / 2, hw, hh);
        // Right handle
        ctx.fillRect(this.wx(p.x + p.width) - hw / 2, this.wy(p.y + p.height / 2) - hh / 2, hw, hh);
      }
    }

    // Coin box
    const cb = m.coinBox;
    ctx.fillStyle   = '#c8790a';
    ctx.strokeStyle = '#7a4a06';
    ctx.lineWidth   = 2;
    ctx.fillRect(this.wx(cb.x - cb.width / 2), this.wy(cb.y), this.wx(cb.width), this.wy(cb.height));
    ctx.strokeRect(this.wx(cb.x - cb.width / 2), this.wy(cb.y), this.wx(cb.width), this.wy(cb.height));

    // Coin box label
    ctx.fillStyle  = '#fff';
    ctx.font       = `bold ${Math.max(8, Math.round(9 * SCALE))}px monospace`;
    ctx.textAlign  = 'center';
    ctx.fillText('★', this.wx(cb.x), this.wy(cb.y + cb.height / 2) + 4);

    // Cursor coords readout
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(4, 4, 100, 16);
    ctx.fillStyle = '#aaa';
    ctx.font      = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`x:${Math.round(this.cw(this.mouseX))} y:${Math.round(this.ch(this.mouseY))}`, 8, 15);
  }

  // ── Canvas interaction ────────────────────────────────────────────────────

  private bindCanvas() {
    this.canvas.addEventListener('mousemove',  e => this.onMouseMove(e));
    this.canvas.addEventListener('mousedown',  e => this.onMouseDown(e));
    this.canvas.addEventListener('mouseup',    () => this.onMouseUp());
    this.canvas.addEventListener('mouseleave', () => this.onMouseUp());
    this.canvas.style.cursor = 'crosshair';
  }

  private canvasPos(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onMouseMove(e: MouseEvent) {
    const [cx, cy] = this.canvasPos(e);
    this.mouseX = cx;
    this.mouseY = cy;
    const wx = this.cw(cx);
    const wy = this.ch(cy);

    if (!this.drag) return;
    const m = this.map;

    if (this.drag.kind === 'platform-move') {
      const p = m.platforms[this.drag.idx];
      p.x = Math.round(wx - this.drag.ox);
      p.y = Math.min(GROUND_Y - p.height, Math.round(wy - this.drag.oy));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'platform-left') {
      const p   = m.platforms[this.drag.idx];
      const dx  = wx - this.drag.origX;
      p.x       = Math.round(this.drag.origX + dx);
      p.width   = Math.max(40, Math.round(this.drag.origW - dx));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'platform-right') {
      const p = m.platforms[this.drag.idx];
      p.width = Math.max(40, Math.round(wx - p.x));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'block-move') {
      const b = m.blocks[this.drag.idx];
      b.x = Math.round(wx - this.drag.ox);
      b.y = Math.min(GROUND_Y - b.height, Math.round(wy - this.drag.oy));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'block-left') {
      const b  = m.blocks[this.drag.idx];
      const dx = wx - this.drag.origX;
      b.x      = Math.round(this.drag.origX + dx);
      b.width  = Math.max(40, Math.round(this.drag.origW - dx));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'block-right') {
      const b = m.blocks[this.drag.idx];
      b.width = Math.max(40, Math.round(wx - b.x));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'coinbox') {
      m.coinBox.x = Math.round(wx - this.drag.ox);
      m.coinBox.y = Math.min(GROUND_Y - m.coinBox.height, Math.round(wy - this.drag.oy));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'tower-player') {
      m.playerTowerX = Math.max(TOWER_W / 2 + 5, Math.round(wx));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'tower-enemy') {
      m.enemyTowerX = Math.min(m.worldWidth - TOWER_W / 2 - 5, Math.round(wx));
      this.syncInputsFromMap();
    }
  }

  private onMouseDown(e: MouseEvent) {
    const [cx, cy] = this.canvasPos(e);
    const wx = this.cw(cx);
    const wy = this.ch(cy);
    const m  = this.map;

    // Platforms (drawn on top of blocks, so checked first)
    const HANDLE_ZONE = 5;
    for (let i = 0; i < m.platforms.length; i++) {
      const p = m.platforms[i];
      if (Math.abs(cx - this.wx(p.x)) <= HANDLE_ZONE &&
          wy >= p.y && wy <= p.y + p.height) {
        this.selected = i; this.selectedKind = 'platform';
        this.drag = { kind: 'platform-left', idx: i, origX: p.x, origW: p.width };
        return;
      }
      if (Math.abs(cx - this.wx(p.x + p.width)) <= HANDLE_ZONE &&
          wy >= p.y && wy <= p.y + p.height) {
        this.selected = i; this.selectedKind = 'platform';
        this.drag = { kind: 'platform-right', idx: i, origW: p.width };
        return;
      }
      if (wx >= p.x && wx <= p.x + p.width && wy >= p.y && wy <= p.y + p.height) {
        this.selected = i; this.selectedKind = 'platform';
        this.drag = { kind: 'platform-move', idx: i, ox: wx - p.x, oy: wy - p.y };
        return;
      }
    }

    // Blocks
    for (let i = 0; i < m.blocks.length; i++) {
      const b = m.blocks[i];
      if (Math.abs(cx - this.wx(b.x)) <= HANDLE_ZONE &&
          wy >= b.y && wy <= b.y + b.height) {
        this.selected = i; this.selectedKind = 'block';
        this.drag = { kind: 'block-left', idx: i, origX: b.x, origW: b.width };
        return;
      }
      if (Math.abs(cx - this.wx(b.x + b.width)) <= HANDLE_ZONE &&
          wy >= b.y && wy <= b.y + b.height) {
        this.selected = i; this.selectedKind = 'block';
        this.drag = { kind: 'block-right', idx: i, origW: b.width };
        return;
      }
      if (wx >= b.x && wx <= b.x + b.width && wy >= b.y && wy <= b.y + b.height) {
        this.selected = i; this.selectedKind = 'block';
        this.drag = { kind: 'block-move', idx: i, ox: wx - b.x, oy: wy - b.y };
        return;
      }
    }

    // Coin box
    const cb = m.coinBox;
    if (wx >= cb.x - cb.width / 2 && wx <= cb.x + cb.width / 2 &&
        wy >= cb.y && wy <= cb.y + cb.height) {
      this.drag = { kind: 'coinbox', ox: wx - cb.x, oy: wy - cb.y };
      return;
    }

    // Player tower
    if (wx >= m.playerTowerX - TOWER_W / 2 && wx <= m.playerTowerX + TOWER_W / 2 &&
        wy >= GROUND_Y - TOWER_H && wy <= GROUND_Y) {
      this.drag = { kind: 'tower-player' };
      return;
    }

    // Enemy tower
    if (wx >= m.enemyTowerX - TOWER_W / 2 && wx <= m.enemyTowerX + TOWER_W / 2 &&
        wy >= GROUND_Y - TOWER_H && wy <= GROUND_Y) {
      this.drag = { kind: 'tower-enemy' };
      return;
    }

    // Click on empty space → deselect
    this.selected = null;
  }

  private onMouseUp() {
    this.drag = null;
  }

  // ── Control bindings ──────────────────────────────────────────────────────

  private bindControls() {
    document.getElementById('btn-add-platform')!.addEventListener('click', () => {
      const m = this.map;
      const cx = m.worldWidth / 2;
      m.platforms.push({ x: cx - 120, y: GROUND_Y - 140, width: 240, height: 14 });
      this.selected = m.platforms.length - 1;
      this.syncInputsFromMap();
    });

    document.getElementById('btn-delete-platform')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'platform') return;
      this.map.platforms.splice(this.selected, 1);
      this.selected = null;
      this.syncInputsFromMap();
    });

    document.getElementById('btn-add-block')!.addEventListener('click', () => {
      const m = this.map;
      const cx = m.worldWidth / 2;
      m.blocks.push({ x: cx - 100, y: GROUND_Y - 80, width: 200, height: 40 });
      this.selected = m.blocks.length - 1;
      this.selectedKind = 'block';
      this.syncInputsFromMap();
    });

    document.getElementById('btn-delete-block')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'block') return;
      this.map.blocks.splice(this.selected, 1);
      this.selected = null;
      this.syncInputsFromMap();
    });

    document.getElementById('btn-save-to-game')!.addEventListener('click', () => {
      saveMapToStorage(this.map);
      const btn = document.getElementById('btn-save-to-game') as HTMLButtonElement;
      const orig = btn.textContent!;
      btn.textContent = '✓ Saved!';
      btn.disabled    = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    });

    document.getElementById('btn-export')!.addEventListener('click', () => {
      const json = JSON.stringify(this.map, null, 2);
      (document.getElementById('json-output') as HTMLTextAreaElement).value = json;
      navigator.clipboard?.writeText(json);
    });

    document.getElementById('btn-import')!.addEventListener('click', () => {
      const txt = (document.getElementById('json-input') as HTMLTextAreaElement).value.trim();
      try {
        const parsed = JSON.parse(txt) as MapDefinition;
        this.map     = parsed;
        this.selected = null;
        this.syncInputsFromMap();
      } catch {
        alert('Invalid JSON — could not import map.');
      }
    });

    // Map name input
    document.getElementById('input-name')!.addEventListener('input', e => {
      this.map.name = (e.target as HTMLInputElement).value;
    });

    // Number inputs for selected platform
    ['plat-x', 'plat-y', 'plat-w', 'plat-h'].forEach(id => {
      document.getElementById(`input-${id}`)!.addEventListener('change', () => this.readPlatformInputs());
    });

    // Number inputs for selected block
    ['block-x', 'block-y', 'block-w', 'block-h'].forEach(id => {
      document.getElementById(`input-${id}`)!.addEventListener('change', () => this.readBlockInputs());
    });

    // Coin box inputs
    ['cb-x', 'cb-y', 'cb-w', 'cb-h', 'cb-spread'].forEach(id => {
      document.getElementById(`input-${id}`)!.addEventListener('change', () => this.readCoinBoxInputs());
    });

    // Tower inputs
    document.getElementById('input-player-x')!.addEventListener('change', () => {
      this.map.playerTowerX = parseInt((document.getElementById('input-player-x') as HTMLInputElement).value, 10);
    });
    document.getElementById('input-enemy-x')!.addEventListener('change', () => {
      this.map.enemyTowerX = parseInt((document.getElementById('input-enemy-x') as HTMLInputElement).value, 10);
    });

    // Delete key
    window.addEventListener('keydown', e => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected !== null) {
        if (this.selectedKind === 'platform') this.map.platforms.splice(this.selected, 1);
        else                                  this.map.blocks.splice(this.selected, 1);
        this.selected = null;
        this.syncInputsFromMap();
      }
    });
  }

  private populatePresets() {
    const sel = document.getElementById('preset-select') as HTMLSelectElement;
    for (const m of ALL_MAPS) {
      const opt   = document.createElement('option');
      opt.value   = m.id;
      opt.text    = m.name;
      sel.appendChild(opt);
    }
    sel.value = this.map.id;   // reflect the currently loaded map
    sel.addEventListener('change', () => {
      const found = ALL_MAPS.find(m => m.id === sel.value);
      // Load the saved version of the preset if one exists, so edits aren't lost on switch.
      if (found) { this.map = structuredClone(loadMapWithOverride(found)); this.selected = null; this.syncInputsFromMap(); }
    });
  }

  private readPlatformInputs() {
    if (this.selected === null) return;
    const p = this.map.platforms[this.selected];
    p.x      = parseInt((document.getElementById('input-plat-x') as HTMLInputElement).value, 10);
    p.y      = parseInt((document.getElementById('input-plat-y') as HTMLInputElement).value, 10);
    p.width  = parseInt((document.getElementById('input-plat-w') as HTMLInputElement).value, 10);
    p.height = parseInt((document.getElementById('input-plat-h') as HTMLInputElement).value, 10);
  }

  private readBlockInputs() {
    if (this.selected === null || this.selectedKind !== 'block') return;
    const b = this.map.blocks[this.selected];
    b.x      = parseInt((document.getElementById('input-block-x') as HTMLInputElement).value, 10);
    b.y      = parseInt((document.getElementById('input-block-y') as HTMLInputElement).value, 10);
    b.width  = parseInt((document.getElementById('input-block-w') as HTMLInputElement).value, 10);
    b.height = parseInt((document.getElementById('input-block-h') as HTMLInputElement).value, 10);
  }

  private readCoinBoxInputs() {
    const cb     = this.map.coinBox;
    cb.x         = parseInt((document.getElementById('input-cb-x')      as HTMLInputElement).value, 10);
    cb.y         = parseInt((document.getElementById('input-cb-y')      as HTMLInputElement).value, 10);
    cb.width     = parseInt((document.getElementById('input-cb-w')      as HTMLInputElement).value, 10);
    cb.height    = parseInt((document.getElementById('input-cb-h')      as HTMLInputElement).value, 10);
    cb.spreadDeg = parseFloat((document.getElementById('input-cb-spread') as HTMLInputElement).value);
  }

  private syncInputsFromMap() {
    const m = this.map;

    (document.getElementById('input-name')     as HTMLInputElement).value = m.name;
    (document.getElementById('input-player-x') as HTMLInputElement).value = String(m.playerTowerX);
    (document.getElementById('input-enemy-x')  as HTMLInputElement).value = String(m.enemyTowerX);

    const cb = m.coinBox;
    (document.getElementById('input-cb-x')      as HTMLInputElement).value = String(cb.x);
    (document.getElementById('input-cb-y')      as HTMLInputElement).value = String(cb.y);
    (document.getElementById('input-cb-w')      as HTMLInputElement).value = String(cb.width);
    (document.getElementById('input-cb-h')      as HTMLInputElement).value = String(cb.height);
    (document.getElementById('input-cb-spread') as HTMLInputElement).value = String(cb.spreadDeg);

    const platPanel   = document.getElementById('plat-panel')!;
    const blockPanel  = document.getElementById('block-panel')!;

    const platSel = this.selected !== null && this.selectedKind === 'platform' && this.selected < m.platforms.length;
    if (platSel) {
      const p = m.platforms[this.selected!];
      platPanel.style.display = 'flex';
      (document.getElementById('input-plat-x') as HTMLInputElement).value = String(p.x);
      (document.getElementById('input-plat-y') as HTMLInputElement).value = String(p.y);
      (document.getElementById('input-plat-w') as HTMLInputElement).value = String(p.width);
      (document.getElementById('input-plat-h') as HTMLInputElement).value = String(p.height);
      document.getElementById('plat-label')!.textContent = `Platform ${this.selected! + 1}`;
    } else {
      platPanel.style.display = 'none';
    }

    const blockSel = this.selected !== null && this.selectedKind === 'block' && this.selected < m.blocks.length;
    if (blockSel) {
      const b = m.blocks[this.selected!];
      blockPanel.style.display = 'flex';
      (document.getElementById('input-block-x') as HTMLInputElement).value = String(b.x);
      (document.getElementById('input-block-y') as HTMLInputElement).value = String(b.y);
      (document.getElementById('input-block-w') as HTMLInputElement).value = String(b.width);
      (document.getElementById('input-block-h') as HTMLInputElement).value = String(b.height);
      document.getElementById('block-label')!.textContent = `Block ${this.selected! + 1}`;
    } else {
      blockPanel.style.display = 'none';
    }

    document.getElementById('plat-count')!.textContent  = `${m.platforms.length} platform(s)`;
    document.getElementById('block-count')!.textContent = `${m.blocks.length} block(s)`;
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => new MapBuilder());
