import { it } from 'vitest';
import { BOXTRUCK } from '../sim/vehicle/defs/boxtruck';
import { createHandlingSim, runStatic } from '../sim/vehicle/handling';
it('cg', () => {
  const sim = createHandlingSim({ def: BOXTRUCK });
  sim.eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 0, handbrake: 1 });
  for (let i = 0; i < 4000; i++) sim.eng.step();
  const s = sim.eng.state; let m = 0, y = 0;
  for (let i = sim.obj.nodeStart; i < sim.obj.nodeStart + sim.obj.nodeCount; i++) { m += 1 / s.invMass[i]!; y += s.posY[i]! / s.invMass[i]!; }
  const st = runStatic(BOXTRUCK);
  console.log('restCg', (y / m).toFixed(3), 'mass', m.toFixed(0), 'sag', (st.sag * 100).toFixed(1), 'creep', (st.creep * 1000).toFixed(1), 'jitter', st.jitter.toFixed(3));
}, 600000);
