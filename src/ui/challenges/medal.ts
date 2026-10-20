/** Medal + challenge icons as inline SVG (no assets). */
import type { ChallengeDef, MedalId } from '../../game/challenges/types';

export const MEDAL_NAMES: Readonly<Record<MedalId, string>> = { none: 'No medal', bronze: 'Bronze', silver: 'Silver', gold: 'Gold', crumple: 'Crumple' };

const MEDAL_COLORS: Readonly<Record<Exclude<MedalId, 'none'>, [string, string, string]>> = {
  bronze: ['#f0b183', '#b0683a', '#6b3a1c'],
  silver: ['#f4f6f8', '#aab2bc', '#5d6670'],
  gold: ['#fff1a6', '#e2a92a', '#8a5a0c'],
  crumple: ['#fbe6ff', '#b07cff', '#3a1a7a'],
};

let uid = 0;

/** A medal disc (ribbon + rim + star); 'none' draws an empty socket. */
export function medalSvg(m: MedalId, size = 48): string {
  const id = `chm${uid++}`;
  if (m === 'none') {
    return `<svg class="ch-medal ch-medal--none" width="${size}" height="${size}" viewBox="0 0 48 48" aria-label="No medal"><circle cx="24" cy="27" r="15" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2" stroke-dasharray="3 3"/></svg>`;
  }
  const [hi, mid, lo] = MEDAL_COLORS[m];
  const star =
    m === 'crumple'
      ? '<path d="M24 17 l2.2 5.6 5.9.4-4.6 3.8 1.5 5.8L24 29.4l-5 3.2 1.5-5.8-4.6-3.8 5.9-.4z" fill="#fff" opacity=".95"/><path d="M16 36 L32 20" stroke="#fff" stroke-width="1.4" opacity=".5"/>'
      : '<path d="M24 18 l2 5.1 5.4.3-4.2 3.5 1.4 5.3L24 29.3l-4.6 2.9 1.4-5.3-4.2-3.5 5.4-.3z" fill="' + hi + '" opacity=".95"/>';
  return `<svg class="ch-medal ch-medal--${m}" width="${size}" height="${size}" viewBox="0 0 48 48" aria-label="${MEDAL_NAMES[m]} medal">
<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset=".55" stop-color="${mid}"/><stop offset="1" stop-color="${lo}"/></linearGradient></defs>
<path d="M15 2 h7 l4 10 h-7z" fill="#c8281e"/><path d="M33 2 h-7 l-4 10 h7z" fill="#1d4e89"/>
<circle cx="24" cy="27" r="16" fill="url(#${id})"/><circle cx="24" cy="27" r="12.5" fill="none" stroke="${lo}" stroke-opacity=".55" stroke-width="1.2"/>${star}</svg>`;
}

const ICONS: Readonly<Record<ChallengeDef['icon'], string>> = {
  jump: '<path d="M4 34 L22 34 L30 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 20 q8 -10 13 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="3 3"/><rect x="31" y="13" width="9" height="5" rx="1.5" fill="currentColor" transform="rotate(-25 35 15)"/>',
  roll: '<circle cx="24" cy="24" r="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="5 4"/><rect x="16" y="20" width="16" height="8" rx="2" fill="currentColor" transform="rotate(35 24 24)"/><path d="M37 13 l3 -5 l2 6z" fill="currentColor"/>',
  wall: '<rect x="30" y="8" width="10" height="32" fill="currentColor" opacity=".9"/><path d="M6 30 h14 l4 -6 h4 v12 h-22z" fill="currentColor"/><path d="M26 18 l3 3 M27 30 l3 -2 M24 12 l4 4" stroke="currentColor" stroke-width="2"/>',
  bowling: '<circle cx="12" cy="30" r="7" fill="currentColor"/><g fill="currentColor"><rect x="27" y="12" width="5" height="9" rx="2"/><rect x="34" y="12" width="5" height="9" rx="2"/><rect x="30.5" y="24" width="5" height="9" rx="2"/><rect x="41" y="12" width="5" height="9" rx="2"/></g>',
  drift: '<path d="M6 38 q14 -2 20 -14 t16 -16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="4 3"/><rect x="26" y="14" width="14" height="8" rx="2" fill="currentColor" transform="rotate(-40 33 18)"/><circle cx="12" cy="35" r="3" fill="currentColor" opacity=".5"/><circle cx="18" cy="33" r="4" fill="currentColor" opacity=".35"/>',
  truck: '<rect x="6" y="14" width="22" height="16" rx="1.5" fill="currentColor"/><path d="M28 18 h7 l5 6 v6 h-12z" fill="currentColor"/><circle cx="13" cy="33" r="3.5" fill="currentColor"/><circle cx="34" cy="33" r="3.5" fill="currentColor"/><path d="M4 40 h40" stroke="currentColor" stroke-width="2" stroke-dasharray="3 4"/>',
  derby: '<path d="M6 30 l10 -10 h8 l4 10z" fill="currentColor"/><path d="M42 30 l-10 -10 h-8" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M22 10 l2 6 l3 -5 l1 6" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="33" r="3" fill="currentColor"/><circle cx="36" cy="33" r="3" fill="currentColor"/>',
  climb: '<path d="M4 40 L16 28 L22 32 L34 14 L44 8" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><path d="M38 6 v10 M38 6 h7 l-2 3 2 3 h-7" fill="currentColor" stroke="currentColor" stroke-width="1.5"/>',
  park: '<rect x="10" y="8" width="28" height="32" rx="2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="4 3"/><text x="24" y="31" text-anchor="middle" font-size="18" font-weight="900" fill="currentColor" font-family="Arial Black, Arial">P</text>',
  air: '<path d="M6 36 l12 -6 l6 -14 l6 14 l12 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><path d="M24 6 v6 M14 10 l3 4 M34 10 l-3 4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
};

export function challengeIcon(icon: ChallengeDef['icon'], size = 40): string {
  return `<svg class="ch-icon" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">${ICONS[icon]}</svg>`;
}
