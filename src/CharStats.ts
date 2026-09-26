import { charConfig, charCost, charDisplayName, charIcon, charUiColor } from './constants';
import type { Tribe } from './Tribes';
import type { AttackStyle } from './gameConfig';

/**
 * Presentation-layer stat sheet for a character type.
 *
 * Everything here is derived from the unit's gameConfig block, so a stat tweak
 * in gameConfig.ts is reflected in the UI with no further edits. The derived
 * DPS formula deliberately mirrors Game.unitProfile() — the CPU's valuation
 * and the number the player reads should never disagree.
 */

/** Human-readable role per attack style — shown under the unit name. */
const STYLE_LABEL: Record<AttackStyle, string> = {
  melee:   'Melee',
  blast:   'Shotgun blast',
  arrow:   'Archer',
  bullet:  'Gunner',
  grenade: 'Grenadier (AoE)',
  rocket:  'Rocketeer (AoE)',
};

/** One labelled bar in the stat panel — `frac` is 0..1 against the roster max. */
export interface StatBar {
  label: string;
  /** Formatted value shown at the right of the bar. */
  text:  string;
  frac:  number;
  color: string;
}

export interface CharStatSheet {
  type:        string;
  name:        string;
  icon:        string;
  color:       string;
  cost:        number;
  role:        string;
  bars:        StatBar[];
  /** Secondary numeric rows (accuracy, fire rate, knockback…). */
  rows:        { label: string; value: string }[];
  /** Special-mechanic badges (poison, shield, burst, reload, splash). */
  traits:      string[];
}

/** Sustained damage/sec — burst rounds, magazine reload, poison DoT and miss
 *  chance folded in. Same maths as the CPU's unit valuation. */
export function unitDps(tribe: Tribe, type: string): number {
  const cfg = charConfig(tribe, type);
  if (cfg.attackPower <= 0) return 0;
  const roundsPerTrigger = cfg.burstCount ?? 1;
  const poisonPerHit     = (cfg.poisonDamage ?? 0) * (cfg.poisonTicks ?? 0);
  const damagePerTrigger = cfg.attackPower * roundsPerTrigger + poisonPerHit;
  const magazine         = (cfg.shotsBeforeCooldown ?? 0) > 0 && (cfg.cooldownSec ?? 0) > 0;
  const triggersPerSec   = magazine
    ? cfg.shotsBeforeCooldown! / (cfg.shotsBeforeCooldown! * cfg.fireRate + cfg.cooldownSec!)
    : 1 / cfg.fireRate;
  return damagePerTrigger * triggersPerSec * (1 - cfg.critical);
}

/** Effective HP including the expected shield-block absorption. */
export function unitEffectiveHp(tribe: Tribe, type: string): number {
  const cfg = charConfig(tribe, type);
  const blockFactor = 1 - (cfg.blockChance ?? 0) * (cfg.blockPercent ?? 0);
  return cfg.hp / Math.max(0.2, blockFactor);
}

/** Per-stat maxima across a set of types — bars are relative to the roster the
 *  player is choosing from, so the longest bar always means "best in class". */
export interface StatScale { hp: number; dps: number; range: number; speed: number }

export function statScale(tribe: Tribe, types: readonly string[]): StatScale {
  const scale: StatScale = { hp: 1, dps: 1, range: 1, speed: 1 };
  for (const t of types) {
    const cfg = charConfig(tribe, t);
    scale.hp    = Math.max(scale.hp,    cfg.hp);
    scale.dps   = Math.max(scale.dps,   unitDps(tribe, t));
    scale.range = Math.max(scale.range, cfg.attackRange);
    scale.speed = Math.max(scale.speed, cfg.speed);
  }
  return scale;
}

const round1 = (n: number) => (Math.round(n * 10) / 10).toString();

export function charStatSheet(tribe: Tribe, type: string, scale: StatScale): CharStatSheet {
  const cfg = charConfig(tribe, type);
  const dps = unitDps(tribe, type);

  const bars: StatBar[] = [
    { label: 'Health', text: `${cfg.hp}`,                frac: cfg.hp / scale.hp,                   color: '#68d391' },
    { label: 'Damage', text: `${round1(dps)} /s`,        frac: dps / scale.dps,                     color: '#f6775f' },
    { label: 'Range',  text: `${Math.round(cfg.attackRange)}`, frac: cfg.attackRange / scale.range, color: '#7fd4ff' },
    { label: 'Speed',  text: `${Math.round(cfg.speed)}`, frac: cfg.speed / scale.speed,             color: '#ffd166' },
  ];

  const rows: { label: string; value: string }[] = [
    { label: 'Attack power', value: cfg.attackPower > 0 ? `${cfg.attackPower}` : '—' },
    { label: 'Attack speed', value: cfg.attackPower > 0 ? `${round1(1 / cfg.fireRate)} /s` : '—' },
    { label: 'Accuracy',     value: `${Math.round((1 - cfg.critical) * 100)}%` },
  ];
  if (cfg.knockback > 0) rows.push({ label: 'Knockback', value: `${cfg.knockback}` });

  const traits: string[] = [];
  if ((cfg.burstCount ?? 1) > 1) traits.push(`🔁 ${cfg.burstCount}-round burst`);
  if ((cfg.shotsBeforeCooldown ?? 0) > 0 && (cfg.cooldownSec ?? 0) > 0)
    traits.push(`🧰 ${cfg.shotsBeforeCooldown} shots, ${round1(cfg.cooldownSec!)}s reload`);
  if ((cfg.poisonDamage ?? 0) > 0 && (cfg.poisonTicks ?? 0) > 0)
    traits.push(`☠ Poison ${cfg.poisonDamage}×${cfg.poisonTicks}`);
  if ((cfg.blockChance ?? 0) > 0 && (cfg.blockPercent ?? 0) > 0)
    traits.push(`🛡 Blocks ${Math.round(cfg.blockPercent! * 100)}% (${Math.round(cfg.blockChance! * 100)}% chance)`);
  if (cfg.attackStyle === 'grenade' || cfg.attackStyle === 'rocket') traits.push('💥 Splash damage');
  if (cfg.attackStyle === 'blast') traits.push('💥 Hits everyone in the cone');
  if (cfg.attackPower <= 0) traits.push('✚ Support — cannot attack');

  return {
    type,
    name:  charDisplayName(tribe, type),
    icon:  charIcon(tribe, type),
    color: charUiColor(tribe, type),
    cost:  charCost(tribe, type),
    role:  STYLE_LABEL[cfg.attackStyle] ?? cfg.attackStyle,
    bars, rows, traits,
  };
}
