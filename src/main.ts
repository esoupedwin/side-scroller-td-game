import { Game, type CpuStrategyInfo } from './Game';
import type { PowerUpType } from './PowerUp';
import {
  charCost, charDisplayName, charIcon, ALL_CHAR_TYPES,
  VIEWPORT_WIDTH, VIEWPORT_HEIGHT, MOBILE_HUD_SCALE, LOADOUT_MAX_CARDS, CHEAT_SKIP_INTRO_SCREENS, CHEAT_TOWER_DAMAGE,
  CHEAT_CLOCK_SKIP_SEC,
  TRIBE_POWER_UPS, TRIBE_PU_IDS, TRIBE_PU_PLAYER_DEFAULT,
  type CharTypeName, type TribePowerUpId,
} from './constants';
import { getOwnedCards, loadLoadout, saveLoadout } from './CardCollection';
import { charStatSheet, statScale, type StatScale } from './CharStats';
import { rankLabel, xpProgress } from './CharacterHUD';
import { ensureSpriteSets, unloadSpriteSetsExcept, spriteTextureBytes, spriteAtlasStats, type SpriteSetKey } from './SpriteRegistry';
import { toggleMute, isMuted } from './AudioManager';
import { WORLDS, ALL_MAPS, loadMapWithOverride, mapCoords } from './maps';
import { isTouchDevice, isIOS, isStandalone, canFullscreen, isFullscreen, enterFullscreen, exitFullscreen, onFullscreenChange } from './mobile';
import { TRIBES, TRIBE_ROSTERS, type Tribe, getPlayerTribe, setPlayerTribe } from './Tribes';
import { RESOLUTIONS, getResolutionHeight, setResolutionHeight } from './resolution';
import { loadTemplates as loadTribeTowerTemplates } from './TribeTowerTemplates';

const loadingScreen = document.getElementById('loading-screen')!;

// Show the build version (package.json version + commit SHA, injected by Vite).
document.getElementById('loading-version')!.textContent = __APP_VERSION__;

loadTribeTowerTemplates(); // sync localStorage read — must run before `new Game()` so Tower can read skins
// Character sheets are loaded per match (see matchSpriteKeys / launchMatch):
// only the player's loadout plus the enemy roster stay resident, and the rest
// is evicted on map switch. The dev fast-start skips the squad screen and its
// match starts spawning immediately, so it needs every roster up front.
if (CHEAT_SKIP_INTRO_SCREENS) await ensureSpriteSets(allRosterKeys());

// Fade out and remove the loading screen once startup assets are ready
loadingScreen.classList.add('fade-out');
loadingScreen.addEventListener('transitionend', () => loadingScreen.remove(), { once: true });

const container       = document.getElementById('game-container')!;
const hudEl           = document.getElementById('char-hud')!;
const uiOverlay       = document.getElementById('ui-overlay')!;
const coinAmountEl    = document.getElementById('coin-amount')!;
const cpuCoinAmountEl = document.getElementById('cpu-coin-amount')!;
const cpuCharsListEl  = document.getElementById('cpu-chars-list')!;
const enemyTowerHpEl  = document.getElementById('enemy-tower-hp')!;

// Top-center HUD: HP bars + clock + numeric labels for both towers.
const topHudEl        = document.getElementById('top-hud')!;
const playerHpFillEl  = document.getElementById('player-hp-fill')!;
const playerHpLabelEl = document.getElementById('player-hp-label')!;
const enemyHpFillEl   = document.getElementById('enemy-hp-fill')!;
const enemyHpLabelEl  = document.getElementById('enemy-hp-label')!;

// Spawn buttons are GENERATED from the active tribe's roster (gameConfig
// character-block keys, in declaration order) — a new character block gets a
// button with no HTML/CSS edits. Name/portrait/cost come from the config;
// card art is probed from /cards/buy/card_buy_<type>.png and applied when it
// exists (same optional-art pattern as the loadout grid). Rebuilt on every
// tribe/loadout change by syncSpawnButtonVisibility().
const spawnBtns = new Map<string, HTMLButtonElement>();

