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
