import { it } from 'vitest';
import { SEDAN_TRAFFIC } from '../sim/vehicle/defs/sedanTraffic';
it('n', () => {
  const by = new Map<string, string[]>();
  for (const n of SEDAN_TRAFFIC.body.nodes) { const k = n.id.split('_')[0]!; by.set(k, [...(by.get(k) ?? []), n.id.replace(/^[^_]*_/, '') + `@${n.pos.map((v) => v.toFixed(2)).join(',')}`]); }
  const deg = new Map<string, number>(); for (const b of SEDAN_TRAFFIC.body.beams) { deg.set(b.a, (deg.get(b.a) ?? 0) + 1); deg.set(b.b, (deg.get(b.b) ?? 0) + 1); }
  for (const [k, v] of by) if (/^s\d/.test(k)) console.log('ST', k, v.filter((x) => !x.endsWith('L')).map((x) => x.replace(/@.*/, '') + '(' + (deg.get(k + '_' + x.replace(/@.*/, '')) ?? '?') + ')').join(' '));
});
