import type { Character } from './Character';
import { RANK_NAMES } from './Character';
import { PROMO_THRESHOLDS } from './constants';

// ── Shared rank/XP display helpers ──────────────────────────────────────────
// Used by both the HUD card (below) and the command dialog (main.ts) so the
// rank-badge string and promotion-progress math live in one place.

/** Rank badge label: 'Private' at rank 0, else ◆-repeat + rank name. */
export function rankLabel(rank: number): string {
  return rank === 0 ? 'Private' : '◆'.repeat(rank) + ' ' + RANK_NAMES[rank];
}

/** XP progress toward the next promotion. Rank ≥ 3 (Captain) is maxed. */
export function xpProgress(ap: number, rank: number): { frac: number; text: string; isMax: boolean } {
  if (rank >= 3) return { frac: 1, text: 'MAX', isMax: true };
  const prev = rank === 0 ? 0 : PROMO_THRESHOLDS[rank - 1];
  const next = PROMO_THRESHOLDS[rank];
  const span = next - prev;
  const into = Math.max(0, Math.min(span, ap - prev));
  return { frac: into / span, text: `${Math.floor(ap)} / ${next}`, isMax: false };
}

interface CardEntry {
  char:       Character;
  root:       HTMLElement;
  hpBar:      HTMLElement;
  hpNum:      HTMLElement;
  xpBar:      HTMLElement;
  xpNum:      HTMLElement;
  behaviorEl: HTMLElement;
  rankEl:     HTMLElement;
  // Cached last-written values — skip DOM writes when nothing has changed
  lastHpRatio:  number;
  lastRank:     number;
  lastAP:       number;
  lastBehavior: string;
}

export class CharacterHUD {
  private container: HTMLElement;
  private cards:     CardEntry[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
  }

  add(char: Character) {
    const id    = char.id;
    const type  = char.config.id;
    // Config-driven — the character block supplies its own UI metadata.
    const color = char.config.uiColor ?? '#ffffff';
    const icon  = char.config.icon    ?? '?';

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
    label.textContent = char.config.displayName ?? type.charAt(0).toUpperCase() + type.slice(1);

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

    this.cards.push({ char, root: card, hpBar, hpNum, xpBar, xpNum, behaviorEl: behaviorBtn, rankEl,
      lastHpRatio: -1, lastRank: -1, lastAP: -1, lastBehavior: '' });
  }

  private syncRankEl(el: HTMLElement, rank: 0 | 1 | 2 | 3) {
    const RANK_COLORS = ['#444', '#cd7f32', '#b0b0b0', '#ffd700'];
    el.textContent = rankLabel(rank);
    el.style.color = RANK_COLORS[rank];
  }

  private syncXpEl(bar: HTMLElement, num: HTMLElement, ap: number, rank: 0 | 1 | 2 | 3) {
    const xp = xpProgress(ap, rank);
    bar.parentElement?.classList.toggle('char-card-xp-track-max', xp.isMax);
    bar.style.width = xp.isMax ? '100%' : `${xp.frac * 100}%`;
    num.textContent = xp.text;
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
    let wi = 0;
    for (let ri = 0; ri < this.cards.length; ri++) {
      const entry = this.cards[ri];
      if (entry.char.isDead) {
        entry.root.classList.add('char-card-dying');
        entry.root.addEventListener('animationend', () => entry.root.remove(), { once: true });
        continue;
      }

      // HP bar — guard against redundant DOM writes (only changes on damage/heal)
      const ratio        = Math.max(0, entry.char.hp / entry.char.maxHp);
      const ratioKey     = Math.round(ratio * 1000);  // 0.1 % resolution
      if (ratioKey !== entry.lastHpRatio) {
        entry.lastHpRatio       = ratioKey;
        entry.hpBar.style.width = `${ratio * 100}%`;
        entry.hpNum.textContent = String(Math.ceil(entry.char.hp));
      }

      // Rank / XP — changes only on promotion or AP gain
      const rank = entry.char.rank;
      const ap   = Math.floor(entry.char.currentAP);
      if (rank !== entry.lastRank || ap !== entry.lastAP) {
        entry.lastRank = rank;
        entry.lastAP   = ap;
        this.syncRankEl(entry.rankEl, rank);
        this.syncXpEl(entry.xpBar, entry.xpNum, entry.char.currentAP, rank);
      }

      // Behavior — changes only when the player or AI reassigns it
      const beh = entry.char.behavior;
      if (beh !== entry.lastBehavior) {
        entry.lastBehavior = beh;
        this.syncBehaviorEl(entry.behaviorEl, beh);
      }

      this.cards[wi++] = entry;
    }
    this.cards.length = wi;
  }

  clear() {
    for (const entry of this.cards) entry.root.remove();
    this.cards   = [];
  }
}
