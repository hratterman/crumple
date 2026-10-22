import type { SimEngine } from '../../src/sim/engine';

/** FNV-1a over every used node's position + velocity (f64 bits) and every beam's rest length / k / active. */
export function stateHashOf(eng: SimEngine): number {
  let h = 0x811c9dc5;
  const f = new Float64Array(1);
  const u = new Uint32Array(f.buffer);
  const word = (x: number): void => {
    f[0] = x;
    h = Math.imul(h ^ u[0]!, 0x01000193) >>> 0;
    h = Math.imul(h ^ u[1]!, 0x01000193) >>> 0;
  };
  const s = eng.state;
  for (let i = 0; i < s.nodeCount; i++) {
    word(s.posX[i]!);
    word(s.posY[i]!);
    word(s.posZ[i]!);
    word(s.velX[i]!);
    word(s.velY[i]!);
    word(s.velZ[i]!);
  }
  for (let b = 0; b < s.beamCount; b++) {
    word(s.restLen[b]!);
    word(s.k[b]!);
    word(s.active[b]!);
  }
  return h >>> 0;
}
