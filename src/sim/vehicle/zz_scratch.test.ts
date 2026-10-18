import { it } from 'vitest';
import { SEDAN, SEDAN_DESIGN } from './defs/sedan';
import { validateVehicle, buildVehicleRig } from './builder';
import { compileRig, computeStabilityReport } from '../rig/builder';
it('scratch', () => {
  const r = validateVehicle(SEDAN);
  console.log(JSON.stringify(SEDAN_DESIGN, null, 1));
  console.log('errors', r.errors, 'warnings', r.warnings);
  console.log('stats', r.stats.nodeCount, r.stats.beamCount, r.stats.totalMass, r.massDriftPct);
  const c = compileRig(buildVehicleRig(SEDAN));
  const st = computeStabilityReport(c);
  console.log('worst', st.worst);
  let maxD = 0; let idD = '';
  for (let i = 0; i < c.nodeCount; i++) if (st.dampDt[i]! > maxD) { maxD = st.dampDt[i]!; idD = c.nodeIds[i]!; }
  console.log('maxDamp', maxD, idD);
  const masses = SEDAN.body.nodes.map(n => [n.id, n.mass] as const).sort((a,b)=>a[1]-b[1]);
  console.log('lightest', masses.slice(0,5), 'heaviest', masses.slice(-5));
  const ks = SEDAN.body.beams.map(b => b.k!).sort((a,b)=>a-b);
  console.log('k range', ks[0], ks[Math.floor(ks.length/2)], ks[ks.length-1]);
  console.log('steer', SEDAN.steering, SEDAN.body.beams.filter(b=>b.type==='hydro' || b.type==='shock'));
});
