import { DEFAULT_MAP, WORLDS, saveMapToStorage, loadMapWithOverride, type MapDefinition } from './maps';
import { DECOR_FRONT_Z, type DecorData } from './Decor';
import { GameConfig } from './gameConfig';
import { TRIBES, type Tribe } from './Tribes';
import {
  loadTemplates as loadTribeTowerTemplates,
  getTowerTemplate,
  setTowerTemplate,
  exportTemplatesJson,
  importTemplatesJson,
} from './TribeTowerTemplates';

loadTribeTowerTemplates();

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
  | { kind: 'platform-top';    idx: number; origY: number; origH: number }
  | { kind: 'platform-bottom'; idx: number }
  | { kind: 'platform-corner'; idx: number; hx: 'l' | 'r'; hy: 't' | 'b'; origX: number; origY: number; origW: number; origH: number }
  | { kind: 'block-move';      idx: number; ox: number; oy: number }
  | { kind: 'block-left';      idx: number; origX: number; origW: number }
  | { kind: 'block-right';     idx: number; origW: number }
  | { kind: 'block-top';       idx: number; origY: number; origH: number }
  | { kind: 'block-bottom';    idx: number }
  | { kind: 'block-corner';    idx: number; hx: 'l' | 'r'; hy: 't' | 'b'; origX: number; origY: number; origW: number; origH: number }
  | { kind: 'decor-move';      idx: number; ox: number; oy: number }
  | { kind: 'decor-left';      idx: number; origX: number; origW: number }
  | { kind: 'decor-right';     idx: number; origW: number }
  | { kind: 'decor-top';       idx: number; origY: number; origH: number }
  | { kind: 'decor-bottom';    idx: number; origY: number; origH: number }
  | { kind: 'decor-corner';    idx: number; hx: 'l' | 'r'; hy: 't' | 'b'; origX: number; origY: number; origW: number; origH: number }
  | { kind: 'coinbox';         ox: number; oy: number }
  | { kind: 'tower-player';   ox: number; oy: number }
  | { kind: 'tower-enemy';    ox: number; oy: number };

// ── MapBuilder class ─────────────────────────────────────────────────────────

class MapBuilder {
  private map: MapDefinition;
  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private selected:     number | null        = null;
  private selectedKind: 'platform' | 'block' | 'decor' = 'platform';
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
  private selectedMapSettings = false;
  private selectedGameConfig  = false;
  private selectedCoinSkins   = false;

  // ── Copy / Paste clipboard ────────────────────────────────────────────────
  private clipboard: {
    kind: 'platform'; data: MapDefinition['platforms'][number];
  } | {
    kind: 'block'; data: MapDefinition['blocks'][number];
  } | {
    kind: 'decor'; data: DecorData;
  } | null = null;

  // ── Custom platform draw mode (drag on canvas to size a new platform) ────
  private customDrawMode: 'off' | 'ready' | 'drawing' = 'off';
  private customDrawWx0 = 0; private customDrawWy0 = 0;  // start corner (world)
  private customDrawWx1 = 0; private customDrawWy1 = 0;  // current corner (world)

  // ── Undo / Redo history ───────────────────────────────────────────────────
  private undoStack: MapDefinition[] = [];
  private redoStack: MapDefinition[] = [];
  private static readonly MAX_HISTORY = 100;

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

  /** Effective world height — per-map override or the global canvas height. */
  private get worldH(): number { return this.map.worldHeight ?? WORLD_H; }
  /** Height of the green ground strip. Defaults to the gap between GROUND_Y and the map bottom. */
  private get groundStripH(): number { return this.map.groundHeight ?? (this.worldH - GROUND_Y); }
  /** World-space Y of the top surface of the ground strip (bottom is always worldH). */
  private get groundTopY(): number { return this.worldH - this.groundStripH; }

  // Position transforms (include pan offset)
  private wx(worldX: number): number { return worldX * this.scale + this.panX; }
  private wy(worldY: number): number { return worldY * this.scale + this.panY; }
  private cw(canvasX: number): number { return (canvasX - this.panX) / this.scale; }
  private ch(canvasY: number): number { return (canvasY - this.panY) / this.scale; }
  // Size transforms (scale only, no pan)
  private sw(worldW: number): number { return worldW * this.scale; }
  private sh(worldH: number): number { return worldH * this.scale; }

  /**
   * Draws the animation overlay for a block or platform: dashed indigo ghost
   * at the end position, a connector line + arrow from start centre to end
   * centre, and "S (x, y)" / "E (endX, endY)" labels above each rectangle.
   * Selected items get a brighter / thicker ghost and a slightly larger font.
   */
  private drawAnimGhost(
    ctx: CanvasRenderingContext2D,
    startX: number, startY: number,
    endX:   number, endY:   number,
    width:  number, height: number,
    selected: boolean,
  ): void {
    const sx = this.wx(startX), sy = this.wy(startY);
    const ex = this.wx(endX),   ey = this.wy(endY);
    const w  = this.sw(width),  h  = this.sh(height);
    const ghostAlpha = selected ? 0.9 : 0.45;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth   = selected ? 2 : 1.25;
    ctx.strokeStyle = `rgba(99, 102, 241, ${ghostAlpha})`;     // indigo
    ctx.strokeRect(ex, ey, w, h);
    // Connector line from start centre to end centre
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(99, 102, 241, ${ghostAlpha * 0.8})`;
    ctx.beginPath();
    const cx0 = sx + w / 2, cy0 = sy + h / 2;
    const cx1 = ex + w / 2, cy1 = ey + h / 2;
    ctx.moveTo(cx0, cy0);
    ctx.lineTo(cx1, cy1);
    ctx.stroke();
    // Arrowhead
    const ang = Math.atan2(cy1 - cy0, cx1 - cx0);
    const aLen = 8;
    ctx.beginPath();
    ctx.moveTo(cx1, cy1);
    ctx.lineTo(cx1 - aLen * Math.cos(ang - Math.PI / 6), cy1 - aLen * Math.sin(ang - Math.PI / 6));
    ctx.moveTo(cx1, cy1);
    ctx.lineTo(cx1 - aLen * Math.cos(ang + Math.PI / 6), cy1 - aLen * Math.sin(ang + Math.PI / 6));
    ctx.stroke();
    // Endpoint coordinate labels with dark halo for legibility.
    ctx.font         = `${selected ? 13 : 11}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth    = 3;
    ctx.strokeStyle  = 'rgba(7, 7, 15, 0.85)';
    ctx.fillStyle    = `rgba(165, 180, 252, ${ghostAlpha})`;  // indigo-300
    const sLabel = `S (${Math.round(startX)}, ${Math.round(startY)})`;
    const eLabel = `E (${Math.round(endX)}, ${Math.round(endY)})`;
    ctx.strokeText(sLabel, sx + w / 2, sy - 4);
    ctx.fillText  (sLabel, sx + w / 2, sy - 4);
    ctx.strokeText(eLabel, ex + w / 2, ey - 4);
    ctx.fillText  (eLabel, ex + w / 2, ey - 4);
    ctx.restore();
  }

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
    this.panY  = (h - this.worldH * this.scale) / 2;
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
    const wh = this.sh(this.worldH);
    const wx0 = this.wx(0);
    const wy0 = this.wy(0);

    // Sky (world bounds only)
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(wx0, wy0, ww, wh);

    // Far background layer (behind the near one)
    if (m.backgroundSkin2) {
      const img = this.getSkinImage(m.backgroundSkin2);
      if (img.complete && img.naturalWidth > 0) {
        const yOff = this.sh(m.backgroundSkin2Y ?? 0);
        ctx.drawImage(img, wx0, wy0 + yOff, ww, this.sh(GROUND_Y));
      }
    }

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

    // World border
    ctx.strokeStyle = '#2a2a3a';
    ctx.lineWidth   = 1;
    ctx.strokeRect(wx0, wy0, ww, wh);

    this.drawGrid();

