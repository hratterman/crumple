import { describe, expect, it } from 'vitest';

import { formatPerf } from './perfOverlay';

describe('perf overlay text', () => {
  it('lists fps, draws per pass and the CPU sections', () => {
    const txt = formatPerf({
      profile: { fps: 59.8, frameMs: 16.7, frameMaxMs: 21, cpuMs: 3.2, cpuMaxMs: 5, sections: { terrain: { avg: 0.4, max: 1.2 } } },
      gpu: { calls: 412, triangles: 1_250_000, renders: 1, passes: { RenderPass: { calls: 300, triangles: 900_000, ms: 0 } } },
      extra: { quality: 'high ×1.00' },
    });
    expect(txt).toContain('59.8 fps');
    expect(txt).toContain('draws 412');
    expect(txt).toContain('1.25M');
    expect(txt).toMatch(/RenderPass\s+300/);
    expect(txt).toMatch(/terrain\s+0\.40\s+1\.20/);
    expect(txt).toContain('quality: high ×1.00');
  });
});