function rebuildSpawnButtons() {
  const tribe = getPlayerTribe();
  uiOverlay.replaceChildren();
  spawnBtns.clear();
  lastDisabledByBtn.clear();
  for (const t of TRIBE_ROSTERS[tribe]) {
    if (!loadout.has(t)) continue;   // only the picked loadout gets buttons
    const btn = document.createElement('button');
    btn.id        = `spawn-${t}-btn`;
    btn.className = 'spawn-btn';

    const name = document.createElement('span');
    name.className   = 'card-name';
    name.textContent = charDisplayName(tribe, t);
    const portrait = document.createElement('span');
    portrait.className   = 'card-portrait';
    portrait.textContent = charIcon(tribe, t);
    const cost = document.createElement('span');
    cost.className   = 'btn-cost';
    cost.id          = `${t}-cost`;
    cost.textContent = String(charCost(tribe, t));
    btn.append(name, portrait, cost);

    // Card art is optional — the cream emoji card stays until the PNG loads.
    const art = new Image();
    art.onload = () => {
      btn.classList.add('has-card');
      btn.style.backgroundImage = `url('${art.src}')`;
    };
    // Thumbnails can wait behind the splash hero and the first map's skins.
    (art as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'low';
    art.src = `/cards/buy/card_buy_${t}.png`;

    btn.addEventListener('click', () => game.spawnPlayer(t as CharTypeName));
    uiOverlay.appendChild(btn);
    spawnBtns.set(t, btn);
  }
  // Fresh buttons start enabled — sync disabled state to the current balance.
  handleCoinsChanged(lastKnownCoins);
}

// Costs are per-tribe; the buttons are rebuilt on tribe change so the labels
// are always fresh — kept as a helper for call sites that only need costs.
function refreshCostLabels() {
  const tribe = getPlayerTribe();
  for (const [t, btn] of spawnBtns) {
    const el = btn.querySelector('.btn-cost');
    if (el) el.textContent = String(charCost(tribe, t));
  }
}
const countdownEl    = document.getElementById('countdown')!;
const gameOverEl     = document.getElementById('game-over')!;
const goTitle        = document.getElementById('game-over-title')!;
const goSub          = document.getElementById('game-over-sub')!;
const restartBtn     = document.getElementById('restart-btn')!;

const pauseOverlay = document.getElementById('pause-overlay')!;
const canvas = document.createElement('canvas');
container.insertBefore(canvas, container.firstChild);

// ── Scale-to-fit ────────────────────────────────────────────────────────────
// The game renders at a fixed logical size (VIEWPORT_WIDTH × VIEWPORT_HEIGHT). Scale
// the whole #game-container — canvas plus the HUD/spawn-card overlays inside it —
// uniformly to fit the browser window, preserving aspect (letterboxed by the body
// background). The pause menu / command modal / dev panel are siblings of the
// container, so they stay fixed to the viewport and are unaffected by this scale.
container.style.transformOrigin = 'center center';   // invariant — set once
function fitGameToWindow() {
  // On phones innerHeight can include the strip under a collapsing URL bar;
  // visualViewport is what is actually on screen. Desktop keeps innerWidth /
  // innerHeight so a pinch-zoomed window does not shrink the game.
  const vv = isTouchDevice ? window.visualViewport : null;
  const w  = vv?.width  ?? window.innerWidth;
  const h  = vv?.height ?? window.innerHeight;
  const scale = Math.min(w / VIEWPORT_WIDTH, h / VIEWPORT_HEIGHT);
  container.style.transform = `scale(${scale})`;
  fitFixedPanels(w, h);
}

// The squad picker, pause menu and command modal are position:fixed siblings
// of #game-container, so they miss its scale-to-fit. On a phone the squad card
// is taller than the screen and Start sits below the fold. Shrink each panel
// (never enlarge) so the whole card is on screen; the cards' own max-height +
// overflow scroll stays as the fallback when a panel is *not* being shrunk.
// A ResizeObserver refits when a hidden panel is shown or its content changes.
const fixedPanels = Array.from(document.querySelectorAll<HTMLElement>('.lo-card, .pm-card, .cmd-card'));
for (const el of fixedPanels) el.style.transformOrigin = 'center center';
function fitFixedPanels(w = window.innerWidth, h = window.innerHeight) {
  for (const el of fixedPanels) {
    if (el.offsetParent === null) continue;               // hidden — nothing to measure
    const naturalH = el.scrollHeight;                     // content height, ignoring the max-height clamp
    const naturalW = el.offsetWidth;
    const scale = Math.min(1, (h * 0.94) / naturalH, (w * 0.96) / naturalW);
    if (scale < 1) {
      el.style.maxHeight = 'none';                        // let it lay out at full height, then shrink it visually
      el.style.transform = `scale(${scale})`;
    } else {
      el.style.maxHeight = '';
      el.style.transform = '';
    }
  }
}
const panelObserver = new ResizeObserver(() => fitFixedPanels(
  (isTouchDevice ? window.visualViewport?.width  : undefined) ?? window.innerWidth,
  (isTouchDevice ? window.visualViewport?.height : undefined) ?? window.innerHeight,
));
for (const el of fixedPanels) panelObserver.observe(el);
window.addEventListener('resize', fitGameToWindow);
window.visualViewport?.addEventListener('resize', fitGameToWindow);
screen.orientation?.addEventListener('change', fitGameToWindow);
onFullscreenChange(fitGameToWindow);
fitGameToWindow();

// ── Mobile: fullscreen button + one-shot fullscreen on first tap ──────────
// Shown only where it can do something: a touch device with the Fullscreen
// API (Android Chrome), not already launched from the home screen. iPhone
// has no API at all — it gets the Add-to-Home-Screen hint on the splash.
// Touch devices: zoom the DOM HUD (index.html applies `zoom: var(--hud-scale)`
// to the top bar, coin counter, spawn cards and corner buttons).
document.documentElement.style.setProperty('--hud-scale', String(MOBILE_HUD_SCALE));
document.body.classList.toggle('is-touch', isTouchDevice);

const fullscreenBtn = document.getElementById('fullscreen-btn')!;
if (isTouchDevice && canFullscreen && !isStandalone) {
  fullscreenBtn.classList.add('is-shown');
  fullscreenBtn.addEventListener('click', () => { void (isFullscreen() ? exitFullscreen() : enterFullscreen()); });
  onFullscreenChange(() => { fullscreenBtn.textContent = isFullscreen() ? '⤢' : '⛶'; });
}

let gameOver = false;

// Cache the last-applied `.disabled` per button so the per-balance update
// only writes when the threshold is actually crossed. Must be declared BEFORE
// `new Game(...)` because the Game constructor synchronously fires
// handleCoinsChanged via notifyCoins() — TDZ otherwise.
const lastDisabledByBtn = new Map<HTMLButtonElement, boolean>();
// Last balance seen by handleCoinsChanged — replayed onto freshly (re)built
// spawn buttons so they start with the correct disabled state.
let lastKnownCoins = 0;

let game = new Game(canvas, hudEl, handleGameOver, handleCoinsChanged, handleCpuCoinsChanged, handleCpuCharsChanged, handleCpuStrategyChanged, handleTimeChanged, handleEnemyTowerHpChanged, handlePlayerTowerHpChanged);

// ── Tribe power-up: selection persistence + activation button ───────────────
const TRIBE_PU_KEY = 'coin_tribe_powerup';

function loadTribePU(): TribePowerUpId {
  const stored = localStorage.getItem(TRIBE_PU_KEY);
  return (TRIBE_PU_IDS as readonly string[]).includes(stored ?? '')
    ? stored as TribePowerUpId
    : TRIBE_PU_PLAYER_DEFAULT;
}

let tribePU: TribePowerUpId = loadTribePU();
game.setPlayerTribePowerUp(tribePU);

const tribePUBtn   = document.getElementById('tribe-pu-btn')  as HTMLButtonElement;
const tribePUArt   = document.getElementById('tribe-pu-art')  as HTMLElement;
const tribePUIcon  = document.getElementById('tribe-pu-icon')!;
const tribePUCd    = document.getElementById('tribe-pu-cd')!;
const cpuTribePUEl = document.getElementById('cpu-tribe-pu')!;

function refreshTribePUBtn() {
  const state = game.playerTribePowerUp;
  const meta  = TRIBE_POWER_UPS[state.id];
  // PNG skin as the button face; the emoji span is a fallback shown only when
  // the art fails to load (.no-art, set by the error probe below).
  tribePUIcon.textContent = meta.icon;
  if (tribePUBtn.dataset.artId !== state.id) {
    tribePUBtn.dataset.artId = state.id;
    tribePUBtn.classList.remove('no-art');
    tribePUArt.style.backgroundImage = `url('${meta.art}')`;
    const probe = new Image();
    probe.onerror = () => {
      if (tribePUBtn.dataset.artId !== state.id) return;
      tribePUArt.style.backgroundImage = '';
      tribePUBtn.classList.add('no-art');
    };
    probe.src = meta.art;
  }
  tribePUBtn.title        = `${meta.name} — ${meta.desc}`;
  tribePUBtn.disabled     = !state.ready;
  tribePUBtn.classList.toggle('is-ready', state.ready);
  tribePUCd.textContent   = state.cooldown > 0 ? `${state.cooldown}s` : '';
  // Recharge ring: gold arc sweeps the circumference as --cd goes 0→1.
  tribePUBtn.style.setProperty('--cd', String(state.frac));

  // Dev bar: CPU's pick + cooldown state (element lives in the dev panel).
  const cpu     = game.cpuTribePowerUp;
  const cpuMeta = TRIBE_POWER_UPS[cpu.id];
  cpuTribePUEl.textContent = `${cpuMeta.icon} ${cpuMeta.name} ${cpu.ready ? '· ready' : `· ${cpu.cooldown}s`}`;
  cpuTribePUEl.style.color = cpu.ready ? '#7ee081' : '#f4a261';
}

tribePUBtn.addEventListener('click', () => {
  if (game.activateTribePowerUp('player')) refreshTribePUBtn();
});
refreshTribePUBtn();
// 10 Hz poll — smooth enough for the recharge ring sweep (the registered
// @property --cd transition interpolates between updates), still trivial cost.
window.setInterval(refreshTribePUBtn, 100);

// Squad-screen picker: one option card per power-up, highlighted selection.
{
  const optionsEl = document.getElementById('tribe-pu-options')!;
  for (const id of TRIBE_PU_IDS) {
    const meta = TRIBE_POWER_UPS[id];
    const opt  = document.createElement('button');
    opt.className    = 'tp-option';
    opt.dataset.puId = id;
    if (id === tribePU) opt.classList.add('selected');
    // PNG art with emoji fallback if the asset is missing.
    const icon = document.createElement('span');
    icon.className   = 'tp-icon';
    const art = new Image();
    art.className = 'tp-art';
    art.src       = meta.art;
    art.alt       = meta.name;
    art.onload    = () => { icon.replaceChildren(art); };
    icon.textContent = meta.icon;
    const name = document.createElement('span');
    name.textContent = meta.name;
    const desc = document.createElement('span');
    desc.className   = 'tp-desc';
    desc.textContent = meta.desc;
    opt.append(icon, name, desc);
    opt.addEventListener('click', () => {
      tribePU = id;
      localStorage.setItem(TRIBE_PU_KEY, id);
      game.setPlayerTribePowerUp(id);
      for (const el of optionsEl.children) el.classList.toggle('selected', el === opt);
      refreshTribePUBtn();
    });
    optionsEl.appendChild(opt);
  }
}

// Shared restart routine — used by Play Again, Load Map, and the tribe
// selector. Optional mapDef forwards a new map to game.reset(); omit it to
// restart the current map.
function restartCurrentGame(mapDef?: ReturnType<typeof loadMapWithOverride>) {
  gameOver = false;
  gameOverEl.style.display    = 'none';
  pauseOverlay.style.display  = 'none';
  uiOverlay.style.visibility  = 'visible';
  hudEl.style.visibility      = 'visible';
  game.reset(mapDef);  // reset() calls onCoinsChanged which re-evaluates button states
}

restartBtn.addEventListener('click', () => restartCurrentGame());

// ── Loadout selection screen ───────────────────────────────────────────────
// Shown before each map starts (first load, tribe change, map change). The
// player picks up to LOADOUT_MAX_CARDS cards from their collection; only the
// picked types get spawn buttons for the match. Mid-match Restart keeps the
// current loadout without re-asking.
const loadoutScreen  = document.getElementById('loadout-screen')!;
const loadoutGrid    = document.getElementById('loadout-grid')!;
const loadoutSub     = document.getElementById('loadout-sub')!;
const loadoutCountEl = document.getElementById('loadout-count')!;
const loadoutStartBtn = document.getElementById('loadout-start-btn') as HTMLButtonElement;

function validLoadoutSet(types: string[]): Set<string> {
  // Inputs come from getOwnedCards/loadLoadout, which are already roster-
  // filtered — just guard against unknown types lingering in localStorage.
  return new Set(types.filter(t => ALL_CHAR_TYPES.includes(t)));
}

let loadout = validLoadoutSet(loadLoadout(getPlayerTribe()));
let loadoutOpen = false;
// Map queued by the dev map selector while the screen is up; Start forwards it.
let pendingMapDef: ReturnType<typeof loadMapWithOverride> | null = null;
// Tribe the screen is picking for. Differs from getPlayerTribe() when a new
// map is queued — game.reset(mapDef) re-seeds the player tribe from the map's
// placeholder default, so the cards must come from THAT tribe's collection.
let loadoutTribe: Tribe = getPlayerTribe();

// Only the active tribe's roster ∩ the picked loadout gets a spawn button —
// the bar is regenerated from config each time. Also called by the dev tribe
// selector after a tribe switch.
function syncSpawnButtonVisibility() {
  rebuildSpawnButtons();
}

function refreshLoadoutFooter() {
  loadoutCountEl.textContent = `${loadout.size} / ${LOADOUT_MAX_CARDS} selected`;
  loadoutStartBtn.disabled   = loadout.size === 0;
}

// ── Character stat sheet ───────────────────────────────────────────────────
// A floating panel beside the hovered squad card. Hover shows it (desktop);
// the ⓘ badge taps it open and PINS it (touch, where there is no hover). All
// numbers are derived from the unit's gameConfig block — see CharStats.ts.
const loadoutStats = document.getElementById('lo-stats')!;
// Card whose sheet is pinned open by a badge tap; null when following hover.
let pinnedStatsCard: HTMLElement | null = null;
// Per-stat maxima over the tribe roster on screen — rebuilt with the grid so
// every bar reads as "share of the best card here".
let loadoutStatScale: StatScale = { hp: 1, dps: 1, range: 1, speed: 1 };

const escHtml = (t: string) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

function renderStatSheet(tribe: Tribe, type: string) {
  const sheet = charStatSheet(tribe, type, loadoutStatScale);
  const bars = sheet.bars.map(b => `
    <div class="ls-bar-row">
      <div class="ls-bar-top"><span>${escHtml(b.label)}</span><b>${escHtml(b.text)}</b></div>
      <div class="ls-bar-track">
        <div class="ls-bar-fill" style="width:${Math.round(Math.min(1, Math.max(0.02, b.frac)) * 100)}%;background:${b.color}"></div>
      </div>
    </div>`).join('');
  const rows = sheet.rows.map(r =>
    `<div class="ls-row"><span>${escHtml(r.label)}</span><b>${escHtml(r.value)}</b></div>`).join('');
  const traits = sheet.traits.length
    ? `<div class="ls-traits">${sheet.traits.map(t => `<span class="ls-trait">${escHtml(t)}</span>`).join('')}</div>`
    : '';
  loadoutStats.innerHTML = `
    <div class="ls-head">
      <span class="ls-icon">${escHtml(sheet.icon)}</span>
      <span class="ls-name" style="color:${sheet.color}">${escHtml(sheet.name)}</span>
      <span class="ls-cost">🪙 ${sheet.cost}</span>
    </div>
    <div class="ls-role">${escHtml(sheet.role)}</div>
    ${bars}
    <div class="ls-rows">${rows}</div>
    ${traits}`;
}

/** Park the sheet outside the squad dialog (right side, flipping left when the
 *  window is too narrow) and align it vertically with the card it describes, so
 *  it never covers the cards the player is comparing. Falls back to overlaying
 *  the dialog only when neither side has room. */
function positionStatSheet(card: HTMLElement) {
  const c = card.getBoundingClientRect();
  const d = loadoutScreen.querySelector('.lo-card')!.getBoundingClientRect();
  const p = loadoutStats.getBoundingClientRect();
  const gap = 12;
  let left = d.right + gap;
  if (left + p.width > window.innerWidth - 8) left = d.left - gap - p.width;
  left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8));
  let top = c.top + c.height / 2 - p.height / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - p.height - 8));
  loadoutStats.style.left = `${Math.round(left)}px`;
  loadoutStats.style.top  = `${Math.round(top)}px`;
}

