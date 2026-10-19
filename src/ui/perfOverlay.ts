/**
 * Perf overlay (toggle with the ` key; on from the start with ?perf=1):
 * fps, frame / main-thread ms, draw calls + triangles per pass and the
 * per-subsystem CPU breakdown from src/app/perf.ts. Text refreshes 4×/s.
 */
import type { FrameProfilerSnapshot, PassStat } from '../app/perf';

export interface PerfOverlayData {
  profile: FrameProfilerSnapshot;
  gpu: { calls: number; triangles: number; renders: number; passes: Record<string, PassStat> };
  /** Extra lines (quality level, scale, programs, …). */
  extra: Record<string, string | number>;
}

const REFRESH_MS = 250;

function fmt(ms: number): string {
  return ms.toFixed(ms >= 10 ? 1 : 2).padStart(6);
}

function kTris(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

/** Pure text layout of one overlay refresh (tested). */
export function formatPerf(d: PerfOverlayData): string {
  const p = d.profile;
  const lines: string[] = [];
  lines.push(`${p.fps.toFixed(1)} fps  frame ${p.frameMs.toFixed(1)} ms (max ${p.frameMaxMs.toFixed(0)})`);
  lines.push(`main CPU ${p.cpuMs.toFixed(2)} ms (max ${p.cpuMaxMs.toFixed(1)})`);
  lines.push(`draws ${d.gpu.calls}  tris ${kTris(d.gpu.triangles)}  scene renders ${d.gpu.renders}`);
  for (const [k, v] of Object.entries(d.gpu.passes)) {
    lines.push(`  ${k.padEnd(18)}${String(v.calls).padStart(5)}  ${kTris(v.triangles).padStart(7)}${v.ms > 0 ? fmt(v.ms) : ''}`);
  }
  lines.push('cpu ms              avg    max');
  for (const [k, v] of Object.entries(p.sections)) {
    lines.push(`  ${k.padEnd(16)}${fmt(v.avg)} ${fmt(v.max)}`);
  }
  for (const [k, v] of Object.entries(d.extra)) lines.push(`${k}: ${v}`);
  return lines.join('\n');
}

export class PerfOverlay {
  readonly el: HTMLPreElement;
  private lastMs = -Infinity;

  constructor(parent: HTMLElement = document.body) {
    const el = document.createElement('pre');
    el.className = 'perf-overlay';
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      margin: '0',
      padding: '6px 8px',
      font: '11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      color: '#e8f0e0',
      background: 'rgba(0, 0, 0, 0.62)',
      borderRadius: '4px',
      pointerEvents: 'none',
      zIndex: '50',
      whiteSpace: 'pre',
      maxHeight: 'calc(100vh - 16px)',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    el.hidden = true;
    parent.appendChild(el);
    this.el = el;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  set visible(v: boolean) {
    this.el.hidden = !v;
    this.lastMs = -Infinity;
  }

  /** Refreshes the text at most 4×/s; `data` is only called when a refresh is due. */
  update(data: () => PerfOverlayData, nowMs: number = performance.now()): void {
    if (this.el.hidden || nowMs - this.lastMs < REFRESH_MS) return;
    this.lastMs = nowMs;
    this.el.textContent = formatPerf(data());
  }

  dispose(): void {
    this.el.remove();
  }
}
