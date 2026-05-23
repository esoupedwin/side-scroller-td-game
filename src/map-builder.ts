import { DEFAULT_MAP, ALL_MAPS, saveMapToStorage, loadMapWithOverride, type MapDefinition } from './maps';
import { GameConfig } from './gameConfig';

// ── Layout constants ─────────────────────────────────────────────────────────

const TOWER_W  = GameConfig.towers.width;
const TOWER_H  = GameConfig.towers.height;
const GROUND_Y = GameConfig.groundY;
const WORLD_H  = GameConfig.canvas.height;


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
  private skinImages = new Map<string, HTMLImageElement>();
  private scale          = 1;
  private panX           = 0;
  private panY           = 0;
  private isPanning      = false;
  private panLastX       = 0;
  private panLastY       = 0;
  private hasInitialFit  = false;
  private selectedTower: 'player' | 'enemy' | null = null;
  private selectedCoinBox    = false;
  private selectedGround     = false;
  private selectedBackground = false;

  constructor() {
    this.map    = structuredClone(loadMapWithOverride(DEFAULT_MAP));
    this.canvas = document.getElementById('builder-canvas') as HTMLCanvasElement;
    this.ctx2d  = this.canvas.getContext('2d')!;

    this.bindControls();
    this.bindCanvas();
    this.populatePresets();

    // Sidebar toggle
    const sidebar = document.getElementById('sidebar')!;
    const toggle  = document.getElementById('sidebar-toggle') as HTMLButtonElement;
    toggle.addEventListener('click', () => {
      const collapsed = sidebar.classList.toggle('collapsed');
      toggle.innerHTML  = collapsed ? '&#x276F;' : '&#x276E;';
      toggle.title      = collapsed ? 'Expand panel' : 'Collapse panel';
    });
    sidebar.addEventListener('transitionend', () => this.resizeCanvas());
    window.addEventListener('resize', () => this.resizeCanvas());

    this.resizeCanvas();
    this.syncInputsFromMap();
    this.loop();
  }

  // ── World ↔ Canvas transforms ─────────────────────────────────────────────

  // Position transforms (include pan offset)
  private wx(worldX: number): number { return worldX * this.scale + this.panX; }
  private wy(worldY: number): number { return worldY * this.scale + this.panY; }
  private cw(canvasX: number): number { return (canvasX - this.panX) / this.scale; }
  private ch(canvasY: number): number { return (canvasY - this.panY) / this.scale; }
  // Size transforms (scale only, no pan)
  private sw(worldW: number): number { return worldW * this.scale; }
  private sh(worldH: number): number { return worldH * this.scale; }

  private resizeCanvas() {
    const area = document.getElementById('canvas-area')!;
    const w    = Math.max(200, area.clientWidth);
    const h    = Math.max(100, area.clientHeight);
    if (!this.hasInitialFit) {
      this.canvas.width  = w;
      this.canvas.height = h;
      this.fitView();
      this.hasInitialFit = true;
      return;
    }
    // Skip if nothing changed — prevents the resize loop where setting
    // canvas.width triggers a layout change which fires window.resize again.
    if (w === this.canvas.width && h === this.canvas.height) return;
    const worldCX = this.cw(this.canvas.width  / 2);
    const worldCY = this.ch(this.canvas.height / 2);
    this.canvas.width  = w;
    this.canvas.height = h;
    this.panX = w / 2 - worldCX * this.scale;
    this.panY = h / 2 - worldCY * this.scale;
  }

  private fitView() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.scale = w / this.map.worldWidth;
    this.panX  = 0;
    this.panY  = (h - WORLD_H * this.scale) / 2;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private loop() {
    this.render();
    requestAnimationFrame(() => this.loop());
  }

  private render() {
    const ctx = this.ctx2d;
    const m   = this.map;
    const W   = this.canvas.width;
    const H   = this.canvas.height;

    // Void outside world bounds
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#07070f';
    ctx.fillRect(0, 0, W, H);

    const ww = this.sw(m.worldWidth);
    const wh = this.sh(WORLD_H);
    const wx0 = this.wx(0);
    const wy0 = this.wy(0);

    // Sky (world bounds only)
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(wx0, wy0, ww, wh);

    // Background parallax layer — PNG skin or procedural mountains
    if (m.backgroundSkin) {
      const img = this.getSkinImage(m.backgroundSkin);
      if (img.complete && img.naturalWidth > 0) {
        const yOff = this.sh(m.backgroundSkinY ?? 0);
        ctx.drawImage(img, wx0, wy0 + yOff, ww, this.sh(GROUND_Y));
      }
    } else {
      ctx.fillStyle = '#2d2d44';
      const fracs = [0, 0.037, 0.074, 0.111, 0.157, 0.204, 0.25, 0.296, 0.343, 0.389, 0.426, 1];
      const mys   = [200, 140, 180, 130, 160, 120, 155, 135, 165, 140, 170, 200];
      ctx.beginPath();
      ctx.moveTo(this.wx(0), this.wy(GROUND_Y));
      for (let i = 0; i < fracs.length; i++) {
        ctx.lineTo(this.wx(fracs[i] * m.worldWidth), this.wy(mys[i]));
      }
      ctx.lineTo(this.wx(m.worldWidth), this.wy(GROUND_Y));
      ctx.closePath();
      ctx.fill();
    }

    // Ground (world x-span only)
    const groundH = this.sh(WORLD_H - GROUND_Y);
    ctx.fillStyle = '#4a7c59';
    ctx.fillRect(wx0, this.wy(GROUND_Y), ww, groundH);
    ctx.fillStyle = '#3d6b4a';
    ctx.fillRect(wx0, this.wy(GROUND_Y), ww, Math.min(this.sh(6), groundH));

    // Ground skin (tiling pattern)
    if (m.groundSkin) {
      const img = this.getSkinImage(m.groundSkin);
      if (img.complete && img.naturalWidth > 0) {
        const pat = ctx.createPattern(img, 'repeat');
        if (pat) {
          const tileW = m.groundSkinTileW ?? img.naturalWidth;
          const tileH = m.groundSkinTileH ?? img.naturalHeight;
          pat.setTransform(new DOMMatrix([
            tileW / img.naturalWidth,  0,
            0, tileH / img.naturalHeight,
            0, 0,
          ]));
          ctx.save();
          ctx.beginPath();
          ctx.rect(wx0, this.wy(GROUND_Y), ww, groundH);
          ctx.clip();
          ctx.translate(this.panX, this.wy(GROUND_Y));
          ctx.scale(this.scale, this.scale);
          ctx.fillStyle = pat;
          ctx.fillRect(0, 0, m.worldWidth, WORLD_H - GROUND_Y);
          ctx.restore();
        }
      }
    }

    // Ground selection highlight
    if (this.selectedGround) {
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth   = 2;
      ctx.strokeRect(wx0, this.wy(GROUND_Y), ww, groundH);
    }

    // World border
    ctx.strokeStyle = '#2a2a3a';
    ctx.lineWidth   = 1;
    ctx.strokeRect(wx0, wy0, ww, wh);

    this.drawGrid();

    const drawTower = (cx: number, color: string, stroke: string, skinUrl?: string, tW: number = TOWER_W, tH: number = TOWER_H) => {
      const tx = this.wx(cx - tW / 2);
      const ty = this.wy(GROUND_Y - tH);
      const tw = this.sw(tW);
      const th = this.sh(tH);
      if (skinUrl) {
        const img = this.getSkinImage(skinUrl);
        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, tx, ty, tw, th);
          return;
        }
      }
      ctx.fillStyle   = color;
      ctx.strokeStyle = stroke;
      ctx.lineWidth   = 1;
      ctx.fillRect(tx, ty, tw, th);
      ctx.strokeRect(tx, ty, tw, th);
    };
    drawTower(m.playerTowerX, '#00b4d8', '#007fa3', m.playerTowerSkin, m.playerTowerSkinW, m.playerTowerSkinH);
    drawTower(m.enemyTowerX,  '#e63946', '#a02830', m.enemyTowerSkin,  m.enemyTowerSkinW,  m.enemyTowerSkinH);

    // Blocks
    for (let i = 0; i < m.blocks.length; i++) {
      const b   = m.blocks[i];
      const sel = this.selectedKind === 'block' && i === this.selected;
      const bx  = this.wx(b.x);
      const by  = this.wy(b.y);
      const bw  = this.sw(b.width);
      const bh  = this.sh(b.height);

      if (b.skin) {
        const img = this.getSkinImage(b.skin);
        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, bx, by, bw, bh);
        } else {
          ctx.fillStyle = '#444';
          ctx.fillRect(bx, by, bw, bh);
        }
      } else {
        ctx.fillStyle   = sel ? '#a5b4fc' : '#6b7280';
        ctx.strokeStyle = sel ? '#6366f1' : '#374151';
        ctx.lineWidth   = sel ? 2 : 1;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);
      }

      if (sel) {
        ctx.strokeStyle = '#6366f1';
        ctx.lineWidth   = 2;
        ctx.strokeRect(bx, by, bw, bh);
        const hw = 6, hh = 10;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(bx - hw / 2,      by + bh / 2 - hh / 2, hw, hh);
        ctx.fillRect(bx + bw - hw / 2, by + bh / 2 - hh / 2, hw, hh);
      }
    }

    // Platforms — draw in ascending zIndex order so higher-z platforms render on top.
    // Sorting is done on a temporary index array so the original array (and stored indices) stay stable.
    const platDrawOrder = m.platforms
      .map((_, i) => i)
      .sort((a, b) => (m.platforms[a].zIndex ?? 0) - (m.platforms[b].zIndex ?? 0));

    for (const i of platDrawOrder) {
      const p   = m.platforms[i];
      const sel = this.selectedKind === 'platform' && i === this.selected;
      const px  = this.wx(p.x);
      const py  = this.wy(p.y);
      const pw  = this.sw(p.width);
      const ph  = this.sh(p.height);

      if (p.skin) {
        const img = this.getSkinImage(p.skin);
        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, px, py, pw, ph);
        } else {
          // image not yet loaded — draw placeholder
          ctx.fillStyle = '#444';
          ctx.fillRect(px, py, pw, ph);
        }
      } else {
        ctx.fillStyle   = sel ? '#f5c542' : '#8B5E3C';
        ctx.strokeStyle = sel ? '#e0a500' : '#5c3322';
        ctx.lineWidth   = sel ? 2 : 1;
        ctx.beginPath();
        ctx.rect(px, py, pw, ph);
        ctx.fill();
        ctx.stroke();
      }

      if (sel) {
        // Selection outline + resize handles (drawn over skin or plain rect)
        ctx.strokeStyle = '#e0a500';
        ctx.lineWidth   = 2;
        ctx.strokeRect(px, py, pw, ph);
        const hw = 6, hh = 10;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(px - hw / 2,      py + ph / 2 - hh / 2, hw, hh);
        ctx.fillRect(px + pw - hw / 2, py + ph / 2 - hh / 2, hw, hh);
      }
    }

    // Coin box
    const cb = m.coinBox;
    ctx.fillStyle   = '#c8790a';
    ctx.strokeStyle = '#7a4a06';
    ctx.lineWidth   = 2;
    ctx.fillRect(this.wx(cb.x - cb.width / 2), this.wy(cb.y), this.sw(cb.width), this.sh(cb.height));
    ctx.strokeRect(this.wx(cb.x - cb.width / 2), this.wy(cb.y), this.sw(cb.width), this.sh(cb.height));
    ctx.fillStyle = '#fff';
    ctx.font      = `bold ${Math.max(10, Math.round(14 * this.scale))}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('★', this.wx(cb.x), this.wy(cb.y + cb.height / 2) + 4);

    // ── HUD ──────────────────────────────────────────────────────────────────
    const fitScale = W / m.worldWidth;
    const zoomPct  = Math.round((this.scale / fitScale) * 100);

    // Cursor coords (top-left)
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, 128, 18);
    ctx.fillStyle = '#99a';
    ctx.font      = '15px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`x:${Math.round(this.cw(this.mouseX))}  y:${Math.round(this.ch(this.mouseY))}`, 6, 12);

    // Zoom + hints (top-right)
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(W - 196, 0, 196, 18);
    ctx.fillStyle = '#99a';
    ctx.textAlign = 'right';
    ctx.fillText(`${zoomPct}%  scroll=zoom  RMB/MMB=pan  F=fit`, W - 6, 12);
  }

  // ── Grid overlay ─────────────────────────────────────────────────────────

  private gridInterval(): number {
    for (const iv of [25, 50, 100, 200, 500, 1000, 2000]) {
      if (iv * this.scale >= 60) return iv;
    }
    return 2000;
  }

  private drawGrid() {
    const ctx = this.ctx2d;
    const W   = this.canvas.width;
    const H   = this.canvas.height;
    const m   = this.map;
    const iv  = this.gridInterval();

    // Visible world range (clamped to world bounds)
    const vLeft   = Math.max(0,            this.cw(0));
    const vRight  = Math.min(m.worldWidth, this.cw(W));
    const vTop    = Math.max(0,            this.ch(0));
    const vBottom = Math.min(WORLD_H,      this.ch(H));
    if (vRight <= vLeft || vBottom <= vTop) return;

    const startX = Math.floor(vLeft / iv) * iv;
    const startY = Math.floor(vTop  / iv) * iv;

    // Grid lines clipped to world rect
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.wx(0), this.wy(0), this.sw(m.worldWidth), this.sh(WORLD_H));
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth   = 1;

    for (let x = startX; x <= vRight; x += iv) {
      const cx = this.wx(x);
      ctx.beginPath();
      ctx.moveTo(cx, Math.max(0,  this.wy(0)));
      ctx.lineTo(cx, Math.min(H,  this.wy(WORLD_H)));
      ctx.stroke();
    }
    for (let y = startY; y <= vBottom; y += iv) {
      const cy = this.wy(y);
      ctx.beginPath();
      ctx.moveTo(Math.max(0, this.wx(0)),            cy);
      ctx.lineTo(Math.min(W, this.wx(m.worldWidth)), cy);
      ctx.stroke();
    }
    ctx.restore();

    // Axis labels (outside clip so they can stick to the screen edge)
    ctx.font = '22px monospace';

    // X labels — pinned to just below the top of the world (clamped to canvas)
    const xLabY = Math.min(H - 22, Math.max(22, this.wy(0) + 22));
    ctx.textAlign = 'center';
    for (let x = startX; x <= vRight; x += iv) {
      const cx = this.wx(x);
      if (cx < 40 || cx > W - 40) continue;
      const label = String(x);
      const lw    = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(0,0,12,0.65)';
      ctx.fillRect(Math.round(cx - lw / 2), xLabY - 16, lw, 20);
      ctx.fillStyle = 'rgba(170,178,225,0.95)';
      ctx.fillText(label, cx, xLabY);
    }

    // Y labels — pinned to just right of the world's left edge (clamped to canvas)
    const yLabX = Math.min(W - 60, Math.max(2, this.wx(0) + 2));
    ctx.textAlign = 'left';
    for (let y = startY; y <= vBottom; y += iv) {
      const cy = this.wy(y);
      if (cy < 22 || cy > H - 8) continue;
      const label = String(y);
      const lw    = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(0,0,12,0.65)';
      ctx.fillRect(yLabX, Math.round(cy - 16), lw, 20);
      ctx.fillStyle = 'rgba(170,178,225,0.95)';
      ctx.fillText(label, yLabX + 4, cy);
    }
  }

  // ── Skin helpers ──────────────────────────────────────────────────────────

  private getSkinImage(url: string): HTMLImageElement {
    if (!this.skinImages.has(url)) {
      const img = new Image();
      img.src = url;
      this.skinImages.set(url, img);
    }
    return this.skinImages.get(url)!;
  }

  private syncPlatformSkinPreview() {
    const skin    = (this.selected !== null && this.selectedKind === 'platform')
                    ? this.map.platforms[this.selected]?.skin
                    : undefined;
    const preview = document.getElementById('preview-plat-skin') as HTMLImageElement;
    const clear   = document.getElementById('btn-clear-plat-skin') as HTMLButtonElement;
    if (skin) {
      preview.src           = skin;
      preview.style.display = 'inline';
      clear.style.display   = 'inline';
    } else {
      preview.style.display = 'none';
      clear.style.display   = 'none';
    }
    const fileInput = document.getElementById('input-plat-skin') as HTMLInputElement;
    if (!skin) fileInput.value = '';
  }

  private syncSkinPreviews() {
    const m = this.map;
    (['player', 'enemy'] as const).forEach(side => {
      const url     = side === 'player' ? m.playerTowerSkin : m.enemyTowerSkin;
      const preview = document.getElementById(`preview-${side}-skin`) as HTMLImageElement;
      const clear   = document.getElementById(`btn-clear-${side}-skin`) as HTMLButtonElement;
      if (url) {
        preview.src           = url;
        preview.style.display = 'inline';
        clear.style.display   = 'inline';
      } else {
        preview.style.display = 'none';
        clear.style.display   = 'none';
      }
    });
  }

  private syncBlockSkinPreview() {
    const skin    = (this.selected !== null && this.selectedKind === 'block')
                    ? this.map.blocks[this.selected]?.skin
                    : undefined;
    const preview = document.getElementById('preview-block-skin') as HTMLImageElement;
    const clear   = document.getElementById('btn-clear-block-skin') as HTMLButtonElement;
    if (skin) {
      preview.src           = skin;
      preview.style.display = 'inline';
      clear.style.display   = 'inline';
    } else {
      preview.style.display = 'none';
      clear.style.display   = 'none';
    }
    const fileInput = document.getElementById('input-block-skin') as HTMLInputElement;
    if (!skin) fileInput.value = '';
  }

  private syncBackgroundSkinPreview() {
    const url     = this.map.backgroundSkin;
    const preview = document.getElementById('preview-bg-skin') as HTMLImageElement;
    const clear   = document.getElementById('btn-clear-bg-skin') as HTMLButtonElement;
    if (url) {
      preview.src           = url;
      preview.style.display = 'inline';
      clear.style.display   = 'inline';
    } else {
      preview.style.display = 'none';
      clear.style.display   = 'none';
    }
    const fileInput = document.getElementById('input-bg-skin') as HTMLInputElement;
    if (!url) fileInput.value = '';
    (document.getElementById('input-bg-skin-y') as HTMLInputElement).value =
      String(this.map.backgroundSkinY ?? 0);
  }

  private syncGroundSkinPreview() {
    const url     = this.map.groundSkin;
    const preview = document.getElementById('preview-ground-skin') as HTMLImageElement;
    const clear   = document.getElementById('btn-clear-ground-skin') as HTMLButtonElement;
    if (url) {
      preview.src           = url;
      preview.style.display = 'inline';
      clear.style.display   = 'inline';
    } else {
      preview.style.display = 'none';
      clear.style.display   = 'none';
    }
    const fileInput = document.getElementById('input-ground-skin') as HTMLInputElement;
    if (!url) fileInput.value = '';
  }

  // ── Canvas interaction ────────────────────────────────────────────────────

  private bindCanvas() {
    this.canvas.addEventListener('mousemove',   e => this.onMouseMove(e));
    this.canvas.addEventListener('mousedown',   e => this.onMouseDown(e));
    this.canvas.addEventListener('mouseup',     e => this.onMouseUp(e));
    this.canvas.addEventListener('mouseleave',  e => this.onMouseUp(e));
    this.canvas.addEventListener('wheel',       e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.canvas.style.cursor = 'crosshair';
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const [cx, cy] = this.canvasPos(e);
    const factor   = e.deltaY < 0 ? 1.12 : (1 / 1.12);
    const wx = this.cw(cx);
    const wy = this.ch(cy);
    this.scale = Math.max(0.05, Math.min(12, this.scale * factor));
    this.panX  = cx - wx * this.scale;
    this.panY  = cy - wy * this.scale;
  }

  private canvasPos(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onMouseMove(e: MouseEvent) {
    const [cx, cy] = this.canvasPos(e);
    this.mouseX = cx;
    this.mouseY = cy;

    if (this.isPanning) {
      this.panX += e.clientX - this.panLastX;
      this.panY += e.clientY - this.panLastY;
      this.panLastX = e.clientX;
      this.panLastY = e.clientY;
      return;
    }

    const wx = this.cw(cx);
    const wy = this.ch(cy);
    const m  = this.map;

    if (!this.drag) {
      this.canvas.style.cursor = this.hoverCursor(cx, wx, wy, m);
      return;
    }

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
    this.canvas.style.cursor = 'grabbing';
  }

  private hoverCursor(cx: number, wx: number, wy: number, m: typeof this.map): string {
    const HANDLE_ZONE = 5;

    // Resize handles on platforms and blocks (left/right edges)
    for (const p of m.platforms) {
      if (wy >= p.y && wy <= p.y + p.height) {
        if (Math.abs(cx - this.wx(p.x)) <= HANDLE_ZONE ||
            Math.abs(cx - this.wx(p.x + p.width)) <= HANDLE_ZONE)
          return 'ew-resize';
        if (wx >= p.x && wx <= p.x + p.width) return 'grab';
      }
    }
    for (const b of m.blocks) {
      if (wy >= b.y && wy <= b.y + b.height) {
        if (Math.abs(cx - this.wx(b.x)) <= HANDLE_ZONE ||
            Math.abs(cx - this.wx(b.x + b.width)) <= HANDLE_ZONE)
          return 'ew-resize';
        if (wx >= b.x && wx <= b.x + b.width) return 'grab';
      }
    }

    // Coin box
    const cb = m.coinBox;
    if (wx >= cb.x - cb.width / 2 && wx <= cb.x + cb.width / 2 &&
        wy >= cb.y && wy <= cb.y + cb.height)
      return 'grab';

    // Towers
    if (wx >= m.playerTowerX - TOWER_W / 2 && wx <= m.playerTowerX + TOWER_W / 2 &&
        wy >= GROUND_Y - TOWER_H && wy <= GROUND_Y)
      return 'grab';
    if (wx >= m.enemyTowerX - TOWER_W / 2 && wx <= m.enemyTowerX + TOWER_W / 2 &&
        wy >= GROUND_Y - TOWER_H && wy <= GROUND_Y)
      return 'grab';

    return 'crosshair';
  }

  private onMouseDown(e: MouseEvent) {
    // Middle or right click → pan mode
    if (e.button === 1 || e.button === 2) {
      this.isPanning  = true;
      this.panLastX   = e.clientX;
      this.panLastY   = e.clientY;
      this.canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
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
        this.clearSelection(); this.selected = i; this.selectedKind = 'platform';
        this.drag = { kind: 'platform-left', idx: i, origX: p.x, origW: p.width };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cx - this.wx(p.x + p.width)) <= HANDLE_ZONE &&
          wy >= p.y && wy <= p.y + p.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'platform';
        this.drag = { kind: 'platform-right', idx: i, origW: p.width };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (wx >= p.x && wx <= p.x + p.width && wy >= p.y && wy <= p.y + p.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'platform';
        this.drag = { kind: 'platform-move', idx: i, ox: wx - p.x, oy: wy - p.y };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
    }

    // Blocks
    for (let i = 0; i < m.blocks.length; i++) {
      const b = m.blocks[i];
      if (Math.abs(cx - this.wx(b.x)) <= HANDLE_ZONE &&
          wy >= b.y && wy <= b.y + b.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'block';
        this.drag = { kind: 'block-left', idx: i, origX: b.x, origW: b.width };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cx - this.wx(b.x + b.width)) <= HANDLE_ZONE &&
          wy >= b.y && wy <= b.y + b.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'block';
        this.drag = { kind: 'block-right', idx: i, origW: b.width };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (wx >= b.x && wx <= b.x + b.width && wy >= b.y && wy <= b.y + b.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'block';
        this.drag = { kind: 'block-move', idx: i, ox: wx - b.x, oy: wy - b.y };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
    }

    // Coin box
    const cb = m.coinBox;
    if (wx >= cb.x - cb.width / 2 && wx <= cb.x + cb.width / 2 &&
        wy >= cb.y && wy <= cb.y + cb.height) {
      this.clearSelection(); this.selectedCoinBox = true;
      this.drag = { kind: 'coinbox', ox: wx - cb.x, oy: wy - cb.y };
      this.syncInputsFromMap();
      document.getElementById('section-coinbox')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // Player tower
    if (wx >= m.playerTowerX - TOWER_W / 2 && wx <= m.playerTowerX + TOWER_W / 2 &&
        wy >= GROUND_Y - TOWER_H && wy <= GROUND_Y) {
      this.clearSelection(); this.selectedTower = 'player';
      this.drag = { kind: 'tower-player' };
      this.syncInputsFromMap();
      document.getElementById('section-player-tower')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // Enemy tower
    if (wx >= m.enemyTowerX - TOWER_W / 2 && wx <= m.enemyTowerX + TOWER_W / 2 &&
        wy >= GROUND_Y - TOWER_H && wy <= GROUND_Y) {
      this.clearSelection(); this.selectedTower = 'enemy';
      this.drag = { kind: 'tower-enemy' };
      this.syncInputsFromMap();
      document.getElementById('section-enemy-tower')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // Ground strip — not draggable, just selectable
    if (wx >= 0 && wx <= m.worldWidth && wy >= GROUND_Y) {
      this.clearSelection(); this.selectedGround = true;
      this.syncInputsFromMap();
      document.getElementById('section-ground')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // Click on empty space → deselect all
    this.clearSelection();
    this.syncInputsFromMap();
  }

  private scrollSelectionIntoView() {
    const panelId = this.selectedKind === 'platform' ? 'plat-panel' : 'block-panel';
    document.getElementById(panelId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  private clearSelection() {
    this.selected          = null;
    this.selectedTower     = null;
    this.selectedCoinBox   = false;
    this.selectedGround    = false;
    this.selectedBackground = false;
  }

  private onMouseUp(_e?: MouseEvent) {
    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    this.drag = null;
    this.canvas.style.cursor = 'crosshair';
  }

  // ── Control bindings ──────────────────────────────────────────────────────

  private bindControls() {
    const overlay = document.getElementById('platform-size-overlay')!;
    document.getElementById('btn-add-platform')!.addEventListener('click', () => {
      overlay.classList.add('open');
    });
    document.getElementById('platform-size-cancel')!.addEventListener('click', () => {
      overlay.classList.remove('open');
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
    document.querySelectorAll('button.size-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const w  = parseInt((btn as HTMLElement).dataset.w ?? '300', 10);
        const m  = this.map;
        const id = `p${Date.now()}`;
        m.platforms.push({ id, x: Math.round(m.worldWidth / 2 - w / 2), y: GROUND_Y - 260, width: w, height: 120 });
        this.clearSelection();
        this.selected     = m.platforms.length - 1;
        this.selectedKind = 'platform';
        overlay.classList.remove('open');
        this.syncInputsFromMap();
      });
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
      this.clearSelection();
      this.selected     = m.blocks.length - 1;
      this.selectedKind = 'block';
      this.syncInputsFromMap();
    });

    document.getElementById('btn-delete-block')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'block') return;
      this.map.blocks.splice(this.selected, 1);
      this.selected = null;
      this.syncInputsFromMap();
    });

    // Manage Background button
    document.getElementById('btn-manage-background')!.addEventListener('click', () => {
      this.clearSelection();
      this.selectedBackground = true;
      this.syncInputsFromMap();
      document.getElementById('section-background')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Background skin picker
    document.getElementById('input-bg-skin')!.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.map.backgroundSkin = reader.result as string;
        this.syncBackgroundSkinPreview();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-bg-skin')!.addEventListener('click', () => {
      delete this.map.backgroundSkin;
      (document.getElementById('input-bg-skin') as HTMLInputElement).value = '';
      this.syncBackgroundSkinPreview();
    });
    document.getElementById('input-bg-skin-y')!.addEventListener('input', () => {
      const val = parseInt((document.getElementById('input-bg-skin-y') as HTMLInputElement).value, 10);
      if (isNaN(val) || val === 0) delete this.map.backgroundSkinY;
      else                         this.map.backgroundSkinY = val;
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
        this.map           = parsed;
        this.clearSelection();
        this.syncInputsFromMap();
      } catch {
        alert('Invalid JSON — could not import map.');
      }
    });

    // JSON dialog
    const jsonOverlay = document.getElementById('json-overlay')!;
    const openJson  = () => jsonOverlay.classList.add('open');
    const closeJson = () => jsonOverlay.classList.remove('open');
    document.getElementById('btn-json-menu')!.addEventListener('click', openJson);
    document.getElementById('btn-json-close')!.addEventListener('click', closeJson);
    jsonOverlay.addEventListener('click', e => { if (e.target === jsonOverlay) closeJson(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeJson(); });

    // Map name input
    document.getElementById('input-name')!.addEventListener('input', e => {
      this.map.name = (e.target as HTMLInputElement).value;
    });

    // Number inputs for selected platform
    ['plat-x', 'plat-y', 'plat-w', 'plat-h', 'plat-z'].forEach(id => {
      document.getElementById(`input-${id}`)!.addEventListener('change', () => this.readPlatformInputs());
    });
    // Z-index: also update on every keystroke so the canvas reflects order changes in real time
    document.getElementById('input-plat-z')!.addEventListener('input', () => this.readPlatformInputs());

    // Platform skin picker
    document.getElementById('input-plat-skin')!.addEventListener('change', e => {
      if (this.selected === null || this.selectedKind !== 'platform') return;
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.map.platforms[this.selected!].skin = reader.result as string;
        this.syncPlatformSkinPreview();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-plat-skin')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'platform') return;
      delete this.map.platforms[this.selected].skin;
      this.syncPlatformSkinPreview();
    });

    // Block skin picker
    document.getElementById('input-block-skin')!.addEventListener('change', e => {
      if (this.selected === null || this.selectedKind !== 'block') return;
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.map.blocks[this.selected!].skin = reader.result as string;
        this.syncBlockSkinPreview();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-block-skin')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'block') return;
      delete this.map.blocks[this.selected].skin;
      this.syncBlockSkinPreview();
    });

    // Ground skin picker
    document.getElementById('input-ground-skin')!.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.map.groundSkin = reader.result as string;
        this.syncGroundSkinPreview();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-ground-skin')!.addEventListener('click', () => {
      delete this.map.groundSkin;
      this.syncGroundSkinPreview();
    });
    (['w', 'h'] as const).forEach(dim => {
      document.getElementById(`input-ground-tile-${dim}`)!.addEventListener('input', () => {
        const val = parseInt((document.getElementById(`input-ground-tile-${dim}`) as HTMLInputElement).value, 10);
        const key = dim === 'w' ? 'groundSkinTileW' : 'groundSkinTileH';
        if (isNaN(val) || val <= 0) delete this.map[key];
        else                        this.map[key] = val;
      });
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

    // Tower skin pickers
    (['player', 'enemy'] as const).forEach(side => {
      document.getElementById(`input-${side}-skin`)!.addEventListener('change', e => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const url = reader.result as string;
          if (side === 'player') this.map.playerTowerSkin = url;
          else                   this.map.enemyTowerSkin  = url;
          this.syncSkinPreviews();
        };
        reader.readAsDataURL(file);
      });

      document.getElementById(`btn-clear-${side}-skin`)!.addEventListener('click', () => {
        if (side === 'player') delete this.map.playerTowerSkin;
        else                   delete this.map.enemyTowerSkin;
        (document.getElementById(`input-${side}-skin`) as HTMLInputElement).value = '';
        this.syncSkinPreviews();
      });

      (['w', 'h'] as const).forEach(dim => {
        document.getElementById(`input-${side}-skin-${dim}`)!.addEventListener('change', () => {
          const val = parseInt((document.getElementById(`input-${side}-skin-${dim}`) as HTMLInputElement).value, 10);
          const def = dim === 'w' ? TOWER_W : TOWER_H;
          const key = `${side}TowerSkin${dim.toUpperCase()}` as 'playerTowerSkinW' | 'playerTowerSkinH' | 'enemyTowerSkinW' | 'enemyTowerSkinH';
          if (isNaN(val) || val === def) delete this.map[key];
          else                           this.map[key] = val;
        });
      });
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', e => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'f' || e.key === 'F') { this.fitView(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected !== null) {
        if (this.selectedKind === 'platform') this.map.platforms.splice(this.selected, 1);
        else                                  this.map.blocks.splice(this.selected, 1);
        this.selected = null;
        this.syncInputsFromMap();
      }
    });

    // Fit View button
    document.getElementById('btn-fit-view')!.addEventListener('click', () => this.fitView());
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
      if (found) { this.map = structuredClone(loadMapWithOverride(found)); this.clearSelection(); this.syncInputsFromMap(); }
    });
  }

  private readPlatformInputs() {
    if (this.selected === null) return;
    const p  = this.map.platforms[this.selected];
    p.x      = parseInt((document.getElementById('input-plat-x') as HTMLInputElement).value, 10);
    p.y      = parseInt((document.getElementById('input-plat-y') as HTMLInputElement).value, 10);
    p.width  = parseInt((document.getElementById('input-plat-w') as HTMLInputElement).value, 10);
    p.height = parseInt((document.getElementById('input-plat-h') as HTMLInputElement).value, 10);
    const z  = parseInt((document.getElementById('input-plat-z') as HTMLInputElement).value, 10);
    p.zIndex = isNaN(z) || z === 0 ? undefined : z;
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
    (document.getElementById('input-name') as HTMLInputElement).value = m.name;

    const playerSel  = this.selectedTower === 'player';
    const enemySel   = this.selectedTower === 'enemy';
    const coinSel    = this.selectedCoinBox;
    const groundSel  = this.selectedGround;
    const bgSel      = this.selectedBackground;
    const platSel    = this.selected !== null && this.selectedKind === 'platform' && this.selected < m.platforms.length;
    const blockSel   = this.selected !== null && this.selectedKind === 'block'    && this.selected < m.blocks.length;

    // Show only the relevant section
    document.getElementById('section-player-tower')!.style.display = playerSel ? 'flex' : 'none';
    document.getElementById('section-enemy-tower')! .style.display = enemySel  ? 'flex' : 'none';
    document.getElementById('section-coinbox')!     .style.display = coinSel   ? 'flex' : 'none';
    document.getElementById('section-ground')!      .style.display = groundSel ? 'flex' : 'none';
    document.getElementById('section-background')!  .style.display = bgSel     ? 'flex' : 'none';
    document.getElementById('section-platforms')!   .style.display = platSel   ? 'flex' : 'none';
    document.getElementById('section-blocks')!      .style.display = blockSel  ? 'flex' : 'none';

    if (playerSel) {
      (document.getElementById('input-player-x')      as HTMLInputElement).value = String(m.playerTowerX);
      (document.getElementById('input-player-skin-w') as HTMLInputElement).value = String(m.playerTowerSkinW ?? TOWER_W);
      (document.getElementById('input-player-skin-h') as HTMLInputElement).value = String(m.playerTowerSkinH ?? TOWER_H);
    }
    if (enemySel) {
      (document.getElementById('input-enemy-x')      as HTMLInputElement).value = String(m.enemyTowerX);
      (document.getElementById('input-enemy-skin-w') as HTMLInputElement).value = String(m.enemyTowerSkinW  ?? TOWER_W);
      (document.getElementById('input-enemy-skin-h') as HTMLInputElement).value = String(m.enemyTowerSkinH  ?? TOWER_H);
    }
    if (coinSel) {
      const cb = m.coinBox;
      (document.getElementById('input-cb-x')      as HTMLInputElement).value = String(cb.x);
      (document.getElementById('input-cb-y')      as HTMLInputElement).value = String(cb.y);
      (document.getElementById('input-cb-w')      as HTMLInputElement).value = String(cb.width);
      (document.getElementById('input-cb-h')      as HTMLInputElement).value = String(cb.height);
      (document.getElementById('input-cb-spread') as HTMLInputElement).value = String(cb.spreadDeg);
    }
    if (platSel) {
      const p = m.platforms[this.selected!];
      if (!p.id) p.id = `p${Date.now()}`;
      (document.getElementById('input-plat-id') as HTMLInputElement).value = p.id;
      (document.getElementById('input-plat-x')  as HTMLInputElement).value = String(p.x);
      (document.getElementById('input-plat-y')  as HTMLInputElement).value = String(p.y);
      (document.getElementById('input-plat-w')  as HTMLInputElement).value = String(p.width);
      (document.getElementById('input-plat-h')  as HTMLInputElement).value = String(p.height);
      (document.getElementById('input-plat-z')  as HTMLInputElement).value = String(p.zIndex ?? 0);
      document.getElementById('plat-label')!.textContent = `Platform ${this.selected! + 1}`;
      this.syncPlatformSkinPreview();
    }
    if (blockSel) {
      const b = m.blocks[this.selected!];
      (document.getElementById('input-block-x') as HTMLInputElement).value = String(b.x);
      (document.getElementById('input-block-y') as HTMLInputElement).value = String(b.y);
      (document.getElementById('input-block-w') as HTMLInputElement).value = String(b.width);
      (document.getElementById('input-block-h') as HTMLInputElement).value = String(b.height);
      document.getElementById('block-label')!.textContent = `Block ${this.selected! + 1}`;
      this.syncBlockSkinPreview();
    }
    if (groundSel) {
      (document.getElementById('display-ground-w') as HTMLInputElement).value = String(m.worldWidth);
      (document.getElementById('display-ground-h') as HTMLInputElement).value = String(WORLD_H - GROUND_Y);
      (document.getElementById('input-ground-tile-w') as HTMLInputElement).value = m.groundSkinTileW !== undefined ? String(m.groundSkinTileW) : '';
      (document.getElementById('input-ground-tile-h') as HTMLInputElement).value = m.groundSkinTileH !== undefined ? String(m.groundSkinTileH) : '';
      this.syncGroundSkinPreview();
    }
    if (bgSel) {
      this.syncBackgroundSkinPreview();
    }

    document.getElementById('plat-count')!.textContent  = `${m.platforms.length} platform(s)`;
    document.getElementById('block-count')!.textContent = `${m.blocks.length} block(s)`;

    // Selection status indicator
    const dot   = document.getElementById('selection-dot')   as HTMLElement;
    const label = document.getElementById('selection-label') as HTMLElement;
    if (playerSel) {
      dot.style.background = '#00b4d8'; label.style.color = '#00b4d8';
      label.style.fontStyle = 'normal'; label.textContent = 'Player Tower';
    } else if (enemySel) {
      dot.style.background = '#e63946'; label.style.color = '#e63946';
      label.style.fontStyle = 'normal'; label.textContent = 'Enemy Tower';
    } else if (coinSel) {
      dot.style.background = '#c8790a'; label.style.color = '#c8790a';
      label.style.fontStyle = 'normal'; label.textContent = 'Coin Box';
    } else if (platSel) {
      dot.style.background = '#f5c542'; label.style.color = '#f5c542';
      label.style.fontStyle = 'normal'; label.textContent = `Platform ${this.selected! + 1}`;
    } else if (blockSel) {
      dot.style.background = '#a5b4fc'; label.style.color = '#a5b4fc';
      label.style.fontStyle = 'normal'; label.textContent = `Block ${this.selected! + 1}`;
    } else if (groundSel) {
      dot.style.background = '#4a7c59'; label.style.color = '#4ade80';
      label.style.fontStyle = 'normal'; label.textContent = 'Ground';
    } else if (bgSel) {
      dot.style.background = '#7b98aa'; label.style.color = '#a8bcc9';
      label.style.fontStyle = 'normal'; label.textContent = 'Background';
    } else {
      dot.style.background = '#334'; label.style.color = 'var(--muted-fg, #64748b)';
      label.style.fontStyle = 'italic';
      label.textContent = 'Nothing selected — click an object on the map';
    }

    this.syncSkinPreviews();
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => new MapBuilder());