function showStatSheet(tribe: Tribe, type: string, card: HTMLElement) {
  renderStatSheet(tribe, type);
  loadoutStats.style.display = 'block';
  positionStatSheet(card);   // must run after display so the panel has a size
}

function hideStatSheet() {
  loadoutStats.style.display = 'none';
  loadoutStats.classList.remove('pinned');
  pinnedStatsCard?.classList.remove('stats-open');
  pinnedStatsCard = null;
}

function buildLoadoutGrid() {
  const tribe = loadoutTribe;
  loadoutSub.textContent = `${TRIBES[tribe].displayName} — choose up to ${LOADOUT_MAX_CARDS} character cards`;
  loadoutGrid.innerHTML  = '';
  hideStatSheet();
  const owned = getOwnedCards(tribe);
  loadoutStatScale = statScale(tribe, owned);
  for (const t of owned) {
    const card = document.createElement('button');
    card.className = 'loadout-card';
    card.dataset.type = t;
    if (loadout.has(t)) card.classList.add('selected');

    const name = document.createElement('span');
    name.className = 'lo-name';
    name.textContent = charDisplayName(tribe, t);
    const check = document.createElement('span');
    check.className = 'lo-check';
    check.textContent = '✓';
    const cost = document.createElement('span');
    cost.className = 'lo-cost';
    cost.textContent = `🪙 ${charCost(tribe, t)}`;
    const info = document.createElement('span');
    info.className = 'lo-info';
    info.textContent = 'i';
    info.title = `${charDisplayName(tribe, t)} stats`;
    card.append(name, check, cost, info);

    // Hover follows the pointer unless a badge tap has pinned another card.
    card.addEventListener('mouseenter', () => {
      if (pinnedStatsCard) return;
      showStatSheet(tribe, t, card);
    });
    card.addEventListener('mouseleave', () => {
      if (!pinnedStatsCard) hideStatSheet();
    });
    // Badge tap: pin/unpin. Stops the click so it never toggles the selection.
    info.addEventListener('click', ev => {
      ev.stopPropagation();
      const wasPinned = pinnedStatsCard === card;
      hideStatSheet();
      if (wasPinned) return;
      pinnedStatsCard = card;
      card.classList.add('stats-open');
      loadoutStats.classList.add('pinned');
      showStatSheet(tribe, t, card);
    });

    // Card art is optional — types without a PNG keep the cream fallback tile.
    const art = new Image();
    art.onload = () => {
      card.classList.add('has-art');
      card.style.backgroundImage = `url('${art.src}')`;
    };
    // Thumbnails can wait behind the splash hero and the first map's skins.
    (art as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'low';
    art.src = `/cards/buy/card_buy_${t}.png`;

    card.addEventListener('click', () => {
      const type = t;
      if (loadout.has(type)) {
        loadout.delete(type);
        card.classList.remove('selected');
      } else if (loadout.size < LOADOUT_MAX_CARDS) {
        loadout.add(type);
        card.classList.add('selected');
      }
      refreshLoadoutFooter();
    });

    loadoutGrid.appendChild(card);
  }
  refreshLoadoutFooter();
}

// Clicking anywhere else on the squad screen releases a pinned sheet (the badge
// itself stops propagation, so its own toggle never reaches this listener).
loadoutScreen.addEventListener('click', ev => {
  const card = (ev.target as HTMLElement).closest('.loadout-card') as HTMLElement | null;
  if (pinnedStatsCard) hideStatSheet();
  // The pointer is still resting on the card that was just clicked, so its
  // mouseenter won't fire again — restore the hover sheet directly.
  if (card?.dataset.type) showStatSheet(loadoutTribe, card.dataset.type, card);
});
window.addEventListener('resize', () => { if (pinnedStatsCard) positionStatSheet(pinnedStatsCard); });

// ── Match-start countdown (3-2-1 → GO!) ────────────────────────────────────
// Runs after the loadout Start button: the fresh match sits paused while the
// numbers pop in the centre of the screen, then the game unfreezes on GO.
const startCountdownEl = document.getElementById('start-countdown')!;
let countdownActive = false;
// Generation counter: bumping it orphans any in-flight setTimeout chain, so
// re-opening the loadout screen mid-countdown cancels the old countdown.
let countdownGen = 0;

function cancelStartCountdown() {
  countdownGen++;
  countdownActive = false;
  startCountdownEl.style.display = 'none';
  startCountdownEl.replaceChildren();
}

function runStartCountdown(onDone: () => void) {
  const gen = ++countdownGen;
  countdownActive = true;
  startCountdownEl.style.display = 'flex';
  const steps = ['3', '2', '1', 'GO!'];
  const STEP_MS = 800;   // matches the cd-pop animation duration

  const showStep = (i: number) => {
    if (gen !== countdownGen) return;   // cancelled — a newer flow owns the screen
    if (i >= steps.length) {
      cancelStartCountdown();
      onDone();
      return;
    }
    // Fresh element per step so the cd-pop animation restarts from 0%.
    const num = document.createElement('span');
    num.className = i === steps.length - 1 ? 'cd-num cd-go' : 'cd-num';
    num.textContent = steps[i];
    startCountdownEl.replaceChildren(num);
    window.setTimeout(() => showStep(i + 1), STEP_MS);
  };
  showStep(0);
}

// ── Per-match sprite residency ─────────────────────────────────────────────
// Only the player's picked cards are preloaded — those spawn on a button press
// and must be ready. Every CPU-bought type (either side) loads on its first
// buy (Game.spriteSetPending), so resident texture memory tracks what is
// actually fielded. launchMatch evicts everything outside the new loadout once
// the new scene is up; CPU sets reload on demand.
type MatchMapDef = ReturnType<typeof loadMapWithOverride>;

function rosterKeys(tribe: Tribe, types: Iterable<string> = TRIBE_ROSTERS[tribe]): SpriteSetKey[] {
  return [...types].map(type => ({ tribe, type }));
}
function allRosterKeys(): SpriteSetKey[] {
  return (Object.keys(TRIBE_ROSTERS) as Tribe[]).flatMap(t => rosterKeys(t));
}
// Tribe default mirrors the seeding in game.reset(mapDef).
function matchSpriteKeys(mapDef?: MatchMapDef): SpriteSetKey[] {
  const playerTribe = mapDef ? (mapDef.playerTowerTribe ?? 'kattgard') : getPlayerTribe();
  return rosterKeys(playerTribe, loadout);
}
// Call once `keys` are loaded: restarts on the map, syncs the spawn bar, and
// frees the sets the new match can't use. reset() tears the old scene down
// first, so nothing still references an evicted sheet.
function launchMatch(keys: SpriteSetKey[], mapDef?: MatchMapDef) {
  restartCurrentGame(mapDef);
  syncSpawnButtonVisibility();
  refreshCostLabels();
  void unloadSpriteSetsExcept(keys);
}
// Bumped whenever the loadout screen (re)opens, so a Start that's still
// loading sheets when a tribe/map change re-opens the screen stands down.
let loadoutGen = 0;

function openLoadoutScreen(mapDef?: MatchMapDef) {
  cancelStartCountdown();   // e.g. tribe/map change while a countdown is running
  loadoutGen++;

  // Dev fast-start (gameConfig.cheats.skipIntroScreens): no selection screen,
  // no countdown — jump straight into the match with every owned card loaded.
  // The saved 7-card loadout is deliberately left untouched.
  if (CHEAT_SKIP_INTRO_SCREENS) {
    loadoutTribe = mapDef ? (mapDef.playerTowerTribe ?? 'kattgard') : getPlayerTribe();
    loadout = validLoadoutSet(getOwnedCards(loadoutTribe));
    const keys = matchSpriteKeys(mapDef);
    void ensureSpriteSets(keys).then(() => launchMatch(keys, mapDef));
    return;
  }

  pendingMapDef = mapDef ?? null;
  loadoutTribe  = mapDef ? (mapDef.playerTowerTribe ?? 'kattgard') : getPlayerTribe();
  loadout = validLoadoutSet(loadLoadout(loadoutTribe));
  buildLoadoutGrid();
  loadoutOpen = true;
  loadoutScreen.style.display = 'flex';
  if (!game.paused) game.togglePause();
  uiOverlay.style.visibility = 'hidden';
  hudEl.style.visibility     = 'hidden';
}

loadoutStartBtn.addEventListener('click', async () => {
  if (loadout.size === 0 || loadoutStartBtn.disabled) return;
  saveLoadout(loadoutTribe, [...loadout]);
  // Stream in the picked cards' sheets with the screen still up (the button
  // reads Loading… meanwhile); the match launches once they're resident.
  const gen    = loadoutGen;
  const mapDef = pendingMapDef ?? undefined;
  const keys   = matchSpriteKeys(mapDef);
  loadoutStartBtn.disabled    = true;
  loadoutStartBtn.textContent = '⏳ Loading…';
  loadoutGrid.style.pointerEvents = 'none';   // keys are fixed now — no toggling cards mid-load
  const t0 = performance.now();
  await ensureSpriteSets(keys);
  console.info(`[sprites] ${keys.length} sets ready in ${(performance.now() - t0).toFixed(0)} ms`);
  loadoutGrid.style.pointerEvents = '';
  loadoutStartBtn.textContent = '▶ Start';
  refreshLoadoutFooter();
  if (gen !== loadoutGen) return;   // screen re-opened while loading — that flow owns the start
  loadoutOpen = false;
  hideStatSheet();
  loadoutScreen.style.display = 'none';
  // Fresh match on the queued map (or a clean restart of the current one).
  // game.reset() also clears the pause we set when the screen opened, and —
  // when a map is queued — re-seeds the player tribe from the map, so button
  // visibility and cost labels sync AFTER the reset (inside launchMatch).
  launchMatch(keys, mapDef);
  pendingMapDef = null;
  // Hold the fresh match frozen behind the 3-2-1, then release it on GO.
  if (!game.paused) game.togglePause();
  uiOverlay.style.visibility = 'hidden';
  hudEl.style.visibility     = 'hidden';
  runStartCountdown(() => {
    if (game.paused) game.togglePause();
    uiOverlay.style.visibility = 'visible';
    hudEl.style.visibility     = 'visible';
  });
});

// ── Splash screen (first load) ─────────────────────────────────────────────
// The opaque splash sits under the loading screen and is revealed when it
// fades. The game waits paused behind it; Enter hands off to squad selection.
// With the skipIntroScreens cheat on, the splash is dropped and the match
// starts immediately with every owned card available.
const splashScreen = document.getElementById('splash-screen')!;
let splashOpen = false;
if (CHEAT_SKIP_INTRO_SCREENS) {
  splashScreen.remove();
  loadout = validLoadoutSet(getOwnedCards(getPlayerTribe()));
  syncSpawnButtonVisibility();
} else {
  splashOpen = true;
  if (!game.paused) game.togglePause();
  uiOverlay.style.visibility = 'hidden';
  hudEl.style.visibility     = 'hidden';

  // Enter key or a click on the on-screen key cap — both hand off to squad
  // selection. Guarded by splashOpen so a focused button's Enter (keydown +
  // synthesized click) can't dismiss twice.
  const dismissSplash = () => {
    if (!splashOpen) return;
    splashOpen = false;
    splashScreen.classList.add('fade-out');
    splashScreen.addEventListener('transitionend', () => splashScreen.remove(), { once: true });
    openLoadoutScreen();
  };
  window.addEventListener('keydown', (e) => { if (e.key === 'Enter') dismissSplash(); });
  document.getElementById('splash-enter')!.addEventListener('click', dismissSplash);
  if (isTouchDevice) {
    // No keyboard: the whole splash is the start control. Request fullscreen
    // from this same gesture — it is the one moment we are guaranteed one.
    document.getElementById('splash-prompt')!.textContent = 'Tap to start';
    splashScreen.addEventListener('click', () => { if (canFullscreen && !isStandalone) void enterFullscreen(); dismissSplash(); });
    if (isIOS && !isStandalone) document.getElementById('splash-ios-hint')!.style.display = 'block';
  }
}

// Developer bar (#dev-panel) is hidden by default; P toggles its visibility.
const devPanel = document.getElementById('dev-panel')!;

// ── Pause menu (Esc) ───────────────────────────────────────────────────────
// Esc pauses the game and shows a centered menu with Restart and Key Bindings.
const pauseMenu  = document.getElementById('pause-menu')!;
const pmMainView = document.getElementById('pm-main')!;
const pmKeysView = document.getElementById('pm-keys')!;
const pmResolutionView = document.getElementById('pm-resolution')!;
const cmdModalEl = document.getElementById('cmd-modal')!;
let pauseMenuOpen   = false;
let pauseMenuPaused = false;   // true when the menu itself initiated the pause

function showPauseMenuMain() {
  pmMainView.style.display = 'flex';
  pmKeysView.style.display = 'none';
  pmResolutionView.style.display = 'none';
}

function openPauseMenu() {
  if (pauseMenuOpen || gameOver) return;
  pauseMenuOpen = true;
  showPauseMenuMain();
  pauseMenu.style.display = 'flex';
  if (!game.paused) { game.togglePause(); pauseMenuPaused = true; }
}

function closePauseMenu() {
  if (!pauseMenuOpen) return;
  pauseMenuOpen = false;
  pauseMenu.style.display = 'none';
  if (pauseMenuPaused && game.paused) game.togglePause();   // resume only if we paused it
  pauseMenuPaused = false;
}

document.getElementById('pm-resume-btn')!.addEventListener('click', () => closePauseMenu());
document.getElementById('pm-restart-btn')!.addEventListener('click', () => {
  // reset() clears the pause flag, so just drop our menu state and restart.
  pauseMenuOpen = false;
  pauseMenuPaused = false;
  pauseMenu.style.display = 'none';
  restartCurrentGame();
});
document.getElementById('pm-keys-btn')!.addEventListener('click', () => {
  pmMainView.style.display = 'none';
  pmKeysView.style.display = 'flex';
});
document.getElementById('pm-back-btn')!.addEventListener('click', showPauseMenuMain);

// ── Resolution sub-view ────────────────────────────────────────────────────
const pmResolutionList = document.getElementById('pm-resolution-list')!;
function refreshResolutionButtons() {
  const current = getResolutionHeight();
  pmResolutionList.querySelectorAll<HTMLButtonElement>('.pm-res-btn').forEach(btn => {
    btn.classList.toggle('is-active', Number(btn.dataset.height) === current);
  });
}
for (const r of RESOLUTIONS) {
  const btn = document.createElement('button');
  btn.className = 'pm-btn pm-res-btn';
  btn.dataset.height = String(r.height);
  btn.textContent = r.label;
  btn.addEventListener('click', () => {
    setResolutionHeight(r.height);
    game.applyResolution();
    refreshResolutionButtons();
  });
  pmResolutionList.appendChild(btn);
}
document.getElementById('pm-resolution-btn')!.addEventListener('click', () => {
  pmMainView.style.display = 'none';
  pmResolutionView.style.display = 'flex';
  refreshResolutionButtons();
});
document.getElementById('pm-res-back-btn')!.addEventListener('click', showPauseMenuMain);
// Click the backdrop (outside the card) to resume.
pauseMenu.addEventListener('click', (e) => { if (e.target === pauseMenu) closePauseMenu(); });

window.addEventListener('keydown', (e) => {
  // Splash / loadout screen / start countdown own the input while up — no
  // pause toggles, dev keys, or menu opening until the match actually begins.
  if (splashOpen || loadoutOpen || countdownActive) return;
  if (e.key === 'Escape') {
    // The Z command modal manages its own Esc-to-close (handler registered later).
    if (cmdModalEl.style.display !== 'none') return;
    if (pauseMenuOpen) closePauseMenu(); else openPauseMenu();
    return;
  }
  if (e.key === 'p' || e.key === 'P') {
    devPanel.style.display = devPanel.style.display === 'none' ? 'flex' : 'none';
  }
  // Spacebar pauses. preventDefault stops the page from scrolling and stops a
  // focused spawn button from being "clicked" by the space key.
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (pauseMenuOpen) return;   // the menu owns the pause state while it's open
    game.togglePause();
    pauseOverlay.style.display  = game.paused ? 'block'   : 'none';
    uiOverlay.style.visibility  = game.paused ? 'hidden'  : 'visible';
    hudEl.style.visibility      = game.paused ? 'hidden'  : 'visible';
  }
  if (e.key === 'b' || e.key === 'B') {
    game.toggleDevMode();
  }
  if (e.key === 'm' || e.key === 'M') {
    toggleMute();
    refreshMuteUi();
  }
});

