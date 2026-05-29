import { Game, type CpuStrategyInfo } from './Game';
import { CHAR_COST } from './constants';
import { TYPE_ICON } from './CharacterHUD';
import { preloadAllSprites } from './SpriteRegistry';
import { initAudio, toggleMute, isMuted } from './AudioManager';
import { WORLDS, ALL_MAPS, loadMapWithOverride, mapCoords } from './maps';
import { TRIBES, TRIBE_ROSTERS, type Tribe, getPlayerTribe, setPlayerTribe } from './Tribes';
import { loadTemplates as loadTribeTowerTemplates } from './TribeTowerTemplates';

const loadingScreen = document.getElementById('loading-screen')!;

loadTribeTowerTemplates(); // sync localStorage read — must run before `new Game()` so Tower can read skins
await preloadAllSprites();
initAudio(); // fire-and-forget — loads in background, never delays game start

// Fade out and remove the loading screen once sprites are ready
loadingScreen.classList.add('fade-out');
loadingScreen.addEventListener('transitionend', () => loadingScreen.remove(), { once: true });

const container       = document.getElementById('game-container')!;
const hudEl           = document.getElementById('char-hud')!;
const uiOverlay       = document.getElementById('ui-overlay')!;
const coinAmountEl    = document.getElementById('coin-amount')!;
const cpuCoinAmountEl = document.getElementById('cpu-coin-amount')!;
const cpuCharsListEl  = document.getElementById('cpu-chars-list')!;
const enemyTowerHpEl  = document.getElementById('enemy-tower-hp')!;

// Every unit type the player UI has a button for (display order). The active
// tribe's TRIBE_ROSTERS entry determines which of these are *visible* — the
// rest are hidden via syncSpawnButtonVisibility(). Tanker is omitted entirely
// (CPU-only) and Heavy is present in the HTML but not in either tribe's
// roster, so it stays hidden until a tribe lists it.
const UNIT_TYPES = [
  'conscript', 'warrior', 'archer', 'rifleman', 'sniper',
  'viking', 'knight', 'heavy', 'grenadier', 'rocketeer',
] as const;
type UnitType = typeof UNIT_TYPES[number];

// One spawn button per unit type — keyed by type string for easy lookup
const spawnBtns = new Map<UnitType, HTMLButtonElement>(
  UNIT_TYPES.map(t => [t, document.getElementById(`spawn-${t}-btn`) as HTMLButtonElement]),
);

// Populate costs from config so the HTML never goes stale
for (const t of UNIT_TYPES) {
  (document.getElementById(`${t}-cost`) as HTMLElement).textContent = `${CHAR_COST[t]} 💰`;
}
const countdownEl    = document.getElementById('countdown')!;
const gameOverEl     = document.getElementById('game-over')!;
const goTitle        = document.getElementById('game-over-title')!;
const goSub          = document.getElementById('game-over-sub')!;
const restartBtn     = document.getElementById('restart-btn')!;

const pauseOverlay = document.getElementById('pause-overlay')!;
const canvas = document.createElement('canvas');
container.insertBefore(canvas, container.firstChild);

let gameOver = false;

let game = new Game(canvas, hudEl, handleGameOver, handleCoinsChanged, handleCpuCoinsChanged, handleCpuCharsChanged, handleCpuStrategyChanged, handleTimeChanged, handleEnemyTowerHpChanged);

for (const t of UNIT_TYPES) {
  spawnBtns.get(t)!.addEventListener('click', () => game.spawnPlayer(t));
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

window.addEventListener('keydown', (e) => {
  if (e.key === 'p' || e.key === 'P') {
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
  const memLabel = document.getElementById('perf-mem-label')!;

  const hasMem = 'memory' in performance;
  if (hasMem) { memEl.style.display = ''; memLabel.style.display = ''; }

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
  diagnoseExportBtn.disabled = count === 0;
  diagnoseStatusEl.textContent = active
    ? `recording — ${count} entries`
    : count > 0 ? `${count} entries ready` : 'idle';
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
    restartCurrentGame(loadMapWithOverride(found));
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

  function syncSpawnButtonVisibility() {
    const roster = TRIBE_ROSTERS[getPlayerTribe()];
    for (const t of UNIT_TYPES) {
      const btn = spawnBtns.get(t);
      if (!btn) continue;
      btn.style.display = roster.includes(t) ? '' : 'none';
    }
  }
  syncSpawnButtonVisibility();

  // Switching tribes mid-game would leave a mix of old-tribe units still
  // alive on the field; force a fresh match so the new tribe's roster takes
  // over cleanly.
  tribeSelect.addEventListener('change', () => {
    setPlayerTribe(tribeSelect.value as Tribe);
    syncSpawnButtonVisibility();
    restartCurrentGame();
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

function handleCpuCoinsChanged(coins: number) {
  cpuCoinAmountEl.textContent = String(coins);
}


function handleEnemyTowerHpChanged(hp: number, maxHp: number) {
  enemyTowerHpEl.textContent = `${hp} / ${maxHp}`;
  const ratio = Math.max(0, hp / maxHp);
  enemyTowerHpEl.style.color = ratio < 0.28 ? '#e63946' : ratio < 0.6 ? '#f4a261' : '#e0e0e0';
}

function handleCpuCharsChanged(chars: { id: number; name: string; type: string; behavior: string }[]) {
  if (chars.length === 0) {
    cpuCharsListEl.textContent = '—';
    return;
  }
  cpuCharsListEl.innerHTML = chars
    .map(c => {
      const label = c.behavior === 'collecting' ? 'Collect' : c.behavior === 'harass' ? 'Harass' : 'Attack';
      return `<span class="dev-char-badge">${c.name}${TYPE_ICON[c.type] ?? ''} ${label}</span>`;
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
  coinAmountEl.textContent = String(coins);

  // Disable spawn buttons when game is over OR when there aren't enough coins
  for (const [t, btn] of spawnBtns) {
    btn.disabled = gameOver || coins < CHAR_COST[t];
  }
}

function handleTimeChanged(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  countdownEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
  if (seconds < 20) {
    countdownEl.classList.add('countdown-urgent');
  } else {
    countdownEl.classList.remove('countdown-urgent');
  }
}

function handleGameOver(winner: 'player' | 'enemy', reason: 'tower' | 'timeout') {
  gameOver = true;
  countdownEl.classList.remove('countdown-urgent');
  // Trigger button-state update through the coins handler
  handleCoinsChanged(parseInt(coinAmountEl.textContent ?? '0'));

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
