import { it } from 'vitest';
import { BOXTRUCK } from '../sim/vehicle/defs/boxtruck';
import { runStepSteer } from '../sim/vehicle/handling';
it('step', () => {
  const r = runStepSteer(BOXTRUCK, Number(process.env.STEER ?? 0.06));
  console.log(`overshoot ${r.overshoot.toFixed(2)} lat ${r.latG.toFixed(3)} steadyYaw ${r.yawSteady.toFixed(3)}`);
  for (const s of r.samples) { const m = Math.min(...s.load); if (m < 1500 || Math.round(s.t * 100) % 50 === 0) console.log(`${s.t.toFixed(2)} yaw ${s.yawRate.toFixed(3)} load ${s.load.map((l) => (l / 1000).toFixed(1)).join(' ')}`); }
}, 600000);
