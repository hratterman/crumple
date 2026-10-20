import { it } from 'vitest';
import { BOXTRUCK } from '../sim/vehicle/defs/boxtruck';
import { buildVehicleRig } from '../sim/vehicle/builder';
it('k', () => {
  const r = buildVehicleRig(BOXTRUCK);
  const id = process.env.NID ?? 'RA_kU_L';
  console.log(Object.keys(r), JSON.stringify(r.nodes[0]), r.nodes.filter((x) => x.id.includes('kU')).map((x) => x.id).join(','));
  const n = r.nodes.find((x) => x.id === id)!;
  let sk = 0; const rows: string[] = [];
  for (const b of r.beams) if (b.a === id || b.b === id) { sk += b.k ?? 0; rows.push(`${b.a}-${b.b} ${b.type} k ${b.k} d ${b.d}`); }
  console.log(id, 'mass', n.mass, 'sumK', sk, 'wdt', Math.sqrt(sk / n.mass!) / 2000, '\n' + rows.join('\n'));
  let cg = 0, m = 0; for (const x of r.nodes) { if (/^arb/.test(x.id)) console.log(x.id, x.mass); }
});
