/**
 * Challenge select (P8-C): a glass overlay over the frozen world, like the
 * pause menu. A card per challenge (icon, location, name, blurb, vehicle,
 * best medal, personal best) and a detail panel for the focused one (brief,
 * objectives, medal targets — 'crumple' stays "???" until earned — PB and
 * attempts, Start). Keyboard: arrows move, Enter starts, Esc backs out;
 * gamepad through the shared PadNav.
 */
import './challenges.css';
import { formatScore } from '../../game/challenges/medals';
import type { ChallengeDef, MedalId, PbRecord } from '../../game/challenges/types';
import { firstGamepad, keyIntent, PadNav, type NavIntent } from '../showroom/nav';
import { challengeIcon, MEDAL_NAMES, medalSvg } from './medal';

export interface SelectOptions {
  defs: () => readonly ChallengeDef[];
  record: (id: string) => PbRecord | null;
  vehicleName: (def: ChallengeDef) => string;
  onStart: (id: string) => void;
  onBack: () => void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export class ChallengeSelect {
  readonly root: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly detail: HTMLElement;
  private readonly summary: HTMLDivElement;
  private cards: HTMLButtonElement[] = [];
  private focusIdx = 0;
  private _open = false;
  private readonly pad = new PadNav();
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);

  constructor(
    parent: HTMLElement,
    private readonly opts: SelectOptions,
  ) {
    const root = h('div', 'ch ch-select', parent);
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Stunt challenges');
    root.dataset.testid = 'challenge-select';
    this.root = root;
    const head = h('header', 'ch-select-head', root);
    const t = h('div', 'ch-select-titles', head);
    h('div', 'ch-kicker', t, 'Crumple Valley');
    h('h1', 'ch-select-title', t, 'Stunt Challenges');
    this.summary = h('div', 'ch-select-summary', head);
    const body = h('div', 'ch-select-body', root);
    this.grid = h('div', 'ch-grid', body);
    this.detail = h('aside', 'ch-detail', body);
    const foot = h('div', 'ch-foot', root);
    foot.innerHTML = [
      ['← → ↑ ↓', 'Choose'],
      ['Enter', 'Start'],
      ['Esc', 'Back'],
    ]
      .map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`)
      .join('');
  }

  get isOpen(): boolean {
    return this._open;
  }

  /** The focused challenge id. */
  get focused(): string | null {
    return this.opts.defs()[this.focusIdx]?.id ?? null;
  }

  open(focusId?: string): void {
    this.render();
    if (!this._open) {
      this._open = true;
      this.root.hidden = false;
      this.root.classList.remove('ch-select--in');
      void this.root.offsetWidth;
      this.root.classList.add('ch-select--in');
      window.addEventListener('keydown', this.onKey, true);
      window.addEventListener('keyup', this.onKey, true);
      this.pad.reset();
    }
    const i = focusId ? this.opts.defs().findIndex((d) => d.id === focusId) : this.focusIdx;
    this.focus(Math.max(0, i));
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
  }

  frame(dtS: number): void {
    if (!this._open) return;
    for (const i of this.pad.poll(firstGamepad(), dtS)) this.intent(i);
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }

  private render(): void {
    const defs = this.opts.defs();
    this.grid.replaceChildren();
    this.cards = defs.map((d, i) => {
      const rec = this.opts.record(d.id);
      const medal: MedalId = rec ? rec.bestMedal : 'none';
      const c = h('button', `ch-card ch-card--${medal}`, this.grid);
      c.dataset.challenge = d.id;
      c.dataset.testid = `challenge-card-${d.id}`;
      c.style.setProperty('--i', String(i));
      const top = h('div', 'ch-card-top', c);
      const ic = h('span', 'ch-card-icon', top);
      ic.innerHTML = challengeIcon(d.icon, 34);
      const m = h('span', 'ch-card-medal', top);
      m.innerHTML = medalSvg(medal, 34);
      h('div', 'ch-card-where', c, d.where);
      h('div', 'ch-card-name', c, d.name);
      h('div', 'ch-card-blurb', c, d.blurb);
      const foot = h('div', 'ch-card-foot', c);
      h('span', 'ch-chip', foot, this.opts.vehicleName(d));
      h('span', 'ch-card-pb', foot, rec ? `PB ${formatScore(rec.best, d.scoring)}` : 'No time set');
      c.addEventListener('click', () => {
        if (this.focusIdx === i) this.opts.onStart(d.id);
        else this.focus(i);
      });
      c.addEventListener('dblclick', () => this.opts.onStart(d.id));
      c.addEventListener('mouseenter', () => this.focus(i, false));
      return c;
    });
    let earned = 0;
    let golds = 0;
    for (const d of defs) {
      const r = this.opts.record(d.id);
      if (r && r.bestMedal !== 'none') earned++;
      if (r && (r.bestMedal === 'gold' || r.bestMedal === 'crumple')) golds++;
    }
    this.summary.innerHTML = `<div><span class="ch-sum-n">${earned}<small>/${defs.length}</small></span><span class="ch-sum-l">Medals</span></div><div><span class="ch-sum-n">${golds}</span><span class="ch-sum-l">Gold or better</span></div>`;
  }

  private focus(i: number, move = true): void {
    const defs = this.opts.defs();
    if (defs.length === 0) return;
    this.focusIdx = Math.max(0, Math.min(defs.length - 1, i));
    this.cards.forEach((c, k) => c.classList.toggle('ch-card--on', k === this.focusIdx));
    if (move) this.cards[this.focusIdx]?.focus({ preventScroll: false });
    this.renderDetail(defs[this.focusIdx]!);
  }

  private renderDetail(d: ChallengeDef): void {
    const rec = this.opts.record(d.id);
    const p = this.detail;
    p.replaceChildren();
    p.classList.remove('ch-detail--in');
    void p.offsetWidth;
    p.classList.add('ch-detail--in');
    const head = h('div', 'ch-detail-head', p);
    const ic = h('span', 'ch-detail-icon', head);
    ic.innerHTML = challengeIcon(d.icon, 46);
    const ht = h('div', '', head);
    h('div', 'ch-kicker', ht, d.where);
    h('h2', 'ch-detail-name', ht, d.name);
    h('p', 'ch-detail-brief', p, d.brief);
    const meta = h('div', 'ch-detail-meta', p);
    const metaRow = (k: string, v: string): void => {
      const r = h('div', 'ch-meta', meta);
      h('span', 'ch-meta-k', r, k);
      h('span', 'ch-meta-v', r, v);
    };
    metaRow('Vehicle', this.opts.vehicleName(d));
    metaRow('Scored on', scoredOn(d));
    metaRow('Personal best', rec ? formatScore(rec.best, d.scoring) : '—');
    metaRow('Attempts', rec ? String(rec.attempts) : '0');
    const medals = h('div', 'ch-targets', p);
    const earned = rec ? rec.bestMedal : 'none';
    for (const m of ['bronze', 'silver', 'gold', 'crumple'] as const) {
      const row = h('div', `ch-target${rankOf(earned) >= rankOf(m) ? ' ch-target--won' : ''}`, medals);
      const ic2 = h('span', '', row);
      ic2.innerHTML = medalSvg(m, 28);
      h('span', 'ch-target-name', row, MEDAL_NAMES[m]);
      const hidden = m === 'crumple' && rankOf(earned) < rankOf('crumple');
      h('span', 'ch-target-v', row, hidden ? '???' : formatScore(d.medals[m], d.scoring));
    }
    const go = h('button', 'ch-btn ch-btn--primary', p);
    go.dataset.testid = 'challenge-start';
    go.innerHTML = `<span>Start</span><kbd>Enter</kbd>`;
    go.addEventListener('click', () => this.opts.onStart(d.id));
  }

  private intent(i: NavIntent): void {
    const cols = Math.max(1, Math.round(this.grid.clientWidth / Math.max(1, this.cards[0]?.offsetWidth ?? 1)));
    switch (i) {
      case 'left':
        this.focus(this.focusIdx - 1);
        break;
      case 'right':
        this.focus(this.focusIdx + 1);
        break;
      case 'up':
        this.focus(this.focusIdx - cols);
        break;
      case 'down':
        this.focus(this.focusIdx + cols);
        break;
      case 'accept': {
        const id = this.focused;
        if (id) this.opts.onStart(id);
        break;
      }
      case 'back':
        this.opts.onBack();
        break;
      default:
        break;
    }
  }

  private key(e: KeyboardEvent): void {
    if (!this._open || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Tab' || /^F\d+$/.test(e.code) || e.code === 'Backquote') return;
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    const i = e.code === 'KeyP' ? 'back' : keyIntent(e.code);
    if (!i) return;
    e.preventDefault();
    if (e.repeat && (i === 'accept' || i === 'back')) return;
    this.intent(i);
  }
}

function rankOf(m: MedalId): number {
  return ['none', 'bronze', 'silver', 'gold', 'crumple'].indexOf(m);
}

function scoredOn(d: ChallengeDef): string {
  switch (d.scoring.metric) {
    case 'time':
      return 'Time — lower is better';
    case 'jumpDistance':
      return 'Jump distance';
    case 'rolls':
      return 'Rolls in the air';
    case 'crush':
      return 'Crush depth';
    case 'pins':
      return 'Pins down';
    case 'drift':
      return 'Drift points';
    case 'derby':
      return 'Knock-outs + survival';
    case 'park':
      return 'Speed, centring, angle';
    case 'stunt':
      return 'Stunt points';
    default:
      return d.scoring.unit;
  }
}
