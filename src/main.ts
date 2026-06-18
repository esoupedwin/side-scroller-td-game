import { Game, type CpuStrategyInfo } from './Game';
import type { PowerUpType } from './PowerUp';
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
  'viking', 'shocktrooper', 'knight', 'heavy', 'grenadier', 'rocketeer',
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

// Cache the last-applied `.disabled` per button so the per-balance update
// only writes when the threshold is actually crossed. Must be declared BEFORE
// `new Game(...)` because the Game constructor synchronously fires
// handleCoinsChanged via notifyCoins() — TDZ otherwise.
const lastDisabledByBtn = new Map<HTMLButtonElement, boolean>();

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

  const hpLabel = (char: PlayerChar) => `${Math.ceil(char.hp)}/${Math.round(char.maxHp)}`;

  const buildRow = (char: PlayerChar): HTMLElement => {
    const row = document.createElement('div');
    row.className   = 'cmd-row';
    row.dataset.id  = String(char.id);
    row.innerHTML   = `
      <span class="cmd-row-id">#${char.id}</span>
      <span class="cmd-row-name">${char.name}</span>
      <span class="cmd-row-type">${TYPE_ICON[char.config.type] ?? ''} ${char.config.type}</span>
      <span class="cmd-row-hp">${hpLabel(char)}</span>
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

  // In-place refresh: HP text + active-button class only. Falls back to a
  // full rebuild when the set of char ids changes (death, spawn) so rows
  // appear/disappear without flicker.
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
      (row.querySelector('.cmd-row-hp') as HTMLElement).textContent = hpLabel(char);
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

// ── Game Shark: force power-up drop ───────────────────────────────────────
const powerUpSelect  = document.getElementById('dev-powerup-select')   as HTMLSelectElement;
const dropPowerUpBtn = document.getElementById('dev-drop-powerup-btn') as HTMLButtonElement;

dropPowerUpBtn.addEventListener('click', () => {
  game.forceDropPowerUp(powerUpSelect.value as PowerUpType);
});

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
    const next = gameOver || coins < CHAR_COST[t];
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
