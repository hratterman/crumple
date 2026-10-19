/**
 * Loading screen controller. The markup and styles live inline in
 * index.html so the screen paints before any script loads (no layout jump
 * when the bundle arrives); this only flips step states, drives the bar and
 * fades the overlay out over the first rendered frame.
 */
export type LoadingStep = 'terrain' | 'physics' | 'textures' | 'shaders';
export type LoadingState = 'pending' | 'active' | 'done' | 'error';

/** Relative weight of each step in the progress bar (≈ its share of load time). */
const WEIGHTS: Readonly<Record<LoadingStep, number>> = { terrain: 0.4, physics: 0.2, textures: 0.2, shaders: 0.2 };
const FADE_MS = 900;

export class LoadingScreen {
  private readonly root: HTMLElement | null;
  private readonly fill: HTMLElement | null;
  private readonly foot: HTMLElement | null;
  private readonly states = new Map<LoadingStep, LoadingState>();
  private readonly t0 = performance.now();

  constructor(doc: Document = document) {
    this.root = doc.getElementById('loading');
    this.fill = this.root?.querySelector<HTMLElement>('.loading-bar-fill') ?? null;
    this.foot = this.root?.querySelector<HTMLElement>('.loading-foot') ?? null;
    for (const el of this.root?.querySelectorAll<HTMLElement>('.loading-step') ?? []) {
      this.states.set(el.dataset.step as LoadingStep, (el.dataset.state as LoadingState) ?? 'pending');
    }
  }

  /** ms since the screen controller was created. */
  get elapsedMs(): number {
    return performance.now() - this.t0;
  }

  set(step: LoadingStep, state: LoadingState): void {
    this.states.set(step, state);
    const el = this.root?.querySelector<HTMLElement>(`.loading-step[data-step="${step}"]`);
    if (el) el.dataset.state = state;
    this.updateBar();
  }

  /** Shows a fatal load error in the footer (the overlay stays up). */
  fail(message: string): void {
    for (const [k, v] of this.states) if (v === 'active') this.set(k, 'error');
    if (this.foot) {
      this.foot.dataset.error = '';
      this.foot.textContent = message;
    }
  }

  /**
   * P6 ready state: loading is done; offer "Choose your car" (showroom) or
   * "Drive" with the persisted car. Resolves 'choose' / 'drive' on a click
   * (Enter = drive, C = choose) or 'drive' after `holdMs` (a countdown bar
   * runs on the Drive button; 0 = no wait: the buttons stay clickable while
   * the overlay fades). No-op markup-less pages resolve 'drive'.
   */
  ready(carName: string, holdMs: number): Promise<'drive' | 'choose'> {
    const box = this.root?.querySelector<HTMLElement>('.loading-ready');
    if (!this.root || !box) return Promise.resolve('drive');
    const steps = this.root.querySelector<HTMLElement>('.loading-steps');
    const car = box.querySelector<HTMLElement>('.loading-ready-car');
    const timer = box.querySelector<HTMLElement>('.loading-btn-timer');
    if (car) car.textContent = carName;
    if (steps) steps.hidden = true;
    box.hidden = false;
    if (this.fill) this.fill.style.transform = 'scaleX(1)';
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: 'drive' | 'choose'): void => {
        if (done) return;
        done = true;
        window.clearTimeout(t);
        window.removeEventListener('keydown', onKey, true);
        resolve(r);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.code === 'Enter' || e.code === 'NumpadEnter') finish('drive');
        else if (e.code === 'KeyC') {
          e.stopImmediatePropagation();
          e.preventDefault();
          finish('choose');
        }
      };
      box.querySelector('[data-action="choose"]')?.addEventListener('click', () => finish('choose'));
      box.querySelector('[data-action="drive"]')?.addEventListener('click', () => finish('drive'));
      window.addEventListener('keydown', onKey, true);
      const t = window.setTimeout(() => finish('drive'), Math.max(0, holdMs));
      if (timer && holdMs > 0) {
        timer.style.transition = `transform ${holdMs}ms linear`;
        void timer.offsetWidth;
        timer.style.transform = 'scaleX(1)';
      }
      box.querySelector<HTMLElement>('[data-action="choose"]')?.focus({ preventScroll: true });
    });
  }

  /** Fades the overlay out (resolves when hidden). */
  hide(): Promise<void> {
    const root = this.root;
    if (!root) return Promise.resolve();
    if (this.fill) this.fill.style.transform = 'scaleX(1)';
    void root.offsetWidth; // commit the current style so the opacity transition runs
    root.classList.add('loading--fade');
    return new Promise((resolve) => {
      window.setTimeout(() => {
        root.hidden = true;
        resolve();
      }, FADE_MS);
    });
  }

  private updateBar(): void {
    let p = 0;
    for (const [k, v] of this.states) {
      if (v === 'done') p += WEIGHTS[k];
      else if (v === 'active') p += WEIGHTS[k] * 0.25;
    }
    if (this.fill) this.fill.style.transform = `scaleX(${Math.max(0.02, Math.min(1, p)).toFixed(3)})`;
  }
}
