import { it } from 'vitest';
import { BOXTRUCK_VISUAL } from '../render/vehicle/defs/boxtruck';
import { tessellateVehicle } from '../render/vehicle/loft';
it('rn', () => {
  for (const g of tessellateVehicle(BOXTRUCK_VISUAL)) { let bad = 0; for (let i = 0; i < g.normal.length; i += 3) if (Math.abs(Math.hypot(g.normal[i]!, g.normal[i + 1]!, g.normal[i + 2]!) - 1) > 1e-4) bad++; if (bad) console.log('BAD', g.panelId, bad, g.normal.length / 3); }
});
