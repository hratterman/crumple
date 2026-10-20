/**
 * Challenge results (P8-C): medal reveal (the earned medal drops in and
 * shines; a new PB gets its ribbon), score + PB delta, the run's stats, the
 * next medal to chase, and the actions: Retry (Enter / R), Next (N), Watch
 * replay (Backspace / W), All challenges (C), Quit (Esc). Keys are taken in
 * the capture phase while it is open (nothing reaches the driving mapper).
 */
import './challenges.css';
import { formatDelta, formatScore, nextMedal } from '../../game/challenges/medals';
import type { ChallengeDef, ChallengeResult } from '../../game/challenges/types';
import { challengeIcon, MEDAL_NAMES, medalSvg } from './medal';

export interface ResultsOptions {
  onRetry: () => void;
  onNext: () => void;
  onReplay: () => void;
  onList: () => void;
  onQuit: () => void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export class ChallengeResults {
  readonly root: HTMLDivElement;
  private _open = false;
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);

  constructor(
    parent: HTMLElement,
    private readonly opts: ResultsOptions,
  ) {
    const root = h('div', 'ch ch-results', parent);
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Challenge results');
    root.dataset.testid = 'challenge-results';
    this.root = root;
  }

  get isOpen(): boolean {
    return this._open;
  }

  open(def: ChallengeDef, r: ChallengeResult, hasNext: boolean, replayable: boolean): void {
    const root = this.root;
    root.replaceChildren();
    root.className = `ch ch-results ch-results--${r.completed ? r.medal : 'failed'}`;
    const card = h('div', 'ch-res-card', root);
    const head = h('div', 'ch-res-head', card);
    const ic = h('span', 'ch-res-icon', head);
    ic.innerHTML = challengeIcon(def.icon, 30);
    const ht = h('div', '', head);
    h('div', 'ch-kicker', ht, def.where);
    h('div', 'ch-res-name', ht, def.name);

    const hero = h('div', 'ch-res-hero', card);
    const medal = h('div', `ch-res-medal ch-res-medal--${r.medal}`, hero);
    medal.innerHTML = medalSvg(r.completed ? r.medal : 'none', 132) + '<span class="ch-res-shine"></span>';
    const sc = h('div', 'ch-res-score', hero);
    h('div', 'ch-res-medalname', sc, r.completed ? (r.medal === 'none' ? 'No medal' : `${MEDAL_NAMES[r.medal]}${r.medal === 'crumple' ? ' — hidden medal!' : ''}`) : 'Failed');
    const big = h('div', 'ch-res-big', sc, r.completed ? r.scoreText : (r.failReason ?? 'Failed'));
    big.dataset.testid = 'challenge-result-score';
    if (r.completed && r.isBest) h('div', 'ch-res-pb', sc, r.previousBest === null ? 'First personal best' : 'New personal best');
    if (r.completed && r.previousBest !== null) {
      const better = r.isBest;
      h('div', `ch-res-delta ${better ? 'ch-good' : 'ch-bad'}`, sc, `${formatDelta(r.score, r.previousBest, def.scoring)} vs PB ${formatScore(r.previousBest, def.scoring)}`);
    }
    const nm = r.completed ? nextMedal(r.medal, def.medals) : nextMedal('none', def.medals);
    if (nm) h('div', 'ch-res-next', sc, `Next: ${MEDAL_NAMES[nm.medal]} at ${formatScore(nm.threshold, def.scoring)}`);
    else if (r.completed && r.medal === 'gold') h('div', 'ch-res-next', sc, 'Gold. There is one more medal for those who go further…');

    const stats = h('div', 'ch-res-stats', card);
    r.stats.forEach((s, i) => {
      const c = h('div', 'ch-stat', stats);
      c.style.setProperty('--i', String(i));
      h('span', 'ch-stat-k', c, s.label);
      h('span', 'ch-stat-v', c, s.value);
    });

    const acts = h('div', 'ch-res-actions', card);
    const btn = (label: string, k: string, cls: string, fn: () => void, testid: string, disabled = false): void => {
      const b = h('button', `ch-btn ${cls}`, acts);
      b.innerHTML = `<span>${label}</span><kbd>${k}</kbd>`;
      b.dataset.testid = testid;
      b.disabled = disabled;
      b.addEventListener('click', fn);
    };
    btn('Retry', 'Enter', 'ch-btn--primary', this.opts.onRetry, 'challenge-retry');
    btn('Next', 'N', '', this.opts.onNext, 'challenge-next', !hasNext);
    btn('Watch replay', 'Bksp', '', this.opts.onReplay, 'challenge-replay', !replayable);
    btn('Challenges', 'C', 'ch-btn--ghost', this.opts.onList, 'challenge-list');
    btn('Quit', 'Esc', 'ch-btn--ghost', this.opts.onQuit, 'challenge-quit');
    if (!this._open) {
      this._open = true;
      window.addEventListener('keydown', this.onKey, true);
      window.addEventListener('keyup', this.onKey, true);
    }
    root.hidden = false;
    root.classList.add('ch-results--in');
    (acts.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }

  private key(e: KeyboardEvent): void {
    if (!this._open || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Tab' || /^F\d+$/.test(e.code) || e.code === 'Backquote') return;
    e.stopImmediatePropagation();
    if (e.type !== 'keydown' || e.repeat) return;
    const act: Record<string, () => void> = {
      Enter: this.opts.onRetry,
      NumpadEnter: this.opts.onRetry,
      KeyR: this.opts.onRetry,
      KeyF: this.opts.onRetry,
      KeyN: this.opts.onNext,
      Backspace: this.opts.onReplay,
      KeyW: this.opts.onReplay,
      KeyC: this.opts.onList,
      Escape: this.opts.onQuit,
    };
    const f = act[e.code];
    if (f) {
      e.preventDefault();
      f();
    }
  }
}
