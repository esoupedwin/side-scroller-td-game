import type { Character } from './Character';
import { RANK_NAMES } from './Character';
import { PROMO_THRESHOLDS } from './constants';

export const TYPE_ICON: Record<string, string> = {
  conscript: '👊',
  warrior:   '⚔',
  archer:    '🏹',
  rifleman:  '🔫',
  sniper:    '🎯',
  heavy:     '🔨',
  tanker:    '🪖',
  grenadier: '💣',
  rocketeer: '🚀',
};

const TYPE_COLOR: Record<string, string> = {
  conscript: '#b07040',
  warrior:   '#00b4d8',
  archer:    '#43aa8b',
  rifleman:  '#7a8c42',
  sniper:    '#e07b39',
  heavy:     '#8899bb',
  tanker:    '#8b4513',
  grenadier: '#6b7a2a',
  rocketeer: '#cc4400',
};

interface CardEntry {
  char:       Character;
  root:       HTMLElement;
  hpBar:      HTMLElement;
  hpNum:      HTMLElement;
  xpBar:      HTMLElement;
  xpNum:      HTMLElement;
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

    // ── XP bar (progress toward next promotion) ─────────────────────────────────
    const xpTrack = document.createElement('div');
    xpTrack.className = 'char-card-xp-track';
    const xpBar = document.createElement('div');
    xpBar.className   = 'char-card-xp-bar';
    xpTrack.appendChild(xpBar);

    const xpNum = document.createElement('div');
    xpNum.className = 'char-card-xp-num';

    // ── Rank badge ──────────────────────────────────────────────────────────────
    const rankEl = document.createElement('div');
    rankEl.className = 'char-card-rank';
    this.syncRankEl(rankEl, char.rank);
    this.syncXpEl(xpBar, xpNum, char.currentAP, char.rank);

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
        char.behavior === 'harass'     ? 'defend'     :
        char.behavior === 'defend'     ? 'rush'       : 'attacking';
      this.syncBehaviorEl(behaviorBtn, char.behavior);
    });

    card.append(header, label, rankEl, hpTrack, hpNum, xpTrack, xpNum, behaviorBtn);
    this.container.appendChild(card);

    this.cards.push({ char, root: card, hpBar, hpNum, xpBar, xpNum, behaviorEl: behaviorBtn, rankEl });
  }

  private syncRankEl(el: HTMLElement, rank: 0 | 1 | 2 | 3) {
    const RANK_COLORS = ['#444', '#cd7f32', '#b0b0b0', '#ffd700'];
    el.textContent = rank === 0 ? 'Private' : '◆'.repeat(rank) + ' ' + RANK_NAMES[rank];
    el.style.color = RANK_COLORS[rank];
  }

  private syncXpEl(bar: HTMLElement, num: HTMLElement, ap: number, rank: 0 | 1 | 2 | 3) {
    if (rank >= 3) {
      bar.style.width  = '100%';
      num.textContent  = 'MAX';
      bar.parentElement?.classList.add('char-card-xp-track-max');
      return;
    }
    bar.parentElement?.classList.remove('char-card-xp-track-max');
    const prev = rank === 0 ? 0 : PROMO_THRESHOLDS[rank - 1];
    const next = PROMO_THRESHOLDS[rank];
    const span = next - prev;
    const into = Math.max(0, Math.min(span, ap - prev));
    bar.style.width = `${(into / span) * 100}%`;
    num.textContent = `${Math.floor(ap)} / ${next}`;
  }

  private syncBehaviorEl(el: HTMLElement, behavior: 'attacking' | 'collecting' | 'harass' | 'defend' | 'rush') {
    el.classList.remove('char-card-behavior-collect', 'char-card-behavior-harass', 'char-card-behavior-defend', 'char-card-behavior-rush');
    if (behavior === 'collecting') {
      el.textContent = '💰 Collect';
      el.classList.add('char-card-behavior-collect');
    } else if (behavior === 'harass') {
      el.textContent = '🎯 Harass';
      el.classList.add('char-card-behavior-harass');
    } else if (behavior === 'defend') {
      el.textContent = '🛡 Defend';
      el.classList.add('char-card-behavior-defend');
    } else if (behavior === 'rush') {
      el.textContent = '⚡ Rush';
      el.classList.add('char-card-behavior-rush');
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
      this.syncXpEl(entry.xpBar, entry.xpNum, entry.char.currentAP, entry.char.rank);
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