// ── Character command modal (Z key) ───────────────────────────────────────
// Translucent overlay listing every live player character with bulk + per-
// character behavior controls. While open, the game runs in slow-mo so the
// player can review and re-route units without their plans going stale.
{
  const cmdModal = document.getElementById('cmd-modal')!;
  const cmdList  = document.getElementById('cmd-list')!;
  const cmdEmpty = document.getElementById('cmd-empty')!;
  const SLOW_MO_SCALE = 0.2;   // 5× slower than normal
  const REFRESH_MS    = 150;   // re-poll HP / behavior labels at this cadence

  type Bhv = 'attacking' | 'collecting' | 'harass' | 'defend' | 'rush';
  type PlayerChar = (typeof game.playerCharacters)[number];

  // Per-button display config — order matches the cycle the HP-card button
  // already uses, so muscle memory carries over.
  const BHV_BUTTONS: ReadonlyArray<{ val: Bhv; icon: string; label: string }> = [
    { val: 'attacking',  icon: '⚔', label: 'Atk' },
    { val: 'collecting', icon: '💰', label: 'Col' },
    { val: 'harass',     icon: '↯', label: 'Har' },
    { val: 'defend',     icon: '🛡', label: 'Def' },
    { val: 'rush',       icon: '🏃', label: 'Rsh' },
  ];

  let cmdOpen   = false;
  let refreshT: number | null = null;

  // ── Per-character display helpers (mirror the old CharacterHUD card) ──
  // rankLabel / xpProgress are shared with CharacterHUD; only the dialog's rank
  // colour palette (lighter, for the dark card background) is local.
  const RANK_COLORS = ['#999', '#cd7f32', '#b0b0b0', '#ffd700'] as const;
  const hpFrac    = (char: PlayerChar) => Math.max(0, char.hp / char.maxHp);
  const hpText    = (char: PlayerChar) => `${Math.ceil(char.hp)} / ${Math.round(char.maxHp)}`;
  const rankInfo  = (char: PlayerChar) => ({ label: rankLabel(char.rank), color: RANK_COLORS[char.rank] });
  const xpInfo    = (char: PlayerChar) => xpProgress(char.currentAP, char.rank);

  const buildRow = (char: PlayerChar): HTMLElement => {
    const row = document.createElement('div');
    row.className   = 'cmd-row';
    row.dataset.id  = String(char.id);
    const { label: rankLbl, color: rankCol } = rankInfo(char);
    const xp = xpInfo(char);
    const typeLabel = char.config.displayName ?? char.config.id.charAt(0).toUpperCase() + char.config.id.slice(1);
    row.innerHTML   = `
      <span class="cmd-row-id">#${char.id}</span>
      <span class="cmd-row-name">${char.name}</span>
      <span class="cmd-row-type">${char.config.icon ?? ''} ${typeLabel}</span>
      <span class="cmd-row-rank" style="color:${rankCol}">${rankLbl}</span>
      <div class="cmd-row-bar">
        <div class="cmd-row-bar-label"><span>HP</span><span class="num">${hpText(char)}</span></div>
        <div class="cmd-row-bar-track"><div class="cmd-row-bar-fill hp" style="width:${(hpFrac(char) * 100).toFixed(1)}%"></div></div>
      </div>
      <div class="cmd-row-bar">
        <div class="cmd-row-bar-label"><span>XP</span><span class="num">${xp.text}</span></div>
        <div class="cmd-row-bar-track"><div class="cmd-row-bar-fill xp${xp.isMax ? ' is-max' : ''}" style="width:${(xp.frac * 100).toFixed(1)}%"></div></div>
      </div>
      <span class="cmd-row-bhv"></span>
    `;
    const bhvBox = row.querySelector('.cmd-row-bhv') as HTMLElement;
    for (const { val, icon, label } of BHV_BUTTONS) {
      const b = document.createElement('button');
      b.className   = 'cmd-bhv-btn';
      b.dataset.bhv = val;
      b.textContent = `${icon} ${label}`;
      if (char.behavior === val) b.classList.add('is-active');
      b.addEventListener('click', () => {
        char.behavior = val;
        refreshCmdRows();
      });
      bhvBox.appendChild(b);
    }
    return row;
  };

  const rebuildCmdRows = () => {
    cmdList.innerHTML = '';
    const chars = game.playerCharacters;
    cmdEmpty.style.display = chars.length === 0 ? '' : 'none';
    for (const char of chars) cmdList.appendChild(buildRow(char));
  };

  // In-place refresh: HP/XP bars + numbers + rank + active behavior class.
  // Falls back to a full rebuild only when the set of char ids changes
  // (death, spawn) so rows appear/disappear without flicker.
  const refreshCmdRows = () => {
    const chars      = game.playerCharacters;
    const currentIds = new Set(chars.map(c => c.id));
    const childArr   = Array.from(cmdList.children) as HTMLElement[];
    const renderedIds = new Set(childArr.map(el => Number(el.dataset.id)));
    const sameSet = currentIds.size === renderedIds.size
                  && [...currentIds].every(id => renderedIds.has(id));
    if (!sameSet) { rebuildCmdRows(); return; }
    for (const char of chars) {
      const row = cmdList.querySelector(`[data-id="${char.id}"]`);
      if (!row) continue;
      const bars = row.querySelectorAll('.cmd-row-bar');
      const hpBar = bars[0], xpBar = bars[1];
      // HP
      (hpBar.querySelector('.num') as HTMLElement).textContent = hpText(char);
      (hpBar.querySelector('.cmd-row-bar-fill') as HTMLElement).style.width = `${(hpFrac(char) * 100).toFixed(1)}%`;
      // XP + rank
      const xp = xpInfo(char);
      (xpBar.querySelector('.num') as HTMLElement).textContent = xp.text;
      const xpFill = xpBar.querySelector('.cmd-row-bar-fill') as HTMLElement;
      xpFill.style.width = `${(xp.frac * 100).toFixed(1)}%`;
      xpFill.classList.toggle('is-max', xp.isMax);
      const { label: rankLbl, color: rankCol } = rankInfo(char);
      const rankEl = row.querySelector('.cmd-row-rank') as HTMLElement;
      rankEl.textContent = rankLbl;
      rankEl.style.color = rankCol;
      // Behaviour
      row.querySelectorAll('.cmd-bhv-btn').forEach(btn => {
        const b = btn as HTMLButtonElement;
        b.classList.toggle('is-active', b.dataset.bhv === char.behavior);
      });
    }
  };

  const openCmdModal = () => {
    // Skip when game-over (no commands to issue) or paused (slow-mo + pause
    // is incoherent, and the pause overlay would visually conflict).
    if (cmdOpen || gameOver || game.paused) return;
    cmdOpen = true;
    game.setTimeScale(SLOW_MO_SCALE);
    rebuildCmdRows();
    cmdModal.style.display = 'flex';
    refreshT = window.setInterval(refreshCmdRows, REFRESH_MS);
  };

  const closeCmdModal = () => {
    if (!cmdOpen) return;
    cmdOpen = false;
    game.setTimeScale(1);
    cmdModal.style.display = 'none';
    if (refreshT !== null) { window.clearInterval(refreshT); refreshT = null; }
  };

  // Bulk-set: header buttons set the same behavior on every live player char.
  document.querySelectorAll('.cmd-bulk .cmd-bhv-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const bhv = (btn as HTMLElement).dataset.bulk as Bhv | undefined;
      if (!bhv) return;
      for (const char of game.playerCharacters) char.behavior = bhv;
      refreshCmdRows();
    });
  });

  // Click on the translucent backdrop (outside the card) closes — standard
  // modal UX. Clicks on the card itself bubble to children but not to the
  // backdrop, so they don't trigger close.
  cmdModal.addEventListener('click', (e) => {
    if (e.target === cmdModal) closeCmdModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'z' || e.key === 'Z') {
      if (cmdOpen) closeCmdModal();
      else         openCmdModal();
    } else if (e.key === 'Escape' && cmdOpen) {
      closeCmdModal();
    }
  });

  // Bottom-right Commands button — main entry point now that the HUD card
  // panel is hidden. Mirrors the Z keybind: toggles the modal open/closed.
  const cmdOpenBtn = document.getElementById('cmd-open-btn') as HTMLButtonElement | null;
  if (cmdOpenBtn) {
    cmdOpenBtn.addEventListener('click', () => {
      if (cmdOpen) closeCmdModal();
      else         openCmdModal();
    });
  }
}

