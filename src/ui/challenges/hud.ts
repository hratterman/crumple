/**
 * In-challenge HUD (P8-C): the top bar (challenge, live objective, run
 * clock, score), the intro card, the 3-2-1-GO countdown, combo popups
 * ("BIG AIR 2.3 s", "ROLL ×2", "DRIFT ×4"), the combo meter, checkpoint
 * splits, the direction arrow to the next gate and the fail banner. DOM
 * only; writes only when a shown value changes.
 */
import './challenges.css';
import { formatScore, formatTime } from '../../game/challenges/medals';
import type { ChallengeDef, ChallengeRunState, PopupKind } from '../../game/challenges/types';
import { challengeIcon, medalSvg } from './medal';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

const POPUP_MS = 2400;
const MAX_POPUPS = 4;

export class ChallengeHud {
  readonly root: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly icon: HTMLSpanElement;
  private readonly name: HTMLDivElement;
  private readonly objective: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly clockSub: HTMLDivElement;
  private readonly scoreLabel: HTMLDivElement;
  private readonly score: HTMLDivElement;
  private readonly arrow: HTMLDivElement;
  private readonly combo: HTMLDivElement;
  private readonly comboText: HTMLSpanElement;
  private readonly comboFill: HTMLSpanElement;
  private readonly split: HTMLDivElement;
  private readonly popups: HTMLDivElement;
  private readonly countdownEl: HTMLDivElement;
  private readonly intro: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private def: ChallengeDef | null = null;
  private last = { clock: '', score: '', objective: '', arrow: NaN, combo: '' };
  private splitTimer = 0;
  /** Time challenges: the right-hand figure is the time to beat. */
  private target = '';

  constructor(parent: HTMLElement) {
    const root = h('div', 'ch ch-hud', parent);
    root.hidden = true;
    root.dataset.testid = 'challenge-hud';
    this.root = root;
    const bar = h('div', 'ch-bar', root);
    this.bar = bar;
    const left = h('div', 'ch-bar-left', bar);
    this.icon = h('span', 'ch-bar-icon', left);
    const lt = h('div', 'ch-bar-lt', left);
    this.name = h('div', 'ch-bar-name', lt);
    this.objective = h('div', 'ch-bar-obj', lt);
    const mid = h('div', 'ch-bar-mid', bar);
    this.clock = h('div', 'ch-clock', mid, '0.00');
    this.clockSub = h('div', 'ch-clock-sub', mid, '');
    const right = h('div', 'ch-bar-right', bar);
    this.scoreLabel = h('div', 'ch-score-label', right, 'Score');
    this.score = h('div', 'ch-score', right, '0');
    this.score.dataset.testid = 'challenge-score';
    this.arrow = h('div', 'ch-arrow', root);
    this.arrow.innerHTML = '<svg viewBox="0 0 40 40" width="40" height="40"><path d="M20 4 L34 30 L20 23 L6 30 Z" fill="currentColor"/></svg>';
    this.combo = h('div', 'ch-combo', root);
    this.comboText = h('span', 'ch-combo-text', this.combo);
    const track = h('span', 'ch-combo-track', this.combo);
    this.comboFill = h('span', 'ch-combo-fill', track);
    this.split = h('div', 'ch-split', root);
    this.popups = h('div', 'ch-popups', root);
    this.popups.dataset.testid = 'challenge-popups';
    this.countdownEl = h('div', 'ch-countdown', root);
    this.intro = h('div', 'ch-intro', root);
    this.banner = h('div', 'ch-banner', root);
    this.hint = h('div', 'ch-hint', root);
    this.hint.innerHTML = '<span><kbd>F</kbd> Restart</span><span><kbd>Esc</kbd> Menu</span><span><kbd>Bksp</kbd> Replay</span>';
  }

  show(def: ChallengeDef, pb: string | null, vehicle: string): void {
    this.def = def;
    this.root.hidden = false;
    this.icon.innerHTML = challengeIcon(def.icon, 30);
    this.name.textContent = def.name;
    const time = def.scoring.metric === 'time';
    this.scoreLabel.textContent = time ? (pb ? 'Best' : 'Gold') : 'Score';
    this.target = pb ?? formatScore(def.medals.gold, def.scoring);
    this.clockSub.textContent = time ? 'Run time' : pb ? `Best ${pb}` : `Gold ${formatScore(def.medals.gold, def.scoring)}`;
    this.last = { clock: '', score: '', objective: '', arrow: NaN, combo: '' };
    this.popups.replaceChildren();
    this.banner.className = 'ch-banner';
    this.banner.textContent = '';
    this.countdownEl.textContent = '';
    this.split.className = 'ch-split';
    // intro card
    const i = this.intro;
    i.replaceChildren();
    i.className = 'ch-intro ch-intro--in';
    const ic = h('div', 'ch-intro-icon', i);
    ic.innerHTML = challengeIcon(def.icon, 56);
    h('div', 'ch-kicker', i, def.where);
    h('div', 'ch-intro-name', i, def.name);
    h('div', 'ch-intro-blurb', i, def.blurb);
    const meta = h('div', 'ch-intro-meta', i);
    h('span', 'ch-chip', meta, vehicle);
    const t = h('span', 'ch-intro-gold', meta);
    t.innerHTML = `${medalSvg('gold', 20)}<span>${formatScore(def.medals.gold, def.scoring)}</span>`;
    if (pb) h('span', 'ch-chip ch-chip--pb', meta, `PB ${pb}`);
  }

