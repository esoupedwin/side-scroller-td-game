import { Game, type CpuStrategyInfo } from './Game';
import { CHAR_COST } from './constants';

const container        = document.getElementById('game-container')!;
const hudEl            = document.getElementById('char-hud')!;
const coinAmountEl     = document.getElementById('coin-amount')!;
const cpuCoinAmountEl  = document.getElementById('cpu-coin-amount')!;
const cpuCharsListEl   = document.getElementById('cpu-chars-list')!;
const spawnWarriorBtn  = document.getElementById('spawn-warrior-btn')  as HTMLButtonElement;
const spawnArcherBtn   = document.getElementById('spawn-archer-btn')   as HTMLButtonElement;
const spawnRiflemanBtn = document.getElementById('spawn-rifleman-btn') as HTMLButtonElement;
const spawnSniperBtn   = document.getElementById('spawn-sniper-btn')   as HTMLButtonElement;
const spawnMedicBtn    = document.getElementById('spawn-medic-btn')    as HTMLButtonElement;
const spawnHeavyBtn    = document.getElementById('spawn-heavy-btn')    as HTMLButtonElement;
const spawnTankerBtn   = document.getElementById('spawn-tanker-btn')   as HTMLButtonElement;

// Populate costs from config so the HTML never goes stale
(document.getElementById('warrior-cost')  as HTMLElement).textContent = `${CHAR_COST.warrior}  💰`;
(document.getElementById('archer-cost')   as HTMLElement).textContent = `${CHAR_COST.archer}   💰`;
(document.getElementById('rifleman-cost') as HTMLElement).textContent = `${CHAR_COST.rifleman} 💰`;
(document.getElementById('sniper-cost')   as HTMLElement).textContent = `${CHAR_COST.sniper}   💰`;
(document.getElementById('medic-cost')    as HTMLElement).textContent = `${CHAR_COST.medic}    💰`;
(document.getElementById('heavy-cost')    as HTMLElement).textContent = `${CHAR_COST.heavy}    💰`;
(document.getElementById('tanker-cost')   as HTMLElement).textContent = `${CHAR_COST.tanker}  💰`;
const countdownEl    = document.getElementById('countdown')!;
const gameOverEl     = document.getElementById('game-over')!;
const goTitle        = document.getElementById('game-over-title')!;
const goSub          = document.getElementById('game-over-sub')!;
const restartBtn     = document.getElementById('restart-btn')!;

const canvas = document.createElement('canvas');
container.insertBefore(canvas, container.firstChild);

let gameOver = false;

let game = new Game(canvas, hudEl, handleGameOver, handleCoinsChanged, handleCpuCoinsChanged, handleCpuCharsChanged, handleCpuStrategyChanged, handleTimeChanged);

spawnWarriorBtn.addEventListener ('click', () => game.spawnPlayer('warrior'));
spawnArcherBtn.addEventListener  ('click', () => game.spawnPlayer('archer'));
spawnRiflemanBtn.addEventListener('click', () => game.spawnPlayer('rifleman'));
spawnSniperBtn.addEventListener  ('click', () => game.spawnPlayer('sniper'));
spawnMedicBtn.addEventListener   ('click', () => game.spawnPlayer('medic'));
spawnHeavyBtn.addEventListener   ('click', () => game.spawnPlayer('heavy'));
spawnTankerBtn.addEventListener  ('click', () => game.spawnPlayer('tanker'));

restartBtn.addEventListener('click', () => {
  gameOver = false;
  gameOverEl.style.display = 'none';
  game.reset();  // reset() calls onCoinsChanged which re-evaluates button states
});

function handleCpuCoinsChanged(coins: number) {
  cpuCoinAmountEl.textContent = String(coins);
}

const TYPE_ICON: Record<string, string> = {
  warrior:  '⚔',
  archer:   '🏹',
  rifleman: '🔫',
  sniper:   '🎯',
  medic:    '➕',
  heavy:    '🔨',
  tanker:   '🪖',
};

function handleCpuCharsChanged(chars: { id: number; type: string; behavior: string }[]) {
  if (chars.length === 0) {
    cpuCharsListEl.textContent = '—';
    return;
  }
  cpuCharsListEl.innerHTML = chars
    .map(c => {
      const label = c.behavior === 'collecting' ? 'Collect' : c.behavior === 'harass' ? 'Harass' : 'Attack';
      return `<span class="dev-char-badge">#${c.id}${TYPE_ICON[c.type] ?? ''} ${label}</span>`;
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
  spawnTankerBtn.disabled   = gameOver || coins < CHAR_COST.tanker;
}

function handleTimeChanged(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  countdownEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
  if (seconds <= 30) {
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
