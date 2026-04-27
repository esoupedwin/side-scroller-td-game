import type { Character } from './Character';
import { RANK_NAMES } from './Character';

const TYPE_ICON: Record<string, string> = {
  warrior:  '⚔',
  archer:   '🏹',
  rifleman: '🔫',
  sniper:   '🎯',
  medic:    '➕',
  heavy:    '🔨',
};

const TYPE_COLOR: Record<string, string> = {
  warrior:  '#00b4d8',
  archer:   '#43aa8b',
  rifleman: '#7a8c42',
  sniper:   '#e07b39',
  medic:    '#9b5de5',
  heavy:    '#8899bb',
};

interface CardEntry {
  char:       Character;
  root:       HTMLElement;
  hpBar:      HTMLElement;
  hpNum:      HTMLElement;
  behaviorEl: HTMLElement;
  rankEl:     HTMLElement;
}

export class CharacterHUD {
  private container: HTMLElement;
  private cards:     CardEntry[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
  }

  add(char: Character) {
    const id    = char.id;
    const type  = char.config.type;
    const color = TYPE_COLOR[type] ?? '#ffffff';
    const icon  = TYPE_ICON[type]  ?? '?';

    // ── Root card ───────────────────────────────────────────────────────────────
    const card = document.createElement('div');
    card.className = 'char-card';
    card.setAttribute('data-char-id', String(id));
    card.style.setProperty('--card-color', color);

    // ── Header: icon + serial ───────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'char-card-header';

    const iconEl = document.createElement('span');
    iconEl.className   = 'char-card-icon';
    iconEl.textContent = icon;

    const idEl = document.createElement('span');
    idEl.className   = 'char-card-id';
    idEl.textContent = char.name;

    header.append(iconEl, idEl);

    // ── Type label ──────────────────────────────────────────────────────────────
    const label = document.createElement('div');
    label.className   = 'char-card-label';
    label.textContent = type.charAt(0).toUpperCase() + type.slice(1);

    // ── HP bar ──────────────────────────────────────────────────────────────────
    const hpTrack = document.createElement('div');
    hpTrack.className = 'char-card-hp-track';
    const hpBar = document.createElement('div');
    hpBar.className   = 'char-card-hp-bar';
    hpBar.style.width = '100%';
    hpTrack.appendChild(hpBar);

    const hpNum = document.createElement('div');
    hpNum.className   = 'char-card-hp-num';
    hpNum.textContent = String(Math.ceil(char.hp));

    // ── Rank badge ──────────────────────────────────────────────────────────────
    const rankEl = document.createElement('div');
    rankEl.className = 'char-card-rank';
    this.syncRankEl(rankEl, char.rank);

    // ── Behavior toggle button ──────────────────────────────────────────────────
    const behaviorBtn = document.createElement('button');
    behaviorBtn.className   = 'char-card-behavior';
    this.syncBehaviorEl(behaviorBtn, char.behavior);

    behaviorBtn.addEventListener('click', (e) => {
      e.stopPropagation();  // don't bubble to card
      if (char.isDead) return;
      char.behavior =
        char.behavior === 'attacking'  ? 'collecting' :
        char.behavior === 'collecting' ? 'harass'     :
        char.behavior === 'harass'     ? 'defend'     : 'attacking';
      this.syncBehaviorEl(behaviorBtn, char.behavior);
    });

    card.append(header, label, rankEl, hpTrack, hpNum, behaviorBtn);
    this.container.appendChild(card);

    this.cards.push({ char, root: card, hpBar, hpNum, behaviorEl: behaviorBtn, rankEl });
  }

  private syncRankEl(el: HTMLElement, rank: 0 | 1 | 2 | 3) {
    const RANK_COLORS = ['#444', '#cd7f32', '#b0b0b0', '#ffd700'];
    el.textContent = rank === 0 ? 'Private' : '◆'.repeat(rank) + ' ' + RANK_NAMES[rank];
    el.style.color = RANK_COLORS[rank];
  }

  private syncBehaviorEl(el: HTMLElement, behavior: 'attacking' | 'collecting' | 'harass' | 'defend') {
    el.classList.remove('char-card-behavior-collect', 'char-card-behavior-harass', 'char-card-behavior-defend');
    if (behavior === 'collecting') {
      el.textContent = '💰 Collect';
      el.classList.add('char-card-behavior-collect');
    } else if (behavior === 'harass') {
      el.textContent = '🎯 Harass';
      el.classList.add('char-card-behavior-harass');
    } else if (behavior === 'defend') {
      el.textContent = '🛡 Defend';
      el.classList.add('char-card-behavior-defend');
    } else {
      el.textContent = '⚔ Attack';
    }
  }

  update() {
    this.cards = this.cards.filter(entry => {
      if (entry.char.isDead) {
        entry.root.classList.add('char-card-dying');
        entry.root.addEventListener('animationend', () => entry.root.remove(), { once: true });
        return false;
      }

      const ratio = Math.max(0, entry.char.hp / entry.char.maxHp);
      entry.hpBar.style.width = `${ratio * 100}%`;
      entry.hpNum.textContent = String(Math.ceil(entry.char.hp));

      this.syncRankEl(entry.rankEl, entry.char.rank);
      // Keep behavior label in sync (e.g. if it was reset programmatically)
      this.syncBehaviorEl(entry.behaviorEl, entry.char.behavior);
      return true;
    });
  }

  clear() {
    for (const entry of this.cards) entry.root.remove();
    this.cards   = [];
  }
}
