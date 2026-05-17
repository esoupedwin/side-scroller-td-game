import { Game, type CpuStrategyInfo } from './Game';
import { CHAR_COST } from './constants';
import { TYPE_ICON } from './CharacterHUD';
import { preloadAllSprites } from './SpriteRegistry';

await preloadAllSprites();

const container       = document.getElementById('game-container')!;
const hudEl           = document.getElementById('char-hud')!;
const coinAmountEl    = document.getElementById('coin-amount')!;
const cpuCoinAmountEl = document.getElementById('cpu-coin-amount')!;
const cpuCharsListEl  = document.getElementById('cpu-chars-list')!;
const enemyTowerHpEl  = document.getElementById('enemy-tower-hp')!;

// All spawnable unit types, in display order
const UNIT_TYPES = [
  'conscript', 'warrior', 'archer', 'rifleman', 'sniper', 'medic',
  'heavy', 'tanker', 'grenadier', 'rocketeer',
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

const canvas = document.createElement('canvas');
container.insertBefore(canvas, container.firstChild);

let gameOver = false;

let game = new Game(canvas, hudEl, handleGameOver, handleCoinsChanged, handleCpuCoinsChanged, handleCpuCharsChanged, handleCpuStrategyChanged, handleTimeChanged, handleEnemyTowerHpChanged);

for (const t of UNIT_TYPES) {
  spawnBtns.get(t)!.addEventListener('click', () => game.spawnPlayer(t));
}

restartBtn.addEventListener('click', () => {
  gameOver = false;
  gameOverEl.style.display = 'none';
  game.reset();  // reset() calls onCoinsChanged which re-evaluates button states
});

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
