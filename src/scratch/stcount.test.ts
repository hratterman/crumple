import { it } from 'vitest';
import { SEDAN_TRAFFIC } from '../sim/vehicle/defs/sedanTraffic';
import { validateVehicle } from '../sim/vehicle/builder';
it('count', () => {
  const B = SEDAN_TRAFFIC.body.beams; const st = (id: string) => { const m = /^s(\d+)_/.exec(id); return m ? Number(m[1]) : -1; };
  const cat = new Map<string, number>();
  for (const b of B) { const a = st(b.a), c = st(b.b); let k: string; if (a < 0 || c < 0) k = 'other:' + (a < 0 ? b.a : b.b).replace(/[_.].*/, ''); else if (a === c) k = `in s${a}`; else if (Math.abs(a - c) === 1) k = `gap ${Math.min(a, c)}`; else k = 'span'; cat.set(k, (cat.get(k) ?? 0) + 1); }
  const vv = validateVehicle(SEDAN_TRAFFIC); console.log('ERRS', vv.errors.slice(0, 3).join(' ; ')); console.log('BODY', B.length, 'total', vv.stats.beamCount, 'nodes', SEDAN_TRAFFIC.body.nodes.length);
  console.log([...cat].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join(' '));
});