// ── Mute indicator ────────────────────────────────────────────────────────
const muteIndicator = document.getElementById('mute-indicator')!;
const muteIcon      = document.getElementById('mute-icon')!;
function refreshMuteUi() {
  const m = isMuted();
  muteIcon.textContent = m ? '🔇' : '🔊';
  muteIndicator.classList.toggle('is-muted', m);
  muteIndicator.title  = m
    ? 'Sound off — press M or click to unmute'
    : 'Sound on — press M or click to mute';
}
muteIndicator.addEventListener('click', () => {
  toggleMute();
  refreshMuteUi();
});
refreshMuteUi();

// ── Performance stats ──────────────────────────────────────────────────────
{
  const fpsEl    = document.getElementById('perf-fps')!;
  const msEl     = document.getElementById('perf-ms')!;
  const memEl    = document.getElementById('perf-mem')!;
  const memRow   = document.getElementById('perf-mem-row')!;
  const texEl    = document.getElementById('perf-tex')!;
  const gpuEl    = document.getElementById('perf-gpu')!;

  const hasMem = 'memory' in performance;
  if (hasMem) { memRow.style.display = ''; }

  const frameTimes: number[] = [];
  let lastT        = performance.now();
  let flushTimer   = 0;

  game.app.ticker.add(() => {
    const now = performance.now();
    const ms  = now - lastT;
    lastT     = now;
    frameTimes.push(ms);
    if (frameTimes.length > 60) frameTimes.shift();

    flushTimer += ms;
    if (flushTimer < 500) return;
    flushTimer = 0;

    const avgMs = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    fpsEl.textContent = (1000 / avgMs).toFixed(0);
    msEl.textContent  = avgMs.toFixed(1) + ' ms';
    texEl.textContent = (spriteTextureBytes() / 1_048_576).toFixed(0) + ' MB';
    const st = spriteAtlasStats();
    texEl.title = `atlas uploads ${st.uploads} · bitmaps released ${st.releases} · rebuilds ${st.rebuilds}`;
    gpuEl.textContent = (game.gpuTextureBytes() / 1_048_576).toFixed(0) + ' MB';
    if (hasMem) {
      // performance.memory is a non-standard Chrome API
      const mem = (performance as unknown as { memory: { usedJSHeapSize: number } }).memory;
      memEl.textContent = (mem.usedJSHeapSize / 1_048_576).toFixed(1) + ' MB';
    }
  });
}

