import { it } from 'vitest';
import { BOXTRUCK } from '../sim/vehicle/defs/boxtruck';
import { formatTurn, runJTurn, runRampSteer, runSteadyLateral } from '../sim/vehicle/rollover';
import { runStatic, runStepSteer, runScenario } from '../sim/vehicle/handling';

const which = (process.env.ROLL ?? 'ramp,j40,j70,steady').split(',');
it('roll', () => {
  const out: string[] = [];
  if (which.includes('static')) { const s = runStatic(BOXTRUCK); out.push(`sag ${(s.sag*100).toFixed(1)} creep ${(s.creep*1000).toFixed(1)} jitter ${s.jitter.toFixed(3)}`); }
  if (which.includes('ramp')) out.push(formatTurn('ramp60', runRampSteer(BOXTRUCK)));
  if (which.includes('j40')) out.push(formatTurn('J40', runJTurn(BOXTRUCK, { speedKmh: 40 })));
  if (which.includes('j38')) out.push(formatTurn('J38', runJTurn(BOXTRUCK, { speedKmh: 38 })));
  if (which.includes('j43')) out.push(formatTurn('J43', runJTurn(BOXTRUCK, { speedKmh: 43 })));
  if (which.includes('j35')) out.push(formatTurn('J35', runJTurn(BOXTRUCK, { speedKmh: 35 })));
  if (which.includes('j46')) out.push(formatTurn('J46', runJTurn(BOXTRUCK, { speedKmh: 46 })));
  if (which.includes('j50')) out.push(formatTurn('J50', runJTurn(BOXTRUCK, { speedKmh: 50 })));
  if (which.includes('j60')) out.push(formatTurn('J60', runJTurn(BOXTRUCK, { speedKmh: 60 })));
  if (which.includes('j70')) out.push(formatTurn('J70', runJTurn(BOXTRUCK, { speedKmh: 70 })));
  if (which.includes('steady')) { const s = runSteadyLateral(BOXTRUCK, { latG: 0.35 }); out.push(`steady ${s.latG.toFixed(2)} roll ${s.rollDeg.toFixed(1)} lifted ${s.lifted}`); }
  if (which.includes('step')) { const s = runStepSteer(BOXTRUCK, 0.06); out.push(`step overshoot ${s.overshoot.toFixed(2)} latG ${s.latG.toFixed(2)} spun ${s.spun} minload ${Math.min(...s.samples.map((x) => Math.min(...x.load))).toFixed(0)}`); }
  if (which.includes('brake')) {
    const { samples } = runScenario({ def: BOXTRUCK, initialSpeed: 80 / 3.6, initialGear: 0, durationS: 8, sampleHz: 100, control: () => ({ gearSelect: 0, throttle: 0, brake: 1, steer: 0 }), stop: (s) => s.groundSpeed < 0.1 });
    let drift = 0; for (const s of samples) drift = Math.max(drift, Math.abs(s.heading - samples[0]!.heading));
    out.push(`brake80 ${samples[samples.length - 1]!.dist.toFixed(1)} m drift ${(drift * 57.3).toFixed(1)}`);
  }
  console.log(out.join('\n'));
}, 600000);