    const drawTower = (cx: number, baseY: number, color: string, stroke: string, sel: boolean, flipX: boolean, skinUrl?: string, tW: number = TOWER_W, tH: number = TOWER_H) => {
      const tx = this.wx(cx - tW / 2);
      const ty = this.wy(baseY - tH);
      const tw = this.sw(tW);
      const th = this.sh(tH);
      if (skinUrl) {
        const img = this.getSkinImage(skinUrl);
        if (img.complete && img.naturalWidth > 0) {
          if (flipX) {
            // Skins are authored facing east; mirror for west-facing placeholders.
            ctx.save();
            ctx.translate(tx + tw, ty);
            ctx.scale(-1, 1);
            ctx.drawImage(img, 0, 0, tw, th);
            ctx.restore();
          } else {
            ctx.drawImage(img, tx, ty, tw, th);
          }
          if (sel) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.strokeRect(tx, ty, tw, th); }
          return;
        }
      }
      ctx.fillStyle   = color;
      ctx.strokeStyle = sel ? '#ffffff' : stroke;
      ctx.lineWidth   = sel ? 2 : 1;
      ctx.fillRect(tx, ty, tw, th);
      ctx.strokeRect(tx, ty, tw, th);
    };
    const pBaseY = m.playerTowerY ?? this.groundTopY;
    const eBaseY = m.enemyTowerY  ?? this.groundTopY;
    const pTpl   = getTowerTemplate(m.playerTowerTribe ?? 'kattgard');
    const eTpl   = getTowerTemplate(m.enemyTowerTribe  ?? 'lapinor');

    // Unified z-sorted draw list: blocks, platforms, and towers share the same
    // z-index space so towers can be layered relative to environment elements.
    type LayerKind = 'block' | 'platform' | 'decor' | 'ground' | 'tower-player' | 'tower-enemy';
    const layerItems: { kind: LayerKind; idx: number; z: number }[] = [];
    for (let i = 0; i < m.blocks.length;    i++) layerItems.push({ kind: 'block',        idx: i, z: m.blocks[i].zIndex    ?? 0 });
    for (let i = 0; i < m.platforms.length; i++) layerItems.push({ kind: 'platform',     idx: i, z: m.platforms[i].zIndex ?? 0 });
    const decor = m.decor ?? [];
    for (let i = 0; i < decor.length;       i++) layerItems.push({ kind: 'decor',        idx: i, z: decor[i].zIndex      ?? 0 });
    // Ground sorts in the same scene z-space. Pushed after decor so that, at an
    // equal z, it renders on top of scene props (matches Game.ts build order).
    layerItems.push({ kind: 'ground',       idx: 0, z: m.groundZ ?? 0 });
    layerItems.push({ kind: 'tower-player', idx: 0, z: m.playerTowerZ ?? 0 });
    layerItems.push({ kind: 'tower-enemy',  idx: 1, z: m.enemyTowerZ  ?? 0 });
    layerItems.sort((a, b) => a.z - b.z);

    for (const item of layerItems) {
      if (item.kind === 'ground') {
        this.drawGroundStrip(ctx, wx0, ww);
        continue;
      }
      if (item.kind === 'tower-player') {
        drawTower(m.playerTowerX, pBaseY, '#00b4d8', '#007fa3', this.selectedTower === 'player', false, pTpl.skin, pTpl.w, pTpl.h);
        continue;
      }
      if (item.kind === 'tower-enemy') {
        drawTower(m.enemyTowerX, eBaseY, '#e63946', '#a02830', this.selectedTower === 'enemy', true, eTpl.skin, eTpl.w, eTpl.h);
        continue;
      }

      if (item.kind === 'block') {
        const i   = item.idx;
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
          ctx.fillStyle = '#ffffff';
          const hw = 6, hh = 10;
          ctx.fillRect(bx - hw / 2,      by + bh / 2 - hh / 2, hw, hh);
          ctx.fillRect(bx + bw - hw / 2, by + bh / 2 - hh / 2, hw, hh);
          const hw2 = 10, hh2 = 6;
          ctx.fillRect(bx + bw / 2 - hw2 / 2, by - hh2 / 2,      hw2, hh2);
          ctx.fillRect(bx + bw / 2 - hw2 / 2, by + bh - hh2 / 2, hw2, hh2);
          this.drawCornerHandles(ctx, bx, by, bw, bh);
        }

        if (b.anim) {
          this.drawAnimGhost(ctx, b.x, b.y, b.anim.endX, b.anim.endY, b.width, b.height, sel);
        }
        continue;
      }

      if (item.kind === 'decor') {
        const i   = item.idx;
        const d   = decor[i];
        const sel = this.selectedKind === 'decor' && i === this.selected;
        const dx  = this.wx(d.x);
        const dy  = this.wy(d.y);
        const dw  = this.sw(d.width);
        const dh  = this.sh(d.height);

        // Apply the decor's opacity to its visual only — selection chrome below
        // stays fully opaque so faint decor is still easy to grab.
        ctx.globalAlpha = d.opacity ?? 1;
        if (d.skin) {
          const img = this.getSkinImage(d.skin);
          if (img.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, dx, dy, dw, dh);
          } else {
            ctx.fillStyle = 'rgba(120,180,120,0.25)';
            ctx.fillRect(dx, dy, dw, dh);
          }
        } else {
          // No skin yet — faint dashed placeholder.
          ctx.fillStyle = 'rgba(120,180,120,0.18)';
          ctx.fillRect(dx, dy, dw, dh);
          ctx.strokeStyle = sel ? '#34d399' : '#4b8b5e';
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 1;
          ctx.strokeRect(dx, dy, dw, dh);
          ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;

        if (sel) {
          ctx.strokeStyle = '#34d399';
          ctx.lineWidth   = 2;
          ctx.strokeRect(dx, dy, dw, dh);
          ctx.fillStyle = '#ffffff';
          const hw = 6, hh = 10;
          ctx.fillRect(dx - hw / 2,      dy + dh / 2 - hh / 2, hw, hh);
          ctx.fillRect(dx + dw - hw / 2, dy + dh / 2 - hh / 2, hw, hh);
          const hw2 = 10, hh2 = 6;
          ctx.fillRect(dx + dw / 2 - hw2 / 2, dy - hh2 / 2,      hw2, hh2);
          ctx.fillRect(dx + dw / 2 - hw2 / 2, dy + dh - hh2 / 2, hw2, hh2);
          this.drawCornerHandles(ctx, dx, dy, dw, dh);
        }
        continue;
      }

      // platform
      const i   = item.idx;
      const p   = m.platforms[i];
      const sel = this.selectedKind === 'platform' && i === this.selected;
      const px  = this.wx(p.x);
      const py  = this.wy(p.y);
      const pw  = this.sw(p.width);
      const ph  = this.sh(p.height);

      if (p.skin) {
        const img = this.getSkinImage(p.skin);
        if (img.complete && img.naturalWidth > 0) {
          // Clip every skin draw to the rounded-top silhouette.
          ctx.save();
          this.roundedTopRectPath(ctx, px, py, pw, ph);
          ctx.clip();
          if (p.skinTileW !== undefined || p.skinTileH !== undefined) {
            // Tiled skin — repeat the image across the platform, matching the
            // ground-skin tiling approach (DOMMatrix-transformed canvas pattern).
            const pat = ctx.createPattern(img, 'repeat');
            if (pat) {
              const tileW = p.skinTileW ?? img.naturalWidth;
              const tileH = p.skinTileH ?? img.naturalHeight;
              pat.setTransform(new DOMMatrix([
                tileW / img.naturalWidth,  0,
                0, tileH / img.naturalHeight,
                0, 0,
              ]));
              ctx.translate(px, py);
              ctx.scale(this.scale, this.scale);
              ctx.fillStyle = pat;
              ctx.fillRect(0, 0, p.width, p.height);
            } else {
              ctx.drawImage(img, px, py, pw, ph);
            }
          } else {
            ctx.drawImage(img, px, py, pw, ph);
          }
          ctx.restore();
        } else {
          ctx.fillStyle = '#444';
          this.roundedTopRectPath(ctx, px, py, pw, ph);
          ctx.fill();
        }
      } else {
        ctx.fillStyle   = sel ? '#f5c542' : '#8B5E3C';
        ctx.strokeStyle = sel ? '#e0a500' : '#5c3322';
        ctx.lineWidth   = sel ? 2 : 1;
        this.roundedTopRectPath(ctx, px, py, pw, ph);
        ctx.fill();
        ctx.stroke();
      }

      if (sel) {
        ctx.strokeStyle = '#e0a500';
        ctx.lineWidth   = 2;
        ctx.strokeRect(px, py, pw, ph);
        ctx.fillStyle = '#ffffff';
        const hw = 6, hh = 10;
        ctx.fillRect(px - hw / 2,      py + ph / 2 - hh / 2, hw, hh);
        ctx.fillRect(px + pw - hw / 2, py + ph / 2 - hh / 2, hw, hh);
        const hw2 = 10, hh2 = 6;
        ctx.fillRect(px + pw / 2 - hw2 / 2, py - hh2 / 2,      hw2, hh2);
        ctx.fillRect(px + pw / 2 - hw2 / 2, py + ph - hh2 / 2, hw2, hh2);
        this.drawCornerHandles(ctx, px, py, pw, ph);
      }

      if (p.anim) {
        this.drawAnimGhost(ctx, p.x, p.y, p.anim.endX, p.anim.endY, p.width, p.height, sel);
      }
    }

    // Ground selection highlight — drawn after the z-sorted pass so it stays
    // visible regardless of where the ground sorts.
    if (this.selectedGround) {
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth   = 2;
      ctx.strokeRect(wx0, this.wy(this.groundTopY), ww, this.sh(this.groundStripH));
    }

    // Coin box — custom PNG skin if set, otherwise the procedural box
    const cb = m.coinBox;
    const cbX = this.wx(cb.x - cb.width / 2), cbY = this.wy(cb.y);
    const cbW = this.sw(cb.width), cbH = this.sh(cb.height);
    const cbSkinImg = cb.skin ? this.getSkinImage(cb.skin) : null;
    if (cbSkinImg && cbSkinImg.naturalWidth > 0) {
      ctx.drawImage(cbSkinImg, cbX, cbY, cbW, cbH);
    } else {
      ctx.fillStyle   = '#c8790a';
      ctx.strokeStyle = '#7a4a06';
      ctx.lineWidth   = 2;
      ctx.fillRect(cbX, cbY, cbW, cbH);
      ctx.strokeRect(cbX, cbY, cbW, cbH);
      ctx.fillStyle = '#fff';
      ctx.font      = `bold ${Math.max(10, Math.round(14 * this.scale))}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('★', this.wx(cb.x), this.wy(cb.y + cb.height / 2) + 4);
    }

    // ── Custom draw silhouette + hint ─────────────────────────────────────
    if (this.customDrawMode !== 'off') {
      if (this.customDrawMode === 'drawing') {
        const rx0 = Math.min(this.customDrawWx0, this.customDrawWx1);
        const ry0 = Math.min(this.customDrawWy0, this.customDrawWy1);
        const rx1 = Math.max(this.customDrawWx0, this.customDrawWx1);
        const ry1 = Math.max(this.customDrawWy0, this.customDrawWy1);
        const rx  = this.wx(rx0), ry = this.wy(ry0);
        const rw  = this.sw(rx1 - rx0), rh = this.sh(ry1 - ry0);
        ctx.save();
        // Filled ghost
        ctx.fillStyle = 'rgba(141, 94, 60, 0.30)';
        ctx.fillRect(rx, ry, rw, rh);
        // Dashed border
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = '#f5c542';
        ctx.lineWidth   = 2;
        ctx.strokeRect(rx, ry, rw, rh);
        // Dimension label (only if big enough to read)
        const dimW = Math.round(rx1 - rx0), dimH = Math.round(ry1 - ry0);
        if (rw > 50 && rh > 14) {
          const label = `${dimW} × ${dimH}`;
          ctx.setLineDash([]);
          ctx.font          = 'bold 13px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign     = 'center';
          ctx.textBaseline  = 'middle';
          ctx.lineWidth     = 3;
          ctx.strokeStyle   = 'rgba(7,7,15,0.85)';
          ctx.strokeText(label, rx + rw / 2, ry + rh / 2);
          ctx.fillStyle = '#fff';
          ctx.fillText(label, rx + rw / 2, ry + rh / 2);
        }
        ctx.restore();
      }
      // Hint banner pinned to the bottom of the canvas
      const hint = this.customDrawMode === 'ready'
        ? 'Click and drag on the canvas to draw a platform  •  Esc or RMB to cancel'
        : 'Release to place  •  Esc or RMB to cancel';
      ctx.save();
      ctx.fillStyle = 'rgba(10,10,24,0.82)';
      ctx.fillRect(0, H - 32, W, 32);
      ctx.fillStyle     = '#f5c542';
      ctx.font          = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign     = 'center';
      ctx.textBaseline  = 'middle';
      ctx.fillText(hint, W / 2, H - 16);
      ctx.restore();
    }

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
    const vBottom = Math.min(this.worldH,  this.ch(H));
    if (vRight <= vLeft || vBottom <= vTop) return;

    const startX = Math.floor(vLeft / iv) * iv;
    const startY = Math.floor(vTop  / iv) * iv;

    // Grid lines clipped to world rect
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.wx(0), this.wy(0), this.sw(m.worldWidth), this.sh(this.worldH));
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth   = 1;

    for (let x = startX; x <= vRight; x += iv) {
      const cx = this.wx(x);
      ctx.beginPath();
      ctx.moveTo(cx, Math.max(0,  this.wy(0)));
      ctx.lineTo(cx, Math.min(H,  this.wy(this.worldH)));
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

  /**
   * Core helper: shows/hides a preview `<img>` + clear button for a skin URL.
   * When `url` is absent, also resets the file input so re-selecting the same
   * file still fires the `change` event next time.
   */
  private syncSkinPreview(
    previewId: string, clearId: string, url: string | undefined, fileInputId: string
  ): void {
    const preview = document.getElementById(previewId) as HTMLImageElement;
    const clear   = document.getElementById(clearId)   as HTMLButtonElement;
    if (url) {
      preview.src           = url;
      preview.style.display = 'inline';
      clear.style.display   = 'inline';
    } else {
      preview.style.display = 'none';
      clear.style.display   = 'none';
      (document.getElementById(fileInputId) as HTMLInputElement).value = '';
    }
  }

  private syncPlatformSkinPreview() {
    const skin = this.selected !== null && this.selectedKind === 'platform'
      ? this.map.platforms[this.selected]?.skin : undefined;
    this.syncSkinPreview('preview-plat-skin', 'btn-clear-plat-skin', skin, 'input-plat-skin');
  }

  private syncBlockSkinPreview() {
    const skin = this.selected !== null && this.selectedKind === 'block'
      ? this.map.blocks[this.selected]?.skin : undefined;
    this.syncSkinPreview('preview-block-skin', 'btn-clear-block-skin', skin, 'input-block-skin');
  }

  private syncDecorSkinPreview() {
    const skin = this.selected !== null && this.selectedKind === 'decor'
      ? (this.map.decor ?? [])[this.selected]?.skin : undefined;
    this.syncSkinPreview('preview-decor-skin', 'btn-clear-decor-skin', skin, 'input-decor-skin');
  }

  private syncBackgroundSkinPreview() {
    this.syncSkinPreview('preview-bg-skin', 'btn-clear-bg-skin', this.map.backgroundSkin, 'input-bg-skin');
    (document.getElementById('input-bg-skin-y') as HTMLInputElement).value =
      String(this.map.backgroundSkinY ?? 0);
  }

  private syncBackgroundSkin2Preview() {
    this.syncSkinPreview('preview-bg-skin2', 'btn-clear-bg-skin2', this.map.backgroundSkin2, 'input-bg-skin2');
    (document.getElementById('input-bg-skin2-y') as HTMLInputElement).value =
      String(this.map.backgroundSkin2Y ?? 0);
  }

  private syncGroundSkinPreview() {
    this.syncSkinPreview('preview-ground-skin', 'btn-clear-ground-skin', this.map.groundSkin, 'input-ground-skin');
  }

  private syncCoinSkinsPreview() {
    this.syncSkinPreview('preview-coinbox-skin',     'btn-clear-coinbox-skin',     this.map.coinBox.skin,      'input-coinbox-skin');
    this.syncSkinPreview('preview-coin-gold-skin',   'btn-clear-coin-gold-skin',   this.map.coinSkins?.gold,   'input-coin-gold-skin');
    this.syncSkinPreview('preview-coin-silver-skin', 'btn-clear-coin-silver-skin', this.map.coinSkins?.silver, 'input-coin-silver-skin');
    this.syncSkinPreview('preview-coin-blue-skin',   'btn-clear-coin-blue-skin',   this.map.coinSkins?.blue,   'input-coin-blue-skin');
  }

  /** Wire one coin-skin file input + its clear button. `target` selects the
   *  storage slot: the coin box, or a coin kind in map.coinSkins. */
  private wireCoinSkinInput(inputId: string, clearId: string, target: 'box' | 'gold' | 'silver' | 'blue') {
    const setSkin = (url: string | undefined) => {
      if (target === 'box') {
        if (url) this.map.coinBox.skin = url;
        else     delete this.map.coinBox.skin;
      } else if (url) {
        (this.map.coinSkins ??= {})[target] = url;
      } else if (this.map.coinSkins) {
        delete this.map.coinSkins[target];
        if (Object.keys(this.map.coinSkins).length === 0) delete this.map.coinSkins;
      }
    };
    document.getElementById(inputId)!.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.pushUndo();
      const reader = new FileReader();
      reader.onload = () => { setSkin(reader.result as string); this.syncCoinSkinsPreview(); };
      reader.readAsDataURL(file);
    });
    document.getElementById(clearId)!.addEventListener('click', () => {
      this.pushUndo();
      setSkin(undefined);
      (document.getElementById(inputId) as HTMLInputElement).value = '';
      this.syncCoinSkinsPreview();
    });
  }

  /** Draw the green ground strip + tiled skin. Called from the z-sorted draw pass. */
  private drawGroundStrip(ctx: CanvasRenderingContext2D, wx0: number, ww: number) {
    const m            = this.map;
    const groundStripH = this.groundStripH;
    const groundTopY   = this.groundTopY;
    const groundH      = this.sh(groundStripH);
    ctx.fillStyle = '#4a7c59';
    ctx.fillRect(wx0, this.wy(groundTopY), ww, groundH);
    ctx.fillStyle = '#3d6b4a';
    ctx.fillRect(wx0, this.wy(groundTopY), ww, Math.min(this.sh(6), groundH));

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
          ctx.rect(wx0, this.wy(groundTopY), ww, groundH);
          ctx.clip();
          ctx.translate(this.panX, this.wy(groundTopY));
          ctx.scale(this.scale, this.scale);
          ctx.fillStyle = pat;
          ctx.fillRect(0, 0, m.worldWidth, groundStripH);
          ctx.restore();
        }
      }
    }
  }

  // ── Canvas interaction ────────────────────────────────────────────────────

  private bindCanvas() {
    this.canvas.addEventListener('mousemove',   e => this.onMouseMove(e));
    this.canvas.addEventListener('mousedown',   e => this.onMouseDown(e));
    this.canvas.addEventListener('mouseup',     e => this.onMouseUp(e));
    this.canvas.addEventListener('mouseleave', e => {
      if (this.customDrawMode !== 'off') { this.customDrawMode = 'off'; return; }
      this.onMouseUp(e);
    });
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

    // Custom draw — keep cursor and update live corner while dragging
    if (this.customDrawMode !== 'off') {
      if (this.customDrawMode === 'drawing') {
        this.customDrawWx1 = this.cw(cx);
        this.customDrawWy1 = this.ch(cy);
      }
      this.canvas.style.cursor = 'crosshair';
      return;
    }

    const wx = this.cw(cx);
    const wy = this.ch(cy);
    const m  = this.map;

    if (!this.drag) {
      this.canvas.style.cursor = this.hoverCursor(cx, cy, wx, wy, m);
      return;
    }

    if (this.drag.kind === 'platform-move') {
      const p = m.platforms[this.drag.idx];
      p.x = Math.round(wx - this.drag.ox);
      p.y = Math.min(this.groundTopY - p.height, Math.round(wy - this.drag.oy));
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
    } else if (this.drag.kind === 'platform-top') {
      const p      = m.platforms[this.drag.idx];
      const bottom = this.drag.origY + this.drag.origH;
      p.y          = Math.round(Math.min(wy, bottom - 20));
      p.height     = bottom - p.y;
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'platform-bottom') {
      const p  = m.platforms[this.drag.idx];
      p.height = Math.max(20, Math.round(Math.min(wy, this.groundTopY) - p.y));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'platform-corner') {
      const p = m.platforms[this.drag.idx];
      const { hx, hy, origX, origY, origW, origH } = this.drag;
      if (hx === 'l') { const right = origX + origW; p.x = Math.round(Math.min(wx, right - 40)); p.width = right - p.x; }
      else            { p.width = Math.max(40, Math.round(wx - p.x)); }
      if (hy === 't') { const bottom = origY + origH; p.y = Math.round(Math.min(wy, bottom - 20)); p.height = bottom - p.y; }
      else            { p.height = Math.max(20, Math.round(Math.min(wy, this.groundTopY) - p.y)); }
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'block-move') {
      const b = m.blocks[this.drag.idx];
      b.x = Math.round(wx - this.drag.ox);
      b.y = Math.min(this.groundTopY - b.height, Math.round(wy - this.drag.oy));
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
    } else if (this.drag.kind === 'block-top') {
      const b      = m.blocks[this.drag.idx];
      const bottom = this.drag.origY + this.drag.origH;
      b.y          = Math.round(Math.min(wy, bottom - 20));
      b.height     = bottom - b.y;
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'block-bottom') {
      const b  = m.blocks[this.drag.idx];
      b.height = Math.max(20, Math.round(Math.min(wy, this.groundTopY) - b.y));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'block-corner') {
      const b = m.blocks[this.drag.idx];
      const { hx, hy, origX, origY, origW, origH } = this.drag;
      if (hx === 'l') { const right = origX + origW; b.x = Math.round(Math.min(wx, right - 40)); b.width = right - b.x; }
      else            { b.width = Math.max(40, Math.round(wx - b.x)); }
      if (hy === 't') { const bottom = origY + origH; b.y = Math.round(Math.min(wy, bottom - 20)); b.height = bottom - b.y; }
      else            { b.height = Math.max(20, Math.round(Math.min(wy, this.groundTopY) - b.y)); }
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'decor-move') {
      const d = (m.decor ?? [])[this.drag.idx];
      // Decor is purely visual — free placement (may float, sit in the sky, etc.).
      d.x = Math.round(wx - this.drag.ox);
      d.y = Math.round(wy - this.drag.oy);
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'decor-left') {
      const d  = (m.decor ?? [])[this.drag.idx];
      const dx = wx - this.drag.origX;
      d.x      = Math.round(this.drag.origX + dx);
      d.width  = Math.max(8, Math.round(this.drag.origW - dx));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'decor-right') {
      const d = (m.decor ?? [])[this.drag.idx];
      d.width = Math.max(8, Math.round(wx - d.x));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'decor-top') {
      const d      = (m.decor ?? [])[this.drag.idx];
      const bottom = this.drag.origY + this.drag.origH;
      d.y          = Math.round(Math.min(wy, bottom - 8));
      d.height     = bottom - d.y;
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'decor-bottom') {
      const d  = (m.decor ?? [])[this.drag.idx];
      d.height = Math.max(8, Math.round(wy - d.y));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'decor-corner') {
      const d = (m.decor ?? [])[this.drag.idx];
      const { hx, hy, origX, origY, origW, origH } = this.drag;
      // Decor is purely visual — free resize, no ground clamp.
      if (hx === 'l') { const right = origX + origW; d.x = Math.round(Math.min(wx, right - 8)); d.width = right - d.x; }
      else            { d.width = Math.max(8, Math.round(wx - d.x)); }
      if (hy === 't') { const bottom = origY + origH; d.y = Math.round(Math.min(wy, bottom - 8)); d.height = bottom - d.y; }
      else            { d.height = Math.max(8, Math.round(wy - d.y)); }
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'coinbox') {
      m.coinBox.x = Math.round(wx - this.drag.ox);
      m.coinBox.y = Math.min(this.groundTopY - m.coinBox.height, Math.round(wy - this.drag.oy));
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'tower-player') {
      m.playerTowerX = Math.max(TOWER_W / 2 + 5, Math.round(wx - this.drag.ox));
      const newY = Math.round(wy - this.drag.oy);
      m.playerTowerY = newY >= this.groundTopY ? undefined : Math.max(TOWER_H + 20, newY);
      this.syncInputsFromMap();
    } else if (this.drag.kind === 'tower-enemy') {
      m.enemyTowerX = Math.min(m.worldWidth - TOWER_W / 2 - 5, Math.round(wx - this.drag.ox));
      const newY = Math.round(wy - this.drag.oy);
      m.enemyTowerY = newY >= this.groundTopY ? undefined : Math.max(TOWER_H + 20, newY);
      this.syncInputsFromMap();
    }
    this.canvas.style.cursor = 'grabbing';
  }

  /** Trace a rect path (screen coords) with only the TOP two corners rounded.
   *  Mirrors the in-game platform rounding (PLATFORM_TOP_RADIUS in Platform.ts). */
  private roundedTopRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const r = Math.max(0, Math.min(this.sw(8), w / 2, h));
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  /** Draw the four white corner squares for a selected rect (screen coords). */
  private drawCornerHandles(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const s = 8;
    ctx.fillStyle = '#ffffff';
    for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]] as const) {
      ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
    }
  }

  private hoverCursor(cx: number, cy: number, wx: number, wy: number, m: typeof this.map): string {
    const HANDLE_ZONE = 5;

    // Resize handles on platforms, blocks, and decor (corners + edges) + body (grab)
    const rectCursor = (x: number, y: number, w: number, h: number): string | null => {
      const inX = wx >= x && wx <= x + w;
      const inY = wy >= y && wy <= y + h;
      const atL = Math.abs(cx - this.wx(x))     <= HANDLE_ZONE;
      const atR = Math.abs(cx - this.wx(x + w)) <= HANDLE_ZONE;
      const atT = Math.abs(cy - this.wy(y))     <= HANDLE_ZONE;
      const atB = Math.abs(cy - this.wy(y + h)) <= HANDLE_ZONE;
      if ((atL && atT) || (atR && atB)) return 'nwse-resize';
      if ((atR && atT) || (atL && atB)) return 'nesw-resize';
      if (inY && (atL || atR)) return 'ew-resize';
      if (inX && (atT || atB)) return 'ns-resize';
      if (inX && inY) return 'grab';
      return null;
    };
    for (const p of m.platforms)     { const c = rectCursor(p.x, p.y, p.width, p.height); if (c) return c; }
    for (const b of m.blocks)        { const c = rectCursor(b.x, b.y, b.width, b.height); if (c) return c; }
    for (const d of (m.decor ?? [])) { const c = rectCursor(d.x, d.y, d.width, d.height); if (c) return c; }

    // Coin box
    const cb = m.coinBox;
    if (wx >= cb.x - cb.width / 2 && wx <= cb.x + cb.width / 2 &&
        wy >= cb.y && wy <= cb.y + cb.height)
      return 'grab';

    // Towers
    const pBaseY = m.playerTowerY ?? this.groundTopY;
    const eBaseY = m.enemyTowerY  ?? this.groundTopY;
    if (wx >= m.playerTowerX - TOWER_W / 2 && wx <= m.playerTowerX + TOWER_W / 2 &&
        wy >= pBaseY - TOWER_H && wy <= pBaseY)
      return 'grab';
    if (wx >= m.enemyTowerX - TOWER_W / 2 && wx <= m.enemyTowerX + TOWER_W / 2 &&
        wy >= eBaseY - TOWER_H && wy <= eBaseY)
      return 'grab';

    return 'crosshair';
  }

  private onMouseDown(e: MouseEvent) {
    // Custom draw mode: RMB/MMB cancels instead of starting a pan
    if (this.customDrawMode !== 'off' && (e.button === 1 || e.button === 2)) {
      this.customDrawMode = 'off';
      e.preventDefault();
      return;
    }
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

    // Custom draw — left click anchors the start corner
    if (this.customDrawMode === 'ready') {
      this.customDrawMode = 'drawing';
      this.customDrawWx0  = wx;  this.customDrawWy0 = wy;
      this.customDrawWx1  = wx;  this.customDrawWy1 = wy;
      return;
    }

    const m  = this.map;

    // Hit-test in reverse draw order so the visually topmost element wins the click.
    // Draw order: blocks ascending z → platforms ascending z.
    // Hit-test order: platforms descending z → blocks descending z.
    const HANDLE_ZONE = 5;

    // Decor (hit-tested first so these visual props are always easy to grab),
    // highest z wins.
    const decorArr = m.decor ?? [];
    const decorHitOrder = decorArr
      .map((_, i) => i)
      .sort((a, b) => (decorArr[b].zIndex ?? 0) - (decorArr[a].zIndex ?? 0));
    for (const i of decorHitOrder) {
      const d = decorArr[i];
      const startDecor = (drag: DragKind) => {
        this.clearSelection(); this.selected = i; this.selectedKind = 'decor';
        this.pushUndo();
        this.drag = drag;
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
      };
      const atL = Math.abs(cx - this.wx(d.x))           <= HANDLE_ZONE;
      const atR = Math.abs(cx - this.wx(d.x + d.width)) <= HANDLE_ZONE;
      const atT = Math.abs(cy - this.wy(d.y))           <= HANDLE_ZONE;
      const atB = Math.abs(cy - this.wy(d.y + d.height))<= HANDLE_ZONE;
      if ((atL || atR) && (atT || atB)) {
        startDecor({ kind: 'decor-corner', idx: i, hx: atL ? 'l' : 'r', hy: atT ? 't' : 'b',
                     origX: d.x, origY: d.y, origW: d.width, origH: d.height }); return;
      }
      if (Math.abs(cx - this.wx(d.x)) <= HANDLE_ZONE && wy >= d.y && wy <= d.y + d.height) {
        startDecor({ kind: 'decor-left', idx: i, origX: d.x, origW: d.width }); return;
      }
      if (Math.abs(cx - this.wx(d.x + d.width)) <= HANDLE_ZONE && wy >= d.y && wy <= d.y + d.height) {
        startDecor({ kind: 'decor-right', idx: i, origW: d.width }); return;
      }
      if (Math.abs(cy - this.wy(d.y)) <= HANDLE_ZONE && wx >= d.x && wx <= d.x + d.width) {
        startDecor({ kind: 'decor-top', idx: i, origY: d.y, origH: d.height }); return;
      }
      if (Math.abs(cy - this.wy(d.y + d.height)) <= HANDLE_ZONE && wx >= d.x && wx <= d.x + d.width) {
        startDecor({ kind: 'decor-bottom', idx: i, origY: d.y, origH: d.height }); return;
      }
      if (wx >= d.x && wx <= d.x + d.width && wy >= d.y && wy <= d.y + d.height) {
        startDecor({ kind: 'decor-move', idx: i, ox: wx - d.x, oy: wy - d.y }); return;
      }
    }

    const platHitOrder = m.platforms
      .map((_, i) => i)
      .sort((a, b) => (m.platforms[b].zIndex ?? 0) - (m.platforms[a].zIndex ?? 0));

    for (const i of platHitOrder) {
      const p = m.platforms[i];
      const atL = Math.abs(cx - this.wx(p.x))           <= HANDLE_ZONE;
      const atR = Math.abs(cx - this.wx(p.x + p.width)) <= HANDLE_ZONE;
      const atT = Math.abs(cy - this.wy(p.y))           <= HANDLE_ZONE;
      const atB = Math.abs(cy - this.wy(p.y + p.height))<= HANDLE_ZONE;
      if ((atL || atR) && (atT || atB)) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'platform';
        this.pushUndo();
        this.drag = { kind: 'platform-corner', idx: i, hx: atL ? 'l' : 'r', hy: atT ? 't' : 'b',
                      origX: p.x, origY: p.y, origW: p.width, origH: p.height };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cx - this.wx(p.x)) <= HANDLE_ZONE &&
          wy >= p.y && wy <= p.y + p.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'platform';
        this.pushUndo();
        this.drag = { kind: 'platform-left', idx: i, origX: p.x, origW: p.width };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cx - this.wx(p.x + p.width)) <= HANDLE_ZONE &&
          wy >= p.y && wy <= p.y + p.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'platform';
        this.pushUndo();
        this.drag = { kind: 'platform-right', idx: i, origW: p.width };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cy - this.wy(p.y)) <= HANDLE_ZONE &&
          wx >= p.x && wx <= p.x + p.width) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'platform';
        this.pushUndo();
        this.drag = { kind: 'platform-top', idx: i, origY: p.y, origH: p.height };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cy - this.wy(p.y + p.height)) <= HANDLE_ZONE &&
          wx >= p.x && wx <= p.x + p.width) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'platform';
        this.pushUndo();
        this.drag = { kind: 'platform-bottom', idx: i };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (wx >= p.x && wx <= p.x + p.width && wy >= p.y && wy <= p.y + p.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'platform';
        this.pushUndo();
        this.drag = { kind: 'platform-move', idx: i, ox: wx - p.x, oy: wy - p.y };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
    }

    // Blocks (hit-tested after platforms since platforms render on top)
    const blockHitOrder = m.blocks
      .map((_, i) => i)
      .sort((a, b) => (m.blocks[b].zIndex ?? 0) - (m.blocks[a].zIndex ?? 0));

    for (const i of blockHitOrder) {
      const b = m.blocks[i];
      const atL = Math.abs(cx - this.wx(b.x))           <= HANDLE_ZONE;
      const atR = Math.abs(cx - this.wx(b.x + b.width)) <= HANDLE_ZONE;
      const atT = Math.abs(cy - this.wy(b.y))           <= HANDLE_ZONE;
      const atB = Math.abs(cy - this.wy(b.y + b.height))<= HANDLE_ZONE;
      if ((atL || atR) && (atT || atB)) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'block';
        this.pushUndo();
        this.drag = { kind: 'block-corner', idx: i, hx: atL ? 'l' : 'r', hy: atT ? 't' : 'b',
                      origX: b.x, origY: b.y, origW: b.width, origH: b.height };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cx - this.wx(b.x)) <= HANDLE_ZONE &&
          wy >= b.y && wy <= b.y + b.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'block';
        this.pushUndo();
        this.drag = { kind: 'block-left', idx: i, origX: b.x, origW: b.width };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cx - this.wx(b.x + b.width)) <= HANDLE_ZONE &&
          wy >= b.y && wy <= b.y + b.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'block';
        this.pushUndo();
        this.drag = { kind: 'block-right', idx: i, origW: b.width };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cy - this.wy(b.y)) <= HANDLE_ZONE &&
          wx >= b.x && wx <= b.x + b.width) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'block';
        this.pushUndo();
        this.drag = { kind: 'block-top', idx: i, origY: b.y, origH: b.height };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (Math.abs(cy - this.wy(b.y + b.height)) <= HANDLE_ZONE &&
          wx >= b.x && wx <= b.x + b.width) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'block';
        this.pushUndo();
        this.drag = { kind: 'block-bottom', idx: i };
        this.syncInputsFromMap(); this.scrollSelectionIntoView();
        return;
      }
      if (wx >= b.x && wx <= b.x + b.width && wy >= b.y && wy <= b.y + b.height) {
        this.clearSelection(); this.selected = i; this.selectedKind = 'block';
        this.pushUndo();
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
      this.pushUndo();
      this.drag = { kind: 'coinbox', ox: wx - cb.x, oy: wy - cb.y };
      this.syncInputsFromMap();
      document.getElementById('section-coinbox')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // Player tower
    {
      const pBaseY = m.playerTowerY ?? this.groundTopY;
      if (wx >= m.playerTowerX - TOWER_W / 2 && wx <= m.playerTowerX + TOWER_W / 2 &&
          wy >= pBaseY - TOWER_H && wy <= pBaseY) {
        this.clearSelection(); this.selectedTower = 'player';
        this.pushUndo();
        this.drag = { kind: 'tower-player', ox: wx - m.playerTowerX, oy: wy - pBaseY };
        this.syncInputsFromMap();
        document.getElementById('section-player-tower')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
    }

    // Enemy tower
    {
      const eBaseY = m.enemyTowerY ?? this.groundTopY;
      if (wx >= m.enemyTowerX - TOWER_W / 2 && wx <= m.enemyTowerX + TOWER_W / 2 &&
          wy >= eBaseY - TOWER_H && wy <= eBaseY) {
        this.clearSelection(); this.selectedTower = 'enemy';
        this.pushUndo();
        this.drag = { kind: 'tower-enemy', ox: wx - m.enemyTowerX, oy: wy - (m.enemyTowerY ?? this.groundTopY) };
        this.syncInputsFromMap();
        document.getElementById('section-enemy-tower')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
    }

    // Ground strip — not draggable, just selectable
    if (wx >= 0 && wx <= m.worldWidth && wy >= this.groundTopY) {
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
    this.selectedBackground  = false;
    this.selectedMapSettings = false;
    this.selectedGameConfig  = false;
    this.selectedCoinSkins   = false;
  }

  /** Snapshot current map state before a destructive operation. Clears redo stack. */
  private pushUndo(): void {
    this.undoStack.push(structuredClone(this.map));
    if (this.undoStack.length > MapBuilder.MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(structuredClone(this.map));
    this.map = prev;
    this.drag = null;
    this.clearSelection();
    this.syncInputsFromMap();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.map));
    this.map = next;
    this.drag = null;
    this.clearSelection();
    this.syncInputsFromMap();
  }

  private onMouseUp(_e?: MouseEvent) {
    if (this.customDrawMode === 'drawing') {
      this.finalizeCustomDraw();
      return;
    }
    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    this.drag = null;
    this.canvas.style.cursor = 'crosshair';
  }

  /** Called when the user releases the mouse after a custom-draw drag. */
  private finalizeCustomDraw(): void {
    this.customDrawMode = 'off';
    const x0 = Math.min(this.customDrawWx0, this.customDrawWx1);
    const y0 = Math.min(this.customDrawWy0, this.customDrawWy1);
    const x1 = Math.max(this.customDrawWx0, this.customDrawWx1);
    const y1 = Math.max(this.customDrawWy0, this.customDrawWy1);
    const w  = Math.round(x1 - x0);
    const h  = Math.round(y1 - y0);
    if (w < 40 || h < 4) return;  // too small — ignore the gesture
    const m    = this.map;
    const id   = `p${Date.now()}`;
    const maxZ = MapBuilder.maxZOf(m.platforms);
    this.pushUndo();
    m.platforms.push({ id, x: Math.round(x0), y: Math.round(y0), width: w, height: h, zIndex: maxZ + 1 });
    this.clearSelection();
    this.selected     = m.platforms.length - 1;
    this.selectedKind = 'platform';
    this.syncInputsFromMap();
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
    document.getElementById('btn-platform-custom')!.addEventListener('click', () => {
      overlay.classList.remove('open');
      this.customDrawMode = 'ready';
      this.canvas.style.cursor = 'crosshair';
    });
    document.querySelectorAll('button.size-option[data-w]').forEach(btn => {
      btn.addEventListener('click', () => {
        const el     = btn as HTMLElement;
        const w      = parseInt(el.dataset.w ?? '300', 10);
        const h      = parseInt(el.dataset.h ?? '120', 10);
        const m      = this.map;
        const id     = `p${Date.now()}`;
        // Auto z-index: one above the current highest so the new platform renders on top
        const maxZ   = MapBuilder.maxZOf(m.platforms);
        const zIndex = maxZ + 1;
        this.pushUndo();
        m.platforms.push({ id, x: Math.round(m.worldWidth / 2 - w / 2), y: this.groundTopY - 260, width: w, height: h, zIndex });
        this.clearSelection();
        this.selected     = m.platforms.length - 1;
        this.selectedKind = 'platform';
        overlay.classList.remove('open');
        this.syncInputsFromMap();
      });
    });

    document.getElementById('btn-delete-platform')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'platform') return;
      this.pushUndo();
      this.map.platforms.splice(this.selected, 1);
      this.selected = null;
      this.syncInputsFromMap();
    });

    document.getElementById('btn-add-block')!.addEventListener('click', () => {
      const m    = this.map;
      const cx   = m.worldWidth / 2;
      const maxZ = MapBuilder.maxZOf(m.blocks);
      const zIndex = maxZ + 1;
      this.pushUndo();
      m.blocks.push({ x: cx - 100, y: this.groundTopY - 80, width: 200, height: 40, zIndex });
      this.clearSelection();
      this.selected     = m.blocks.length - 1;
      this.selectedKind = 'block';
      this.syncInputsFromMap();
    });

    document.getElementById('btn-delete-block')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'block') return;
      this.pushUndo();
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

    // Map Settings button
    document.getElementById('btn-map-settings')!.addEventListener('click', () => {
      this.clearSelection();
      this.selectedMapSettings = true;
      this.syncInputsFromMap();
      document.getElementById('section-map-settings')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Game Config button
    document.getElementById('btn-game-config')!.addEventListener('click', () => {
      this.clearSelection();
      this.selectedGameConfig = true;
      this.syncInputsFromMap();
      document.getElementById('section-game-config')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Coin Skins button
    document.getElementById('btn-coin-skins')!.addEventListener('click', () => {
      this.clearSelection();
      this.selectedCoinSkins = true;
      this.syncInputsFromMap();
      document.getElementById('section-coin-skins')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Coin Skins file inputs — coin box + per-kind coin PNGs
    this.wireCoinSkinInput('input-coinbox-skin', 'btn-clear-coinbox-skin', 'box');
    this.wireCoinSkinInput('input-coin-gold-skin',   'btn-clear-coin-gold-skin',   'gold');
    this.wireCoinSkinInput('input-coin-silver-skin', 'btn-clear-coin-silver-skin', 'silver');
    this.wireCoinSkinInput('input-coin-blue-skin',   'btn-clear-coin-blue-skin',   'blue');

    // World width input
    document.getElementById('input-world-width')!.addEventListener('change', () => {
      const val = parseInt((document.getElementById('input-world-width') as HTMLInputElement).value, 10);
      if (isNaN(val) || val < 800) return;
      this.pushUndo();
      this.map.worldWidth = val;
      // Keep towers within the new bounds
      const margin = TOWER_W / 2 + 5;
      this.map.playerTowerX = Math.max(margin, Math.min(this.map.playerTowerX, val - margin));
      this.map.enemyTowerX  = Math.max(margin, Math.min(this.map.enemyTowerX,  val - margin));
      this.syncInputsFromMap();
    });

    // World height input — adjusts total canvas height (sky + ground strip together)
    document.getElementById('input-world-height')!.addEventListener('change', () => {
      const val  = parseInt((document.getElementById('input-world-height') as HTMLInputElement).value, 10);
      const minH = GROUND_Y + 20;   // must keep at least 20 px of ground strip
      if (isNaN(val) || val < minH) return;
      this.pushUndo();
      this.map.worldHeight = val === WORLD_H ? undefined : val;
      this.syncInputsFromMap();
    });

    // Ground height input — controls only the visual green strip; does not affect Map Height
    document.getElementById('input-ground-height')!.addEventListener('change', () => {
      const val = parseInt((document.getElementById('input-ground-height') as HTMLInputElement).value, 10);
      if (isNaN(val) || val < 20) return;
      this.pushUndo();
      const defaultGH = (this.map.worldHeight ?? WORLD_H) - GROUND_Y;
      this.map.groundHeight = val === defaultGH ? undefined : val;
      this.syncInputsFromMap();
    });

    // Ground Z-index — sorts the ground within the shared scene z-space. Live
    // update on every keystroke so the canvas reflects order changes in real time.
    document.getElementById('input-ground-z')!.addEventListener('input', () => {
      const z = parseInt((document.getElementById('input-ground-z') as HTMLInputElement).value, 10);
      this.map.groundZ = isNaN(z) || z === 0 ? undefined : z;
    });

    // Map duration inputs (minutes + seconds → durationSec)
    const readDuration = () => {
      const minStr = (document.getElementById('input-map-duration-min') as HTMLInputElement).value;
      const secStr = (document.getElementById('input-map-duration-sec') as HTMLInputElement).value;
      if (minStr === '' && secStr === '') { delete this.map.durationSec; return; }
      const mins = parseInt(minStr, 10);
      const secs = parseInt(secStr, 10);
      const total = (isNaN(mins) ? 0 : mins) * 60 + (isNaN(secs) ? 0 : secs);
      if (total <= 0) delete this.map.durationSec;
      else            this.map.durationSec = total;
    };
    document.getElementById('input-map-duration-min')!.addEventListener('input', readDuration);
    document.getElementById('input-map-duration-sec')!.addEventListener('input', readDuration);

    // Background skin picker
    document.getElementById('input-bg-skin')!.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.pushUndo();
      const reader = new FileReader();
      reader.onload = () => {
        this.map.backgroundSkin = reader.result as string;
        this.syncBackgroundSkinPreview();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-bg-skin')!.addEventListener('click', () => {
      this.pushUndo();
      delete this.map.backgroundSkin;
      (document.getElementById('input-bg-skin') as HTMLInputElement).value = '';
      this.syncBackgroundSkinPreview();
    });
    document.getElementById('input-bg-skin-y')!.addEventListener('input', () => {
      const val = parseInt((document.getElementById('input-bg-skin-y') as HTMLInputElement).value, 10);
      if (isNaN(val) || val === 0) delete this.map.backgroundSkinY;
      else                         this.map.backgroundSkinY = val;
    });

    // Far background skin picker
    document.getElementById('input-bg-skin2')!.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.pushUndo();
      const reader = new FileReader();
      reader.onload = () => {
        this.map.backgroundSkin2 = reader.result as string;
        this.syncBackgroundSkin2Preview();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-bg-skin2')!.addEventListener('click', () => {
      this.pushUndo();
      delete this.map.backgroundSkin2;
      (document.getElementById('input-bg-skin2') as HTMLInputElement).value = '';
      this.syncBackgroundSkin2Preview();
    });
    document.getElementById('input-bg-skin2-y')!.addEventListener('input', () => {
      const val = parseInt((document.getElementById('input-bg-skin2-y') as HTMLInputElement).value, 10);
      if (isNaN(val) || val === 0) delete this.map.backgroundSkin2Y;
      else                         this.map.backgroundSkin2Y = val;
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
        this.pushUndo();
        this.map           = parsed;
        this.clearSelection();
        this.syncInputsFromMap();
      } catch {
        alert('Invalid JSON — could not import map.');
      }
    });

    document.getElementById('btn-save-to-file')!.addEventListener('click', () => this.exportToFile());
    document.getElementById('btn-load-from-file')!.addEventListener('click', () => {
      (document.getElementById('input-load-map-file') as HTMLInputElement).click();
    });
    document.getElementById('input-load-map-file')!.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      (e.target as HTMLInputElement).value = '';
      this.importFromFile(file);
    });

    document.getElementById('btn-save-all-to-file')!.addEventListener('click', () => this.exportAllToFile());
    document.getElementById('btn-load-all-from-file')!.addEventListener('click', () => {
      (document.getElementById('input-load-all-map-file') as HTMLInputElement).click();
    });
    document.getElementById('input-load-all-map-file')!.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      (e.target as HTMLInputElement).value = '';
      this.importAllFromFile(file);
    });

    // JSON dialog
    const jsonOverlay = document.getElementById('json-overlay')!;
    const openJson  = () => jsonOverlay.classList.add('open');
    const closeJson = () => jsonOverlay.classList.remove('open');
    document.getElementById('btn-json-menu')!.addEventListener('click', openJson);
    document.getElementById('btn-json-close')!.addEventListener('click', closeJson);
    jsonOverlay.addEventListener('click', e => { if (e.target === jsonOverlay) closeJson(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeJson(); this.customDrawMode = 'off'; }
    });

    // Map name input
    document.getElementById('input-name')!.addEventListener('input', e => {
      this.map.name = (e.target as HTMLInputElement).value;
    });

    // Number inputs for selected platform
    ['plat-x', 'plat-y', 'plat-w', 'plat-h', 'plat-z',
     'plat-anim-end-x', 'plat-anim-end-y', 'plat-anim-speed'].forEach(id => {
      document.getElementById(`input-${id}`)!.addEventListener('change', () => { this.pushUndo(); this.readPlatformInputs(); });
    });
    // Z-index: also update on every keystroke so the canvas reflects order changes in real time
    // (no pushUndo here — the 'change' event above captures one undo step on commit)
    document.getElementById('input-plat-z')!.addEventListener('input', () => this.readPlatformInputs());
    // Animate checkbox toggles anim on/off + hides/shows the field set
    document.getElementById('input-plat-anim')!.addEventListener('change', () => { this.pushUndo(); this.readPlatformInputs(); });

    // Platform skin picker
    document.getElementById('input-plat-skin')!.addEventListener('change', e => {
      if (this.selected === null || this.selectedKind !== 'platform') return;
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.pushUndo();
      const reader = new FileReader();
      reader.onload = () => {
        this.map.platforms[this.selected!].skin = reader.result as string;
        this.syncPlatformSkinPreview();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-plat-skin')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'platform') return;
      this.pushUndo();
      delete this.map.platforms[this.selected].skin;
      this.syncPlatformSkinPreview();
    });
    (['w', 'h'] as const).forEach(dim => {
      document.getElementById(`input-plat-tile-${dim}`)!.addEventListener('input', () => {
        if (this.selected === null || this.selectedKind !== 'platform') return;
        const p   = this.map.platforms[this.selected];
        const val = parseInt((document.getElementById(`input-plat-tile-${dim}`) as HTMLInputElement).value, 10);
        const key = dim === 'w' ? 'skinTileW' : 'skinTileH';
        if (isNaN(val) || val <= 0) delete p[key];
        else                        p[key] = val;
      });
    });

    // Block skin picker
    document.getElementById('input-block-skin')!.addEventListener('change', e => {
      if (this.selected === null || this.selectedKind !== 'block') return;
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.pushUndo();
      const reader = new FileReader();
      reader.onload = () => {
        this.map.blocks[this.selected!].skin = reader.result as string;
        this.syncBlockSkinPreview();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-block-skin')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'block') return;
      this.pushUndo();
      delete this.map.blocks[this.selected].skin;
      this.syncBlockSkinPreview();
    });

    // Ground skin picker
    document.getElementById('input-ground-skin')!.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.pushUndo();
      const reader = new FileReader();
      reader.onload = () => {
        this.map.groundSkin = reader.result as string;
        this.syncGroundSkinPreview();
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-ground-skin')!.addEventListener('click', () => {
      this.pushUndo();
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
    ['block-x', 'block-y', 'block-w', 'block-h', 'block-z',
     'block-anim-end-x', 'block-anim-end-y', 'block-anim-speed'].forEach(id => {
      document.getElementById(`input-${id}`)!.addEventListener('change', () => { this.pushUndo(); this.readBlockInputs(); });
    });
    // Z-index: live update so render order reflects keystrokes in real time
    // (no pushUndo here — the 'change' event above captures one undo step on commit)
    document.getElementById('input-block-z')!.addEventListener('input', () => this.readBlockInputs());
    // Animate checkbox — fire on toggle and on initial wire so the field set
    // shows/hides the moment the user ticks the box.
    document.getElementById('input-block-anim')!.addEventListener('change', () => { this.pushUndo(); this.readBlockInputs(); });

    // Number inputs for selected decor
    ['decor-x', 'decor-y', 'decor-w', 'decor-h', 'decor-z'].forEach(id => {
      document.getElementById(`input-${id}`)!.addEventListener('change', () => { this.pushUndo(); this.readDecorInputs(); });
    });
    document.getElementById('input-decor-z')!.addEventListener('input', () => this.readDecorInputs());
    // Opacity slider — live update on drag; snapshot undo once when released.
    document.getElementById('input-decor-opacity')!.addEventListener('input', () => this.readDecorInputs());
    document.getElementById('input-decor-opacity')!.addEventListener('change', () => this.pushUndo());
    // "Infront of Characters" — pins zIndex to DECOR_FRONT_Z (so characters always
    // render behind it); unchecking returns it to the shared scene z-space (z = 0).
    document.getElementById('input-decor-front')!.addEventListener('change', () => {
      if (this.selected === null || this.selectedKind !== 'decor') return;
      const d = (this.map.decor ?? [])[this.selected];
      if (!d) return;
      this.pushUndo();
      const on = (document.getElementById('input-decor-front') as HTMLInputElement).checked;
      d.zIndex = on ? DECOR_FRONT_Z : undefined;
      this.syncInputsFromMap();
    });
    // Decor skin picker (replaces the skin of the selected decor)
    document.getElementById('input-decor-skin')!.addEventListener('change', e => {
      if (this.selected === null || this.selectedKind !== 'decor') return;
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.pushUndo();
      const reader = new FileReader();
      reader.onload = () => {
        const d = (this.map.decor ?? [])[this.selected!];
        if (d) { d.skin = reader.result as string; this.syncDecorSkinPreview(); }
      };
      reader.readAsDataURL(file);
    });
    document.getElementById('btn-clear-decor-skin')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'decor') return;
      this.pushUndo();
      delete (this.map.decor ?? [])[this.selected]?.skin;
      this.syncDecorSkinPreview();
    });

    // ── Add Decor: skin upload dialog ────────────────────────────────────────
    const decorOverlay = document.getElementById('decor-skin-overlay')!;
    const decorUpload   = document.getElementById('input-decor-upload') as HTMLInputElement;
    const decorPreview  = document.getElementById('decor-skin-preview') as HTMLImageElement;
    const decorHint     = document.getElementById('decor-skin-hint')!;
    const decorPlaceBtn = document.getElementById('decor-skin-place') as HTMLButtonElement;
    let pendingDecorSkin: string | null = null;

    const closeDecorDialog = () => {
      decorOverlay.classList.remove('open');
      pendingDecorSkin = null;
      decorUpload.value = '';
      decorPreview.style.display = 'none';
      decorPreview.removeAttribute('src');
      decorHint.textContent = 'No image chosen yet';
      decorPlaceBtn.disabled = true;
    };

    document.getElementById('btn-add-decor')!.addEventListener('click', () => {
      closeDecorDialog();
      decorOverlay.classList.add('open');
    });
    document.getElementById('decor-skin-cancel')!.addEventListener('click', closeDecorDialog);
    decorOverlay.addEventListener('click', e => { if (e.target === decorOverlay) closeDecorDialog(); });

    decorUpload.addEventListener('change', e => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        pendingDecorSkin = reader.result as string;
        decorPreview.src = pendingDecorSkin;
        decorPreview.style.display = 'block';
        decorHint.textContent = file.name;
        decorPlaceBtn.disabled = false;
      };
      reader.readAsDataURL(file);
    });

    decorPlaceBtn.addEventListener('click', () => {
      if (!pendingDecorSkin) return;
      // Size from the chosen image's aspect ratio (default height 100px, capped width).
      const natW = decorPreview.naturalWidth  || 100;
      const natH = decorPreview.naturalHeight || 100;
      let h = 100, w = Math.round(h * natW / natH);
      if (w > 300) { w = 300; h = Math.round(w * natH / natW); }
      // Place at the current view centre so it lands where the author is looking.
      const cxw = Math.round(this.cw(this.canvas.width  / 2));
      const cyw = Math.round(this.ch(this.canvas.height / 2));

      const m = this.map;
      m.decor ??= [];
      this.pushUndo();
      // Auto z-index: one above the highest scene-layer z among platforms, blocks,
      // and (non-foreground) decor so the new decor renders on top of everything
      // already placed instead of hiding behind it. Capped below DECOR_FRONT_Z so
      // it still sits behind characters — use the "Infront of Characters" toggle
      // to bring it ahead of units.
      const sceneZ = (it: { zIndex?: number }) =>
        (it.zIndex ?? 0) < DECOR_FRONT_Z ? (it.zIndex ?? 0) : 0;
      const maxSceneZ = Math.max(
        0,
        ...m.platforms.map(sceneZ),
        ...m.blocks.map(sceneZ),
        ...m.decor.map(sceneZ),
      );
      const zIndex = Math.min(maxSceneZ + 1, DECOR_FRONT_Z - 1);
      m.decor.push({ id: `d${Date.now()}`, x: cxw - w / 2, y: cyw - h / 2, width: w, height: h, zIndex, skin: pendingDecorSkin });
      this.clearSelection();
      this.selected     = m.decor.length - 1;
      this.selectedKind = 'decor';
      closeDecorDialog();
      this.syncInputsFromMap();
      this.scrollSelectionIntoView();
    });

    document.getElementById('btn-delete-decor')!.addEventListener('click', () => {
      if (this.selected === null || this.selectedKind !== 'decor') return;
      this.pushUndo();
      (this.map.decor ?? []).splice(this.selected, 1);
      this.selected = null;
      this.syncInputsFromMap();
    });

    // Coin box inputs
    ['cb-x', 'cb-y', 'cb-w', 'cb-h', 'cb-spread'].forEach(id => {
      document.getElementById(`input-${id}`)!.addEventListener('change', () => { this.pushUndo(); this.readCoinBoxInputs(); });
    });

    // Tower inputs
    document.getElementById('input-player-x')!.addEventListener('change', () => {
      this.pushUndo();
      this.map.playerTowerX = parseInt((document.getElementById('input-player-x') as HTMLInputElement).value, 10);
    });
    document.getElementById('input-player-y')!.addEventListener('change', () => {
      this.pushUndo();
      const val = parseInt((document.getElementById('input-player-y') as HTMLInputElement).value, 10);
      this.map.playerTowerY = isNaN(val) || val >= this.groundTopY ? undefined : Math.max(TOWER_H + 20, val);
    });
    document.getElementById('input-enemy-x')!.addEventListener('change', () => {
      this.pushUndo();
      this.map.enemyTowerX = parseInt((document.getElementById('input-enemy-x') as HTMLInputElement).value, 10);
    });
    document.getElementById('input-enemy-y')!.addEventListener('change', () => {
      this.pushUndo();
      const val = parseInt((document.getElementById('input-enemy-y') as HTMLInputElement).value, 10);
      this.map.enemyTowerY = isNaN(val) || val >= this.groundTopY ? undefined : Math.max(TOWER_H + 20, val);
    });

    // Tower default-tribe dropdowns — populate options and wire change handlers.
    // Skin/W/H are no longer per-map; they're stored per-tribe in
    // TribeTowerTemplates and edited via the "Tribe Tower Skins" modal.
    (['player', 'enemy'] as const).forEach(side => {
      const sel = document.getElementById(`input-${side}-tribe`) as HTMLSelectElement;
      for (const tribe of Object.values(TRIBES)) {
        const opt = document.createElement('option');
        opt.value       = tribe.id;
        opt.textContent = tribe.displayName;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        this.pushUndo();
        const t = sel.value as Tribe;
        if (side === 'player') this.map.playerTowerTribe = t;
        else                   this.map.enemyTowerTribe  = t;
      });
    });

    // Tower Z-index inputs
    document.getElementById('input-player-z')!.addEventListener('change', () => {
      this.pushUndo();
      const val = parseInt((document.getElementById('input-player-z') as HTMLInputElement).value, 10);
      this.map.playerTowerZ = isNaN(val) || val === 0 ? undefined : val;
    });
    document.getElementById('input-enemy-z')!.addEventListener('change', () => {
      this.pushUndo();
      const val = parseInt((document.getElementById('input-enemy-z') as HTMLInputElement).value, 10);
      this.map.enemyTowerZ = isNaN(val) || val === 0 ? undefined : val;
    });

    this.bindTribeSkinsModal();

    this.bindKeyboardShortcuts();
  }

  /**
   * Registers the global keyboard shortcuts.
   * Kept separate from `bindControls` so that method stays focused on DOM wiring.
   * All shortcuts bail early when a form element has focus so native browser
   * behaviour (text editing, etc.) is preserved.
   */
  private bindKeyboardShortcuts(): void {
    window.addEventListener('keydown', e => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); this.undo();  return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); this.redo();  return; }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (this.selected === null) return;
        if (this.selectedKind === 'platform') {
          this.clipboard = { kind: 'platform', data: structuredClone(this.map.platforms[this.selected]) };
        } else if (this.selectedKind === 'block') {
          this.clipboard = { kind: 'block', data: structuredClone(this.map.blocks[this.selected]) };
        } else {
          this.clipboard = { kind: 'decor', data: structuredClone((this.map.decor ?? [])[this.selected]) };
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        if (!this.clipboard) return;
        e.preventDefault();
        const PASTE_OFFSET = 20;
        this.pushUndo();
        if (this.clipboard.kind === 'platform') {
          const copy    = structuredClone(this.clipboard.data);
          copy.id       = `p${Date.now()}`;
          copy.x       += PASTE_OFFSET;
          copy.y       += PASTE_OFFSET;
          copy.zIndex   = MapBuilder.maxZOf(this.map.platforms) + 1;
          this.map.platforms.push(copy);
          this.clearSelection();
          this.selected     = this.map.platforms.length - 1;
          this.selectedKind = 'platform';
        } else if (this.clipboard.kind === 'block') {
          const copy    = structuredClone(this.clipboard.data);
          copy.x       += PASTE_OFFSET;
          copy.y       += PASTE_OFFSET;
          copy.zIndex   = MapBuilder.maxZOf(this.map.blocks) + 1;
          this.map.blocks.push(copy);
          this.clearSelection();
          this.selected     = this.map.blocks.length - 1;
          this.selectedKind = 'block';
        } else {
          // Preserve the copied decor's z (and thus its front/back state) — the
          // 999 sentinel must survive a copy, so don't bump it like platforms/blocks.
          const copy    = structuredClone(this.clipboard.data);
          copy.id       = `d${Date.now()}`;
          copy.x       += PASTE_OFFSET;
          copy.y       += PASTE_OFFSET;
          this.map.decor ??= [];
          this.map.decor.push(copy);
          this.clearSelection();
          this.selected     = this.map.decor.length - 1;
          this.selectedKind = 'decor';
        }
        this.syncInputsFromMap();
        return;
      }

      if (e.key === 'f' || e.key === 'F') { this.fitView(); return; }

      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected !== null) {
        this.pushUndo();
        if      (this.selectedKind === 'platform') this.map.platforms.splice(this.selected, 1);
        else if (this.selectedKind === 'block')    this.map.blocks.splice(this.selected, 1);
        else                                       (this.map.decor ?? []).splice(this.selected, 1);
        this.selected = null;
        this.syncInputsFromMap();
      }
    });
  }

  private populatePresets() {
    const sel = document.getElementById('preset-select') as HTMLSelectElement;

    // Group maps by world using <optgroup> so the selector shows the hierarchy.
    for (const world of WORLDS) {
      const group   = document.createElement('optgroup');
      group.label   = `World ${world.id} — ${world.name}`;
      for (let mi = 0; mi < world.maps.length; mi++) {
        const m    = world.maps[mi];
        const opt  = document.createElement('option');
        opt.value  = m.id;
        opt.text   = `W${world.id}M${mi + 1} — ${m.name}`;
        group.appendChild(opt);
      }
      sel.appendChild(group);
    }

    sel.value = this.map.id;   // reflect the currently loaded map
    sel.addEventListener('change', () => {
      // Flatten all maps to find by id
      for (const world of WORLDS) {
        const found = world.maps.find(m => m.id === sel.value);
        if (found) {
          // Load the saved version of the preset if one exists, so edits aren't lost on switch.
          this.pushUndo();
          this.map = structuredClone(loadMapWithOverride(found));
          this.clearSelection();
          this.syncInputsFromMap();
          return;
        }
      }
    });
  }

  /** Maximum `zIndex` among `items`, or 0 when the list is empty. */
  private static maxZOf(items: { zIndex?: number }[]): number {
    return items.reduce((acc, it) => Math.max(acc, it.zIndex ?? 0), 0);
  }

  /**
   * Reads animation inputs (checkbox + end-x/y/speed) for the given UI prefix
   * ('plat' | 'block') and writes the result into `item.anim`.
   * Also toggles the anim field-set visibility to match the checkbox state.
   */
  private readAnimFields(
    prefix: string,
    item: { x: number; y: number; anim?: { endX: number; endY: number; speed: number } },
  ): void {
    const animOn = (document.getElementById(`input-${prefix}-anim`) as HTMLInputElement).checked;
    if (animOn) {
      const endX  = parseInt((document.getElementById(`input-${prefix}-anim-end-x`) as HTMLInputElement).value, 10);
      const endY  = parseInt((document.getElementById(`input-${prefix}-anim-end-y`) as HTMLInputElement).value, 10);
      const speed = Math.max(1, parseInt((document.getElementById(`input-${prefix}-anim-speed`) as HTMLInputElement).value, 10) || 0);
      item.anim = { endX: isNaN(endX) ? item.x : endX, endY: isNaN(endY) ? item.y : endY, speed };
    } else {
      delete item.anim;
    }
    (document.getElementById(`${prefix}-anim-fields`) as HTMLElement).style.display = animOn ? 'flex' : 'none';
  }

  /**
   * Syncs the animation UI fields (checkbox + end-x/y/speed + fieldset visibility)
   * from `item.anim`. `defaultEndX` is used when no anim is set yet (sensible
   * starting value: one item-width to the right of the current position).
   */
  private syncAnimToUI(
    prefix: string,
    item: { x: number; y: number; anim?: { endX: number; endY: number; speed: number } },
    defaultEndX: number,
  ): void {
    const hasAnim = !!item.anim;
    (document.getElementById(`input-${prefix}-anim`)         as HTMLInputElement).checked     = hasAnim;
    (document.getElementById(`input-${prefix}-anim-end-x`)   as HTMLInputElement).value       = String(item.anim?.endX  ?? defaultEndX);
    (document.getElementById(`input-${prefix}-anim-end-y`)   as HTMLInputElement).value       = String(item.anim?.endY  ?? item.y);
    (document.getElementById(`input-${prefix}-anim-speed`)   as HTMLInputElement).value       = String(item.anim?.speed ?? 60);
    (document.getElementById(`${prefix}-anim-fields`)        as HTMLElement).style.display    = hasAnim ? 'flex' : 'none';
  }

  private readPlatformInputs() {
    if (this.selected === null || this.selectedKind !== 'platform') return;
    const p  = this.map.platforms[this.selected];
    p.x      = parseInt((document.getElementById('input-plat-x') as HTMLInputElement).value, 10);
    p.y      = parseInt((document.getElementById('input-plat-y') as HTMLInputElement).value, 10);
    p.width  = parseInt((document.getElementById('input-plat-w') as HTMLInputElement).value, 10);
    p.height = parseInt((document.getElementById('input-plat-h') as HTMLInputElement).value, 10);
    const z  = parseInt((document.getElementById('input-plat-z') as HTMLInputElement).value, 10);
    p.zIndex = isNaN(z) || z === 0 ? undefined : z;
    this.readAnimFields('plat', p);
  }

  private readBlockInputs() {
    if (this.selected === null || this.selectedKind !== 'block') return;
    const b  = this.map.blocks[this.selected];
    b.x      = parseInt((document.getElementById('input-block-x') as HTMLInputElement).value, 10);
    b.y      = parseInt((document.getElementById('input-block-y') as HTMLInputElement).value, 10);
    b.width  = parseInt((document.getElementById('input-block-w') as HTMLInputElement).value, 10);
    b.height = parseInt((document.getElementById('input-block-h') as HTMLInputElement).value, 10);
    const z  = parseInt((document.getElementById('input-block-z') as HTMLInputElement).value, 10);
    b.zIndex = isNaN(z) || z === 0 ? undefined : z;
    this.readAnimFields('block', b);
  }

  private readDecorInputs() {
    if (this.selected === null || this.selectedKind !== 'decor') return;
    const d  = (this.map.decor ?? [])[this.selected];
    if (!d) return;
    d.x      = parseInt((document.getElementById('input-decor-x') as HTMLInputElement).value, 10);
    d.y      = parseInt((document.getElementById('input-decor-y') as HTMLInputElement).value, 10);
    d.width  = Math.max(1, parseInt((document.getElementById('input-decor-w') as HTMLInputElement).value, 10));
    d.height = Math.max(1, parseInt((document.getElementById('input-decor-h') as HTMLInputElement).value, 10));
    const z  = parseInt((document.getElementById('input-decor-z') as HTMLInputElement).value, 10);
    d.zIndex = isNaN(z) || z === 0 ? undefined : z;
    const op = parseInt((document.getElementById('input-decor-opacity') as HTMLInputElement).value, 10);
    d.opacity = isNaN(op) || op >= 100 ? undefined : Math.max(0, op) / 100;
    (document.getElementById('display-decor-opacity') as HTMLElement).textContent = `${isNaN(op) ? 100 : op}%`;
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
    const bgSel        = this.selectedBackground;
    const settingsSel  = this.selectedMapSettings;
    const configSel    = this.selectedGameConfig;
    const coinSkinsSel = this.selectedCoinSkins;
    const platSel    = this.selected !== null && this.selectedKind === 'platform' && this.selected < m.platforms.length;
    const blockSel   = this.selected !== null && this.selectedKind === 'block'    && this.selected < m.blocks.length;
    const decorSel   = this.selected !== null && this.selectedKind === 'decor'    && this.selected < (m.decor ?? []).length;

    // Show only the relevant section
    document.getElementById('section-player-tower')!.style.display = playerSel ? 'flex' : 'none';
    document.getElementById('section-enemy-tower')! .style.display = enemySel  ? 'flex' : 'none';
    document.getElementById('section-coinbox')!     .style.display = coinSel   ? 'flex' : 'none';
    document.getElementById('section-ground')!      .style.display = groundSel ? 'flex' : 'none';
    document.getElementById('section-background')!  .style.display = bgSel       ? 'flex' : 'none';
    document.getElementById('section-map-settings')!.style.display = settingsSel ? 'flex' : 'none';
    document.getElementById('section-game-config')! .style.display = configSel  ? 'flex' : 'none';
    document.getElementById('section-coin-skins')!  .style.display = coinSkinsSel ? 'flex' : 'none';
    document.getElementById('section-platforms')!   .style.display = platSel   ? 'flex' : 'none';
    document.getElementById('section-blocks')!      .style.display = blockSel  ? 'flex' : 'none';
    document.getElementById('section-decor')!       .style.display = decorSel  ? 'flex' : 'none';

    if (playerSel) {
      (document.getElementById('input-player-x')      as HTMLInputElement).value  = String(m.playerTowerX);
      (document.getElementById('input-player-y')      as HTMLInputElement).value  = String(m.playerTowerY ?? this.groundTopY);
      (document.getElementById('input-player-z')      as HTMLInputElement).value  = String(m.playerTowerZ ?? 0);
      (document.getElementById('input-player-tribe')  as HTMLSelectElement).value = m.playerTowerTribe ?? 'kattgard';
    }
    if (enemySel) {
      (document.getElementById('input-enemy-x')      as HTMLInputElement).value  = String(m.enemyTowerX);
      (document.getElementById('input-enemy-y')      as HTMLInputElement).value  = String(m.enemyTowerY  ?? this.groundTopY);
      (document.getElementById('input-enemy-z')      as HTMLInputElement).value  = String(m.enemyTowerZ  ?? 0);
      (document.getElementById('input-enemy-tribe')  as HTMLSelectElement).value = m.enemyTowerTribe ?? 'lapinor';
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
      (document.getElementById('input-plat-tile-w') as HTMLInputElement).value = p.skinTileW !== undefined ? String(p.skinTileW) : '';
      (document.getElementById('input-plat-tile-h') as HTMLInputElement).value = p.skinTileH !== undefined ? String(p.skinTileH) : '';
      this.syncAnimToUI('plat', p, p.x + p.width);
      document.getElementById('plat-label')!.textContent = `Platform ${this.selected! + 1}`;
      this.syncPlatformSkinPreview();
    }
    if (blockSel) {
      const b = m.blocks[this.selected!];
      (document.getElementById('input-block-x') as HTMLInputElement).value = String(b.x);
      (document.getElementById('input-block-y') as HTMLInputElement).value = String(b.y);
      (document.getElementById('input-block-w') as HTMLInputElement).value = String(b.width);
      (document.getElementById('input-block-h') as HTMLInputElement).value = String(b.height);
      (document.getElementById('input-block-z') as HTMLInputElement).value = String(b.zIndex ?? 0);
      // Default end point: one block-width to the right; speed 60 px/s.
      // These are only used as initial values when the user first ticks Animate.
      this.syncAnimToUI('block', b, b.x + b.width);
      document.getElementById('block-label')!.textContent = `Block ${this.selected! + 1}`;
      this.syncBlockSkinPreview();
    }
    if (decorSel) {
      const d = (m.decor ?? [])[this.selected!];
      const front = (d.zIndex ?? 0) >= DECOR_FRONT_Z;
      (document.getElementById('input-decor-x') as HTMLInputElement).value = String(d.x);
      (document.getElementById('input-decor-y') as HTMLInputElement).value = String(d.y);
      (document.getElementById('input-decor-w') as HTMLInputElement).value = String(d.width);
      (document.getElementById('input-decor-h') as HTMLInputElement).value = String(d.height);
      const zInput = document.getElementById('input-decor-z') as HTMLInputElement;
      zInput.value    = String(d.zIndex ?? 0);
      zInput.disabled = front;  // when in front of characters, z is pinned to DECOR_FRONT_Z
      (document.getElementById('input-decor-front') as HTMLInputElement).checked = front;
      const opPct = Math.round((d.opacity ?? 1) * 100);
      (document.getElementById('input-decor-opacity') as HTMLInputElement).value = String(opPct);
      (document.getElementById('display-decor-opacity') as HTMLElement).textContent = `${opPct}%`;
      document.getElementById('decor-label')!.textContent = `Decor ${this.selected! + 1}`;
      this.syncDecorSkinPreview();
    }
    if (groundSel) {
      (document.getElementById('display-ground-w') as HTMLInputElement).value = String(m.worldWidth);
      (document.getElementById('display-ground-h') as HTMLInputElement).value = String(this.groundStripH);
      (document.getElementById('input-ground-tile-w') as HTMLInputElement).value = m.groundSkinTileW !== undefined ? String(m.groundSkinTileW) : '';
      (document.getElementById('input-ground-tile-h') as HTMLInputElement).value = m.groundSkinTileH !== undefined ? String(m.groundSkinTileH) : '';
      (document.getElementById('input-ground-z') as HTMLInputElement).value = String(m.groundZ ?? 0);
      this.syncGroundSkinPreview();
    }
    if (bgSel) {
      this.syncBackgroundSkinPreview();
      this.syncBackgroundSkin2Preview();
    }
    if (coinSkinsSel) {
      this.syncCoinSkinsPreview();
    }
    if (settingsSel) {
      (document.getElementById('input-world-width')   as HTMLInputElement).value = String(m.worldWidth);
      (document.getElementById('input-world-height')  as HTMLInputElement).value = String(m.worldHeight ?? WORLD_H);
      (document.getElementById('input-ground-height') as HTMLInputElement).value = String(m.groundHeight ?? (m.worldHeight ?? WORLD_H) - GROUND_Y);
      const total       = m.durationSec ?? GameConfig.canvas.durationSec;
      const isOverride  = m.durationSec !== undefined;
      const mins        = Math.floor(total / 60);
      const secs        = total % 60;
      const minInput = document.getElementById('input-map-duration-min') as HTMLInputElement;
      const secInput = document.getElementById('input-map-duration-sec') as HTMLInputElement;
      minInput.value = isOverride ? String(mins) : '';
      secInput.value = isOverride ? String(secs) : '';
      minInput.placeholder = String(Math.floor(GameConfig.canvas.durationSec / 60));
      secInput.placeholder = String(GameConfig.canvas.durationSec % 60);
    }
    if (configSel) {
      const gc = GameConfig;
      const jumpV   = gc.characters.jumpVelocity;
      const gravity = gc.characters.gravity;
      const jumpH   = Math.round(jumpV * jumpV / (2 * gravity));
      (document.getElementById('gc-jump-velocity') as HTMLElement).textContent = `${jumpV} px/s`;
      (document.getElementById('gc-gravity')       as HTMLElement).textContent = `${gravity} px/s²`;
      (document.getElementById('gc-jump-height')   as HTMLElement).textContent = `≈ ${jumpH} px`;
    }

    // Note: previously also called syncSkinPreviews() for tower skins; that
    // now lives in the per-tribe modal and is wired separately.

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
    } else if (settingsSel) {
      dot.style.background = '#94a3b8'; label.style.color = '#cbd5e1';
      label.style.fontStyle = 'normal'; label.textContent = 'Map Settings';
    } else {
      dot.style.background = '#334'; label.style.color = 'var(--muted-fg, #64748b)';
      label.style.fontStyle = 'italic';
      label.textContent = 'Nothing selected — click an object on the map';
    }

  }

  // ── Tribe Tower Skins modal ──────────────────────────────────────────
  // Edits the per-tribe template store (TribeTowerTemplates). Changes are
  // staged in-memory until the user clicks Save; Close cancels.

  private tribeSkinDraft: Record<Tribe, {
    skin?: string;
    w?: number;
    h?: number;
    collision?: { x: number; y: number; w: number; h: number };
    spawn?: { x: number; y: number };
  }> = {} as Record<Tribe, {
    skin?: string;
    w?: number;
    h?: number;
    collision?: { x: number; y: number; w: number; h: number };
    spawn?: { x: number; y: number };
  }>;
  /** Tribe currently being edited in the modal. Persists across re-opens. */
  private tribeSkinSelected: Tribe = (Object.values(TRIBES)[0] as { id: Tribe }).id;

  private bindTribeSkinsModal(): void {
    const modal     = document.getElementById('tribe-skins-modal')!;
    const grid      = document.getElementById('tribe-skins-grid')!;
    const select    = document.getElementById('tribe-skins-select') as HTMLSelectElement;
    const openBtn   = document.getElementById('btn-tribe-skins')!;
    const saveBtn   = document.getElementById('btn-tribe-skins-save')!;
    const closeBtn  = document.getElementById('btn-tribe-skins-close')!;
    const exportBtn = document.getElementById('btn-tribe-skins-export')!;
    const importBtn = document.getElementById('btn-tribe-skins-import')!;

    // Populate the tribe dropdown once.
    for (const info of Object.values(TRIBES)) {
      const opt = document.createElement('option');
      opt.value       = info.id;
      opt.textContent = info.displayName;
      select.appendChild(opt);
    }
    select.value = this.tribeSkinSelected;
    select.addEventListener('change', () => {
      this.tribeSkinSelected = select.value as Tribe;
      buildGrid();
    });

    const buildGrid = () => {
      grid.innerHTML = '';
      const tribe = this.tribeSkinSelected;
      const info  = TRIBES[tribe];
      const draft = this.tribeSkinDraft[tribe];

      // Default the editable boxes to the rendered skin size so the user has
      // something visible to drag/edit even before saving.
      const skinW    = draft.w ?? TOWER_W;
      const skinH    = draft.h ?? TOWER_H;
      const col      = draft.collision ?? { x: 0, y: 0, w: skinW, h: skinH };
      const sp       = draft.spawn     ?? { x: skinW, y: 0 };

      const block = document.createElement('div');
      block.className = 'tribe-skin-block';
      block.innerHTML = `
        <div class="tribe-skin-preview">
          <div class="tribe-skin-preview-wrap" id="tribe-skin-wrap-${tribe}">
            <div class="tribe-skin-preview-stage" id="tribe-skin-stage-${tribe}"
                 style="width:${skinW}px; height:${skinH}px;">
              ${draft.skin
                ? `<img id="tribe-skin-img-${tribe}" src="${draft.skin}" alt="${info.displayName} tower" style="width:${skinW}px; height:${skinH}px;" />`
                : `<span class="tribe-skin-preview-empty" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center;">no skin</span>`}
              <div class="tribe-skin-collision" id="tribe-skin-collision-${tribe}"
                   style="left:${col.x}px; top:${col.y}px; width:${col.w}px; height:${col.h}px;"></div>
              <div class="tribe-skin-spawn" id="tribe-skin-spawn-${tribe}"
                   style="left:${sp.x}px; top:${sp.y}px;"></div>
            </div>
          </div>
        </div>
        <div class="tribe-skin-fields">
          <input type="file" id="tribe-skin-file-${tribe}" accept="image/*" />
          <button id="tribe-skin-clear-${tribe}" class="danger" style="padding:3px 8px;">&#x2715;</button>
          <label>W:</label>
          <input type="number" id="tribe-skin-w-${tribe}" value="${skinW}" style="width:80px;" />
          <label>H:</label>
          <input type="number" id="tribe-skin-h-${tribe}" value="${skinH}" style="width:80px;" />
        </div>
        <fieldset class="tribe-skin-fieldset">
          <legend>Collision box</legend>
          <label>X:</label><input type="number" id="tribe-skin-col-x-${tribe}" value="${col.x}" />
          <label>Y:</label><input type="number" id="tribe-skin-col-y-${tribe}" value="${col.y}" />
          <label>W:</label><input type="number" id="tribe-skin-col-w-${tribe}" value="${col.w}" />
          <label>H:</label><input type="number" id="tribe-skin-col-h-${tribe}" value="${col.h}" />
        </fieldset>
        <fieldset class="tribe-skin-fieldset">
          <legend>Spawn point</legend>
          <label>X:</label><input type="number" id="tribe-skin-sp-x-${tribe}" value="${sp.x}" />
          <label>Y:</label><input type="number" id="tribe-skin-sp-y-${tribe}" value="${sp.y}" />
        </fieldset>
      `;
      grid.appendChild(block);

      // Scale the stage so the whole skin fits in the preview area. The
      // stage keeps skin-pixel dimensions internally (so the collision
      // rectangle's x/y/w/h continue to map 1:1 to the user's inputs); we
      // shrink it visually via CSS transform and resize the layout wrapper
      // to the rendered size so flex-centering still works.
      const stageEl   = document.getElementById(`tribe-skin-stage-${tribe}`)!;
      const wrapEl    = document.getElementById(`tribe-skin-wrap-${tribe}`)!;
      const previewEl = stageEl.closest('.tribe-skin-preview') as HTMLElement;
      if (previewEl && skinW > 0 && skinH > 0) {
        // Subtract the preview's 8px padding on each side.
        const availW = Math.max(0, previewEl.clientWidth  - 16);
        const availH = Math.max(0, previewEl.clientHeight - 16);
        const scale  = Math.min(1, availW / skinW, availH / skinH);
        stageEl.style.transform = `scale(${scale})`;
        wrapEl.style.width  = `${skinW * scale}px`;
        wrapEl.style.height = `${skinH * scale}px`;
      }

      document.getElementById(`tribe-skin-file-${tribe}`)!.addEventListener('change', e => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          this.tribeSkinDraft[tribe].skin = reader.result as string;
          buildGrid();
        };
        reader.readAsDataURL(file);
      });
      document.getElementById(`tribe-skin-clear-${tribe}`)!.addEventListener('click', () => {
        delete this.tribeSkinDraft[tribe].skin;
        buildGrid();
      });
      document.getElementById(`tribe-skin-w-${tribe}`)!.addEventListener('change', e => {
        const val = parseInt((e.target as HTMLInputElement).value, 10);
        this.tribeSkinDraft[tribe].w = isNaN(val) ? undefined : val;
        buildGrid();
      });
      document.getElementById(`tribe-skin-h-${tribe}`)!.addEventListener('change', e => {
        const val = parseInt((e.target as HTMLInputElement).value, 10);
        this.tribeSkinDraft[tribe].h = isNaN(val) ? undefined : val;
        buildGrid();
      });

      // Collision + spawn editors. Every change repaints the preview overlay.
      const updateCol = () => {
        const x = parseInt((document.getElementById(`tribe-skin-col-x-${tribe}`) as HTMLInputElement).value, 10);
        const y = parseInt((document.getElementById(`tribe-skin-col-y-${tribe}`) as HTMLInputElement).value, 10);
        const w = parseInt((document.getElementById(`tribe-skin-col-w-${tribe}`) as HTMLInputElement).value, 10);
        const h = parseInt((document.getElementById(`tribe-skin-col-h-${tribe}`) as HTMLInputElement).value, 10);
        if ([x, y, w, h].some(v => isNaN(v))) return;
        this.tribeSkinDraft[tribe].collision = { x, y, w, h };
        const el = document.getElementById(`tribe-skin-collision-${tribe}`)!;
        el.style.left = `${x}px`; el.style.top = `${y}px`;
        el.style.width = `${w}px`; el.style.height = `${h}px`;
      };
      const updateSp = () => {
        const x = parseInt((document.getElementById(`tribe-skin-sp-x-${tribe}`) as HTMLInputElement).value, 10);
        const y = parseInt((document.getElementById(`tribe-skin-sp-y-${tribe}`) as HTMLInputElement).value, 10);
        if (isNaN(x) || isNaN(y)) return;
        this.tribeSkinDraft[tribe].spawn = { x, y };
        const el = document.getElementById(`tribe-skin-spawn-${tribe}`)!;
        el.style.left = `${x}px`; el.style.top = `${y}px`;
      };
      ['col-x', 'col-y', 'col-w', 'col-h'].forEach(k =>
        document.getElementById(`tribe-skin-${k}-${tribe}`)!.addEventListener('input', updateCol));
      ['sp-x', 'sp-y'].forEach(k =>
        document.getElementById(`tribe-skin-${k}-${tribe}`)!.addEventListener('input', updateSp));
    };

    const openModal = () => {
      // Snapshot the current templates into the draft so edits can be cancelled.
      this.tribeSkinDraft = {} as Record<Tribe, { skin?: string; w?: number; h?: number }>;
      for (const info of Object.values(TRIBES)) {
        this.tribeSkinDraft[info.id] = { ...getTowerTemplate(info.id) };
      }
      select.value = this.tribeSkinSelected;
      // Show the modal BEFORE buildGrid so the preview container reports a
      // non-zero clientWidth/Height when the stage scale is computed. (When
      // display is still none, the measurement returns 0 and the stage gets
      // transform: scale(0) and disappears.)
      modal.style.display = 'flex';
      buildGrid();
    };
    const closeModal = () => { modal.style.display = 'none'; };

    openBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    saveBtn.addEventListener('click', () => {
      for (const info of Object.values(TRIBES)) {
        // Replace the stored template wholesale so a cleared skin actually clears.
        setTowerTemplate(info.id, this.tribeSkinDraft[info.id]);
      }
      // Clear the data-URL image cache so the new skin re-loads on the next
      // render-loop tick.
      this.skinImages.clear();
      closeModal();
    });

    exportBtn.addEventListener('click', async () => {
      const json = exportTemplatesJson();
      try {
        await navigator.clipboard.writeText(json);
        alert('Tribe tower templates copied to clipboard.');
      } catch {
        // Clipboard blocked — fall back to a prompt the user can copy from.
        prompt('Copy this JSON:', json);
      }
    });
    importBtn.addEventListener('click', () => {
      const raw = prompt('Paste tribe tower templates JSON:');
      if (!raw) return;
      try {
        importTemplatesJson(raw);
        this.skinImages.clear();
        openModal(); // re-snapshot from the freshly-imported store
      } catch {
        alert('Could not parse JSON.');
      }
    });
  }

  // ── File save / load ─────────────────────────────────────────────────────

  private exportToFile(): void {
    const pkg = {
      version:        1,
      type:           'coin_map_package',
      map:            this.map,
      towerTemplates: JSON.parse(exportTemplatesJson()) as Record<string, unknown>,
    };
    const json = JSON.stringify(pkg, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${this.map.id || 'map'}.coinmap.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private importFromFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const pkg = JSON.parse(reader.result as string) as {
          type:           string;
          map:            MapDefinition;
          towerTemplates?: Record<string, unknown>;
        };
        if (pkg.type !== 'coin_map_package') throw new Error('Not a coin map package');
        this.pushUndo();
        this.map = pkg.map;
        if (pkg.towerTemplates) {
          importTemplatesJson(JSON.stringify(pkg.towerTemplates));
          this.skinImages.clear();
        }
        this.clearSelection();
        this.syncInputsFromMap();
      } catch {
        alert('Could not load file — make sure it is a valid COIN map package.');
      }
    };
    reader.readAsText(file);
  }

  private exportAllToFile(): void {
    // Use the live in-memory map for whichever campaign map is currently loaded
    // so unsaved edits are captured without requiring "Save to Game" first.
    const allMaps = WORLDS.flatMap(w => [...w.maps]).map(m =>
      m.id === this.map.id ? this.map : loadMapWithOverride(m),
    );
    const pkg = {
      version:        1,
      type:           'coin_map_collection',
      maps:           allMaps,
      towerTemplates: JSON.parse(exportTemplatesJson()) as Record<string, unknown>,
    };
    const json = JSON.stringify(pkg, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    const dt = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    a.download = `mapbuilder-coins-all-${dt}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private importAllFromFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const pkg = JSON.parse(reader.result as string) as {
          type:           string;
          maps:           MapDefinition[];
          towerTemplates?: Record<string, unknown>;
        };
        if (pkg.type !== 'coin_map_collection') throw new Error('Not a coin map collection');
        for (const map of pkg.maps) saveMapToStorage(map);
        if (pkg.towerTemplates) {
          importTemplatesJson(JSON.stringify(pkg.towerTemplates));
          this.skinImages.clear();
        }
        // Refresh the builder if the current map is among the imported ones
        const match = pkg.maps.find(m => m.id === this.map.id);
        if (match) {
          this.pushUndo();
          this.map = match;
          this.clearSelection();
          this.syncInputsFromMap();
        }
      } catch {
        alert('Could not load file — make sure it is a valid COIN map collection.');
      }
    };
    reader.readAsText(file);
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => new MapBuilder());
