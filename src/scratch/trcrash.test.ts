import { it } from 'vitest';
import { SEDAN_TRAFFIC, SEDAN_TRAFFIC_CRASH_PROBES } from '../sim/vehicle/defs/sedanTraffic';
import { runCrash } from '../sim/vehicle/crash';
it('tr', () => {
  const out: string[] = [];
  for (const [kind, kmh, ov] of [['frontal', 47.5, 1], ['frontal', 50, 1], ['frontal', 52.5, 1], ['offset', 50, 0.9], ['offset', 50, 0.8]] as const) {
    const r = runCrash({ kind, speedKmh: kmh, overlap: ov, def: SEDAN_TRAFFIC, probes: SEDAN_TRAFFIC_CRASH_PROBES });
    out.push(`${kind}${kmh}/${ov}: crush ${(r.crush * 100).toFixed(1)} (max ${(r.crushMax * 100).toFixed(1)}) intr ${(r.intrusion * 100).toFixed(1)} vLate ${r.maxSpeedLate.toFixed(1)} finite ${r.finite}`);
  }
  console.log('TR', out.join(' | '));
}, 900000);
