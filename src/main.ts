import { Game, type CpuStrategyInfo } from './Game';
import { CHAR_COST } from './constants';

const container        = document.getElementById('game-container')!;
const hudEl            = document.getElementById('char-hud')!;
const coinAmountEl     = document.getElementById('coin-amount')!;
const cpuCoinAmountEl  = document.getElementById('cpu-coin-amount')!;
const cpuCharsListEl   = document.getElementById('cpu-chars-list')!;
const enemyTowerHpEl   = document.getElementById('enemy-tower-hp')!;
const spawnWarriorBtn  = document.getElementById('spawn-warrior-btn')  as HTMLButtonElement;
const spawnArcherBtn   = document.getElementById('spawn-archer-btn')   as HTMLButtonElement;
const spawnRiflemanBtn = document.getElementById('spawn-rifleman-btn') as HTMLButtonElement;
const spawnSniperBtn   = document.getElementById('spawn-sniper-btn')   as HTMLButtonElement;
const spawnMedicBtn    = document.getElementById('spawn-medic-btn')    as HTMLButtonElement;
const spawnHeavyBtn    = document.getElementById('spawn-heavy-btn')    as HTMLButtonElement;
const spawnTankerBtn      = document.getElementById('spawn-tanker-btn')      as HTMLButtonElement;
const spawnGrenadierBtn   = document.getElementById('spawn-grenadier-btn')   as HTMLButtonElement;
const spawnRocketeerBtn   = document.getElementById('spawn-rocketeer-btn')   as HTMLButtonElement;

// Populate costs from config so the HTML never goes stale
(document.getElementById('warrior-cost')  as HTMLElement).textContent = `${CHAR_COST.warrior}  💰`;
(document.getElementById('archer-cost')   as HTMLElement).textContent = `${CHAR_COST.archer}   💰`;
(document.getElementById('rifleman-cost') as HTMLElement).textContent = `${CHAR_COST.rifleman} 💰`;
(document.getElementById('sniper-cost')   as HTMLElement).textContent = `${CHAR_COST.sniper}   💰`;
(document.getElementById('medic-cost')    as HTMLElement).textContent = `${CHAR_COST.medic}    💰`;
(document.getElementById('heavy-cost')    as HTMLElement).textContent = `${CHAR_COST.heavy}    💰`;
(document.getElementById('tanker-cost')     as HTMLElement).textContent = `${CHAR_COST.tanker}    💰`;
(document.getElementById('grenadier-cost') as HTMLElement).textContent = `${CHAR_COST.grenadier} 💰`;
(document.getElementById('rocketeer-cost') as HTMLElement).textContent = `${CHAR_COST.rocketeer} 💰`;
const countdownEl    = document.getElementById('countdown')!;
const gameOverEl     = document.getElementById('game-over')!;
const goTitle        = document.getElementById('game-over-title')!;
const goSub          = document.getElementById('game-over-sub')!;
const restartBtn     = document.getElementById('restart-btn')!;

const canvas = document.createElement('canvas');
container.insertBefore(canvas, container.firstChild);

let gameOver = false;

let game = new Game(canvas, hudEl, handleGameOver, handleCoinsChanged, handleCpuCoinsChanged, handleCpuCharsChanged, handleCpuStrategyChanged, handleTimeChanged, handleEnemyTowerHpChanged);

spawnWarriorBtn.addEventListener ('click', () => game.spawnPlayer('warrior'));
spawnArcherBtn.addEventListener  ('click', () => game.spawnPlayer('archer'));
spawnRiflemanBtn.addEventListener('click', () => game.spawnPlayer('rifleman'));
spawnSniperBtn.addEventListener  ('click', () => game.spawnPlayer('sniper'));
spawnMedicBtn.addEventListener   ('click', () => game.spawnPlayer('medic'));
spawnHeavyBtn.addEventListener   ('click', () => game.spawnPlayer('heavy'));
spawnTankerBtn.addEventListener     ('click', () => game.spawnPlayer('tanker'));
spawnGrenadierBtn.addEventListener  ('click', () => game.spawnPlayer('grenadier'));
spawnRocketeerBtn.addEventListener  ('click', () => game.spawnPlayer('rocketeer'));

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

function handleCpuCoinsChanged(coins: number) {
  cpuCoinAmountEl.textContent = String(coins);
}

const TYPE_ICON: Record<string, string> = {
  warrior:   '⚔',
  archer:    '🏹',
  rifleman:  '🔫',
  sniper:    '🎯',
  medic:     '➕',
  heavy:     '🔨',
  tanker:    '🪖',
  grenadier: '💣',
  rocketeer: '🚀',
};

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
  spawnWarriorBtn.disabled  = gameOver || coins < CHAR_COST.warrior;
  spawnArcherBtn.disabled   = gameOver || coins < CHAR_COST.archer;
  spawnRiflemanBtn.disabled = gameOver || coins < CHAR_COST.rifleman;
  spawnSniperBtn.disabled   = gameOver || coins < CHAR_COST.sniper;
  spawnMedicBtn.disabled    = gameOver || coins < CHAR_COST.medic;
  spawnHeavyBtn.disabled    = gameOver || coins < CHAR_COST.heavy;
  spawnTankerBtn.disabled      = gameOver || coins < CHAR_COST.tanker;
  spawnGrenadierBtn.disabled   = gameOver || coins < CHAR_COST.grenadier;
  spawnRocketeerBtn.disabled   = gameOver || coins < CHAR_COST.rocketeer;
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