// ── Diagnose mode ──────────────────────────────────────────────────────────
const diagnoseBtn       = document.getElementById('diagnose-btn')        as HTMLButtonElement;
const diagnoseExportBtn = document.getElementById('diagnose-export-btn') as HTMLButtonElement;
const diagnoseStatusEl  = document.getElementById('diagnose-status')!;

function refreshDiagnoseUi() {
  const active = game.diagnostics.isActive();
  diagnoseBtn.classList.toggle('is-active', active);
  diagnoseBtn.textContent = active ? 'Diagnose: ON' : 'Diagnose';
  const count = game.diagnostics.entryCount();
  diagnoseExportBtn.disabled    = count === 0;
  diagnoseExportBtn.style.display = count > 0 ? '' : 'none';
  diagnoseStatusEl.style.display  = active ? '' : 'none';
  diagnoseStatusEl.textContent    = `recording — ${count} entries`;
}

diagnoseBtn.addEventListener('click', () => {
  if (game.diagnostics.isActive()) game.diagnostics.stop(game.elapsedSeconds);
  else                              game.diagnostics.start(game.elapsedSeconds);
  refreshDiagnoseUi();
});

diagnoseExportBtn.addEventListener('click', () => {
  const md   = game.diagnostics.produceMarkdown();
  const blob = new Blob([md], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href     = url;
  a.download = `diagnostic-${ts}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

setInterval(refreshDiagnoseUi, 500);
refreshDiagnoseUi();

// ── Benchmark ─────────────────────────────────────────────────────────────
// Runs the current map with CPU-vs-CPU forced ON for a fixed duration,
// captures every frame's ms, then prints p50/p95/p99 and dropped-frame
// counts in a copyable block. Use the Map dropdown beforehand to pick the
// scenario, and run 2-3 trials to median-out OS-scheduling jitter.
{
  const benchBtn    = document.getElementById('bench-btn')    as HTMLButtonElement;
  const benchResult = document.getElementById('bench-result') as HTMLPreElement;
  const BENCH_DURATION_SEC = 60;

  let benchActive   = false;
  let benchSamples: number[] = [];
  let benchStartT   = 0;
  let benchLastT    = 0;
  let benchPrevCpuVsCpu = false;
  let benchTickFn: (() => void) | null = null;

  const fmt = (n: number) => n.toFixed(2);
  const pct = (sorted: number[], p: number) => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  };

  const finishBench = () => {
    if (!benchActive || !benchTickFn) return;
    benchActive = false;
    game.app.ticker.remove(benchTickFn);
    benchTickFn = null;

    // Restore the user's prior CPU-vs-CPU setting silently.
    if (game.isCpuVsCpu() !== benchPrevCpuVsCpu) {
      game.setCpuVsCpu(benchPrevCpuVsCpu);
      refreshCpuVsCpuUi();
    }

    const samples = benchSamples;
    if (samples.length < 10) {
      benchResult.textContent = 'bench aborted (too few samples)';
      benchResult.style.display = '';
      benchBtn.disabled  = false;
      benchBtn.textContent = 'Benchmark';
      return;
    }

    const sorted = samples.slice().sort((a, b) => a - b);
    const mean   = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p50    = pct(sorted, 50);
    const p95    = pct(sorted, 95);
    const p99    = pct(sorted, 99);
    const max    = sorted[sorted.length - 1];
    const drop60 = samples.filter(ms => ms > 16.67).length;          // missed 60 FPS budget
    const drop30 = samples.filter(ms => ms > 33.33).length;          // missed 30 FPS budget
    const durS   = (performance.now() - benchStartT) / 1000;

    benchResult.textContent =
      `bench ${durS.toFixed(1)}s · ${samples.length} frames\n` +
      `mean  ${fmt(mean)}ms  (${(1000 / mean).toFixed(0)} fps)\n` +
      `p50   ${fmt(p50)}ms   (${(1000 / p50).toFixed(0)} fps)\n` +
      `p95   ${fmt(p95)}ms   (${(1000 / p95).toFixed(0)} fps)\n` +
      `p99   ${fmt(p99)}ms   (${(1000 / p99).toFixed(0)} fps)\n` +
      `max   ${fmt(max)}ms\n` +
      `>16.7ms ${drop60} (${(100 * drop60 / samples.length).toFixed(1)}%)\n` +
      `>33.3ms ${drop30} (${(100 * drop30 / samples.length).toFixed(1)}%)`;
    benchResult.style.display = '';
    benchBtn.disabled  = false;
    benchBtn.textContent = 'Benchmark';
  };

  benchBtn.addEventListener('click', () => {
    if (benchActive) return;
    benchActive  = true;
    benchSamples = [];
    benchStartT  = performance.now();
    benchLastT   = benchStartT;

    benchPrevCpuVsCpu = game.isCpuVsCpu();
    if (!benchPrevCpuVsCpu) {
      game.setCpuVsCpu(true);
      refreshCpuVsCpuUi();
    }
    // Fresh restart so every trial starts from the same scene state
    // (active characters, coin balances, timers) on the same map.
    restartCurrentGame();

    benchResult.style.display = '';
    benchResult.textContent   = `running ${BENCH_DURATION_SEC}s…`;
    benchBtn.disabled  = true;
    benchBtn.textContent = 'Benchmarking…';

    benchTickFn = () => {
      const now = performance.now();
      const ms  = now - benchLastT;
      benchLastT = now;
      // Drop the first frame (it includes the ticker-add overhead and
      // post-restart layout work — would skew p99 / max).
      if (benchSamples.length > 0 || (now - benchStartT) > 50) {
        benchSamples.push(ms);
      }
      const elapsed = (now - benchStartT) / 1000;
      benchBtn.textContent = `Benchmarking (${Math.max(0, BENCH_DURATION_SEC - elapsed).toFixed(0)}s)`;
      if (elapsed >= BENCH_DURATION_SEC) finishBench();
    };
    game.app.ticker.add(benchTickFn);
  });
}

// ── Dev panel: map selector ────────────────────────────────────────────────
{
  const mapSelect   = document.getElementById('dev-map-select')   as HTMLSelectElement;
  const loadMapBtn  = document.getElementById('dev-load-map-btn') as HTMLButtonElement;

  // Populate grouped options — World 1 / World 2 / …
  for (const world of WORLDS) {
    const group   = document.createElement('optgroup');
    group.label   = `World ${world.id} — ${world.name}`;
    for (let mi = 0; mi < world.maps.length; mi++) {
      const map = world.maps[mi];
      const opt      = document.createElement('option');
      opt.value      = map.id;
      opt.textContent = `W${world.id}M${mi + 1} — ${map.name}`;
      group.appendChild(opt);
    }
    mapSelect.appendChild(group);
  }

  // Keep the selector in sync with the current map after any reset
  function syncMapSelect() {
    const coords = mapCoords(game.currentMapId);
    if (coords) mapSelect.value = game.currentMapId;
  }
  syncMapSelect();

  loadMapBtn.addEventListener('click', () => {
    const found = ALL_MAPS.find(m => m.id === mapSelect.value);
    if (!found) return;
    // New map → pick a squad first; Start launches it.
    openLoadoutScreen(loadMapWithOverride(found));
  });
}

// ── Dev panel: tribe selector ──────────────────────────────────────────────
// Toggles the player tribe at runtime. Spawn buttons not in the active
// tribe's roster are hidden; new player units pick up the new tribe's
// sprites automatically (existing units keep theirs — sprite is bound at
// construction).
{
  const tribeSelect = document.getElementById('dev-tribe-select') as HTMLSelectElement;

  // Populate options from the TRIBES registry — order is insertion order
  for (const tribe of Object.values(TRIBES)) {
    const opt = document.createElement('option');
    opt.value       = tribe.id;
    opt.textContent = tribe.displayName;
    tribeSelect.appendChild(opt);
  }
  tribeSelect.value = getPlayerTribe();
  syncSpawnButtonVisibility();

  // Switching tribes changes the card roster, so the player re-picks their
  // loadout; Start then launches a fresh match (mixing tribes mid-match would
  // leave old-tribe units on the field).
  tribeSelect.addEventListener('change', () => {
    setPlayerTribe(tribeSelect.value as Tribe);
    refreshCostLabels();
    openLoadoutScreen();
  });
}

// ── CPU vs CPU dev toggle ──────────────────────────────────────────────────
const cpuVsCpuBtn = document.getElementById('cpu-vs-cpu-btn') as HTMLButtonElement;

function refreshCpuVsCpuUi() {
  const on = game.isCpuVsCpu();
  cpuVsCpuBtn.classList.toggle('is-active', on);
  cpuVsCpuBtn.textContent = on ? 'CPU vs CPU: ON' : 'CPU vs CPU';
}

cpuVsCpuBtn.addEventListener('click', () => {
  game.setCpuVsCpu(!game.isCpuVsCpu());
  refreshCpuVsCpuUi();
});
refreshCpuVsCpuUi();

// ── Game Shark: force power-up drop ───────────────────────────────────────
const powerUpSelect  = document.getElementById('dev-powerup-select')   as HTMLSelectElement;
const dropPowerUpBtn = document.getElementById('dev-drop-powerup-btn') as HTMLButtonElement;

dropPowerUpBtn.addEventListener('click', () => {
  game.forceDropPowerUp(powerUpSelect.value as PowerUpType);
});

// ── Game Shark: flat tower damage ─────────────────────────────────────────
document.getElementById('dev-dmg-player-tower-btn')!.addEventListener('click', () => {
  game.cheatDamageTower('player', CHEAT_TOWER_DAMAGE);
});
document.getElementById('dev-dmg-cpu-tower-btn')!.addEventListener('click', () => {
  game.cheatDamageTower('enemy', CHEAT_TOWER_DAMAGE);
});

// ── Game Shark: skip the match clock ──────────────────────────────────────
document.getElementById('dev-skip-clock-btn')!.addEventListener('click', () => {
  game.cheatSkipClock(CHEAT_CLOCK_SKIP_SEC);
});

// ── Game Shark: force the CPU to buy a specific unit type ─────────────────
const cpuForceSelect = document.getElementById('dev-cpu-force-select') as HTMLSelectElement;
{
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = 'AI (auto)';
  cpuForceSelect.appendChild(autoOpt);
  // Full cross-tribe list — the dev override may force any known type
  // (charConfig falls back tribe → common → other tribe).
  for (const t of ALL_CHAR_TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = `${charIcon(getPlayerTribe(), t)} ${charDisplayName(getPlayerTribe(), t)}`.trim();
    cpuForceSelect.appendChild(opt);
  }
  cpuForceSelect.addEventListener('change', () => {
    game.setCpuForcedType(cpuForceSelect.value ? (cpuForceSelect.value as CharTypeName) : null);
  });
}

function handleCpuCoinsChanged(coins: number) {
  cpuCoinAmountEl.textContent = String(coins);
}


// Top-center HUD tower bar: the fill's scaleX retreats from the centre clock as
// HP drops (transform-origin set in CSS keeps the clock-adjacent edge stable),
// and the label shows the raw HP.
function setTowerBar(fillEl: HTMLElement, labelEl: HTMLElement, hp: number, maxHp: number) {
  labelEl.textContent = String(hp);
  fillEl.style.transform = `scaleX(${Math.max(0, hp / maxHp)})`;
}

function handleEnemyTowerHpChanged(hp: number, maxHp: number) {
  setTowerBar(enemyHpFillEl, enemyHpLabelEl, hp, maxHp);
  // Dev panel value (color-coded by severity).
  const ratio = Math.max(0, hp / maxHp);
  enemyTowerHpEl.textContent = `${hp} / ${maxHp}`;
  enemyTowerHpEl.style.color = ratio < 0.28 ? '#e63946' : ratio < 0.6 ? '#f4a261' : '#e0e0e0';
}

function handlePlayerTowerHpChanged(hp: number, maxHp: number) {
  setTowerBar(playerHpFillEl, playerHpLabelEl, hp, maxHp);
}

function handleCpuCharsChanged(chars: { id: number; name: string; type: string; behavior: string }[]) {
  if (chars.length === 0) {
    cpuCharsListEl.textContent = '—';
    return;
  }
  cpuCharsListEl.innerHTML = chars
    .map(c => {
      const label = c.behavior === 'collecting' ? 'Collect' : c.behavior === 'harass' ? 'Harass' : 'Attack';
      return `<span class="dev-char-badge">${c.name}${charIcon(getPlayerTribe(), c.type)} ${label}</span>`;
    })
    .join('');
}

const cpuStanceEl    = document.getElementById('cpu-stance')!;
const cpuScoreEl     = document.getElementById('cpu-score')!;
const cpuBreakdownEl = document.getElementById('cpu-breakdown')!;
const cpuDecisionEl  = document.getElementById('cpu-decision')!;

function signed(n: number, decimals = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(decimals);
}
function scoreColor(n: number): string {
  return n > 0.1 ? '#43aa8b' : n < -0.1 ? '#e63946' : '#888';
}

function handleCpuStrategyChanged(info: CpuStrategyInfo) {
  const stanceColor =
    info.stance === 'push'    ? '#f4a261' :
    info.stance === 'defend'  ? '#e63946' : '#43aa8b';
  cpuStanceEl.textContent  = info.stance.toUpperCase();
  cpuStanceEl.style.color  = stanceColor;

  cpuScoreEl.textContent   = signed(info.score, 2);
  cpuScoreEl.style.color   = scoreColor(info.score);

  cpuBreakdownEl.innerHTML =
    `<span style="color:${scoreColor(info.unitAdv)}">U:${signed(info.unitAdv, 1)}</span> ` +
    `<span style="color:${scoreColor(info.towerAdv)}">T:${signed(info.towerAdv, 2)}</span> ` +
    `<span style="color:${scoreColor(info.coinAdv)}">C:${signed(info.coinAdv, 2)}</span>`;

  cpuDecisionEl.textContent = info.decision;
}

function handleCoinsChanged(coins: number) {
  lastKnownCoins = coins;
  coinAmountEl.textContent = String(coins);

  // Disable spawn buttons when game is over OR when there aren't enough coins
  const playerTribe = getPlayerTribe();
  for (const [t, btn] of spawnBtns) {
    const next = gameOver || coins < charCost(playerTribe, t);
    if (lastDisabledByBtn.get(btn) === next) continue;
    btn.disabled = next;
    lastDisabledByBtn.set(btn, next);
  }
}

function handleTimeChanged(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  countdownEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
  if (seconds < 20) {
    topHudEl.classList.add('countdown-urgent');
  } else {
    topHudEl.classList.remove('countdown-urgent');
  }
}

function handleGameOver(winner: 'player' | 'enemy', reason: 'tower' | 'timeout') {
  gameOver = true;
  topHudEl.classList.remove('countdown-urgent');
  // Trigger button-state update through the coins handler
  handleCoinsChanged(parseInt(coinAmountEl.textContent ?? '0'));

  // Match statistics
  const stats = game.stats;
  document.getElementById('go-stat-kills')!.textContent   = String(stats.playerKills);
  document.getElementById('go-stat-spawned')!.textContent = String(stats.playerSpawns);
  document.getElementById('go-stat-deaths')!.textContent  = String(stats.playerDeaths);
  document.getElementById('go-stat-most')!.textContent    = stats.mostSpawnedType
    ? `${charIcon(getPlayerTribe(), stats.mostSpawnedType)} ${charDisplayName(getPlayerTribe(), stats.mostSpawnedType)} ×${stats.mostSpawnedCount}`
    : '—';

  if (winner === 'player') {
    goTitle.textContent = '🏆 Victory!';
    goTitle.style.color = '#00b4d8';
    goSub.textContent   = reason === 'timeout'
      ? 'Time\'s up — your tower stood stronger!'
      : 'You destroyed the enemy tower!';
  } else {
    goTitle.textContent = '💀 Defeat!';
    goTitle.style.color = '#e63946';
    goSub.textContent   = reason === 'timeout'
      ? 'Time\'s up — the enemy tower held out!'
      : 'Your tower has fallen…';
  }
  gameOverEl.style.display = 'block';
}