  hide(): void {
    this.root.hidden = true;
    this.def = null;
  }

  hideIntro(): void {
    if (this.intro.classList.contains('ch-intro--in')) this.intro.className = 'ch-intro ch-intro--out';
  }

  countdown(n: number): void {
    const el = this.countdownEl;
    el.textContent = n > 0 ? String(n) : 'GO!';
    el.className = 'ch-countdown';
    void el.offsetWidth;
    el.className = `ch-countdown ch-countdown--tick${n === 0 ? ' ch-countdown--go' : ''}`;
    if (n <= 1) this.hideIntro();
  }

  popup(kind: PopupKind, text: string, sub?: string): void {
    const p = h('div', `ch-popup ch-popup--${kind}`, null);
    h('div', 'ch-popup-text', p, text);
    if (sub) h('div', 'ch-popup-sub', p, sub);
    this.popups.prepend(p);
    while (this.popups.childElementCount > MAX_POPUPS) this.popups.lastElementChild?.remove();
    window.setTimeout(() => p.classList.add('ch-popup--out'), POPUP_MS);
    window.setTimeout(() => p.remove(), POPUP_MS + 500);
  }

  gate(index: number, count: number, split: number, delta: number | null): void {
    const s = this.split;
    const last = index === count - 1;
    const d = delta === null ? '' : `<span class="ch-split-d ${delta <= 0 ? 'ch-good' : 'ch-bad'}">${delta <= 0 ? '−' : '+'}${formatTime(Math.abs(delta))}</span>`;
    s.innerHTML = `<span class="ch-split-k">${last ? 'FINISH' : `CHECKPOINT ${index + 1}/${count}`}</span><span class="ch-split-t">${formatTime(split)}</span>${d}`;
    s.className = 'ch-split';
    void s.offsetWidth;
    s.className = 'ch-split ch-split--in';
    window.clearTimeout(this.splitTimer);
    this.splitTimer = window.setTimeout(() => (s.className = 'ch-split ch-split--out'), 2200);
  }

  fail(reason: string): void {
    this.banner.innerHTML = `<div class="ch-banner-k">Failed</div><div class="ch-banner-t">${reason}</div>`;
    this.banner.className = 'ch-banner ch-banner--fail';
  }

  finish(text: string): void {
    this.banner.innerHTML = `<div class="ch-banner-k">Finished</div><div class="ch-banner-t">${text}</div>`;
    this.banner.className = 'ch-banner ch-banner--done';
  }

  clearBanner(): void {
    this.banner.className = 'ch-banner';
  }

  /** Per frame: clock (s, live), state, arrow angle (rad, 0 = straight ahead, + = right; null hides). */
  update(state: Readonly<ChallengeRunState>, clockS: number, arrow: number | null): void {
    const def = this.def;
    if (!def) return;
    if (state.phase === 'running' && clockS > 0.6) this.hideIntro();
    const c = formatTime(Math.max(0, clockS), def.scoring.metric === 'time' ? 2 : 1);
    if (c !== this.last.clock) this.clock.textContent = this.last.clock = c;
    const sc = def.scoring.metric === 'time' ? this.target : state.scoreText;
    if (sc !== this.last.score) this.score.textContent = this.last.score = sc;
    const live = state.objectives.find((o) => !o.done) ?? state.objectives[0];
    const obj = state.failReason ?? (live ? live.text : '');
    if (obj !== this.last.objective) this.objective.textContent = this.last.objective = obj;
    if (arrow === null || state.phase !== 'running') {
      if (!Number.isNaN(this.last.arrow)) {
        this.arrow.classList.remove('ch-arrow--on');
        this.last.arrow = NaN;
      }
    } else if (Math.abs(arrow - this.last.arrow) > 0.01 || Number.isNaN(this.last.arrow)) {
      this.arrow.classList.add('ch-arrow--on');
      this.arrow.style.transform = `translateX(-50%) rotate(${arrow.toFixed(3)}rad)`;
      this.last.arrow = arrow;
    }
    const cb = state.combo;
    const ck = cb ? (cb.kind === 'drift' ? `DRIFT ×${cb.multiplier} · ${Math.round(cb.points).toLocaleString('en-US')}` : `AIR ${cb.points.toFixed(1)} s`) : '';
    if (ck !== this.last.combo) {
      this.last.combo = ck;
      this.comboText.textContent = ck;
      this.combo.classList.toggle('ch-combo--on', !!cb);
      this.combo.classList.toggle('ch-combo--air', !!cb && cb.kind === 'air');
    }
    if (cb) this.comboFill.style.transform = `scaleX(${cb.kind === 'drift' ? Math.min(1, cb.multiplier / 8) : Math.min(1, cb.points / 3)})`;
    this.bar.classList.toggle('ch-bar--warn', state.phase === 'running' && !!def.objectives.find((o) => o.type === 'timeLimit' && o.onExpire === 'fail' && o.seconds - clockS < 10));
  }

  dispose(): void {
    this.root.remove();
  }
}
