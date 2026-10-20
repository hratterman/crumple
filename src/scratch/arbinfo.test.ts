import { it } from 'vitest';
import { BOXTRUCK } from '../sim/vehicle/defs/boxtruck';
it('arb', () => {
  const nodes = new Map((BOXTRUCK as any).body.nodes.map((n: any) => [n.id, n]));
  for (const b of (BOXTRUCK as any).body.beams) {
    if (/^arb.*_T_/.test(b.a) && /_U_|RA_kU|FA_sp/.test(b.b) || /^arb.*_T_/.test(b.b) && /_U_/.test(b.a)) console.log(b.a, b.b, 'k', b.k, 'd', b.d, 'mA', (nodes.get(b.a) as any).mass, 'mB', (nodes.get(b.b) as any).mass);
  }
  for (const b of (BOXTRUCK as any).body.beams) if (b.type === 'shock') console.log('shock', b.a, b.b, b.k, b.d);
  for (const id of ['f2_tw_L', 'f10_tw_L', 'RA_kU_L', 'FA_kT_L']) console.log(id, JSON.stringify(nodes.get(id)));
});
