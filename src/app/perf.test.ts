import { describe, expect, it } from 'vitest';

import { FrameProfiler, PassCounter, perfGpuSync, perfRequested, type CountedRenderer } from './perf';

function clock(): { now: () => number; t: number } {
  const c = { t: 0, now: () => c.t };
  return c;
}

describe('FrameProfiler', () => {
  it('charges laps to sections and frames to the frame time', () => {
    const c = clock();
    const p = new FrameProfiler(true, c.now);
    for (let f = 0; f < 3; f++) {
      p.begin();
      c.t += 2;
      p.lap('a');
      c.t += 5;
      p.lap('b');
      p.add('b.inner', 1.5);
      c.t += 9; // idle until the next frame (GPU / vsync)
    }
    p.begin();
    const s = p.snapshot();
    expect(s.frameMs).toBeCloseTo(16, 6);
    expect(s.fps).toBeCloseTo(62.5, 3);
    expect(s.cpuMs).toBeCloseTo(7, 6); // laps only; add() is nested detail
    expect(s.sections.a!.avg).toBeGreaterThan(0);
    expect(Object.keys(s.sections)).toEqual(['a', 'b', 'b.inner']);
  });

  it('is inert while disabled', () => {
    const c = clock();
    const p = new FrameProfiler(false, c.now);
    p.begin();
    c.t += 3;
    p.lap('x');
    expect(p.sections.size).toBe(0);
  });

  it('wrap() times a method and can be undone', () => {
    const c = clock();
    const p = new FrameProfiler(true, c.now);
    const obj = {
      n: 0,
      update(k: number): number {
        c.t += 4;
        this.n += k;
        return this.n;
      },
    };
    const undo = p.wrap(obj, 'update', 'obj');
    p.begin();
    expect(obj.update(2)).toBe(2);
    expect(p.sections.get('obj')!.acc).toBe(4);
    undo();
    p.enabled = false;
    expect(obj.update(1)).toBe(3);
  });
});

function fakeRenderer(): CountedRenderer & { draw(n: number, tris: number): void; target: unknown } {
  const r = {
    target: null as unknown,
    info: {
      autoReset: true,
      render: { calls: 0, triangles: 0 },
      reset() {
        r.info.render.calls = 0;
        r.info.render.triangles = 0;
      },
    },
    setRenderTarget(t: unknown) {
      r.target = t;
    },
    render() {},
    draw(n: number, tris: number) {
      r.info.render.calls += n;
      r.info.render.triangles += tris;
    },
  };
  return r as never;
}

describe('PassCounter', () => {
  it('charges draws to the composer pass, or to the bound shadow map', () => {
    const r = fakeRenderer();
    const pc = new PassCounter(r);
    pc.attach();
    expect(r.info.autoReset).toBe(false);
    const shadowMap = {};
    pc.label(shadowMap, 'csm0');
    const scenePass = {
      name: 'RenderPass',
      render() {
        r.render({} as never, {} as never);
        r.setRenderTarget(shadowMap as never);
        r.draw(10, 1000);
        r.setRenderTarget(null);
        r.draw(30, 5000);
      },
    };
    const fx = {
      name: 'EffectPass',
      render() {
        r.draw(1, 1);
      },
    };
    pc.watchPasses([scenePass, fx]);
    scenePass.render();
    fx.render();
    pc.endFrame();
    const s = pc.snapshot();
    expect(s.passes['shadow:csm0']).toEqual({ calls: 10, triangles: 1000, ms: 0 });
    expect(s.passes.RenderPass).toEqual({ calls: 30, triangles: 5000, ms: 0 });
    expect(s.passes.EffectPass).toEqual({ calls: 1, triangles: 1, ms: 0 });
    expect(s.calls).toBe(41);
    expect(s.renders).toBe(1);
    pc.detach();
    expect(r.info.autoReset).toBe(true);
  });
});

describe('perf flags', () => {
  it('parses ?perf', () => {
    expect(perfRequested('?perf=1')).toBe(true);
    expect(perfRequested('?q=low&perf=gpu')).toBe(true);
    expect(perfRequested('?q=low')).toBe(false);
    expect(perfGpuSync('?perf=gpu')).toBe(true);
    expect(perfGpuSync('?perf=1')).toBe(false);
  });
});
