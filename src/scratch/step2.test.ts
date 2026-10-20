import { it } from 'vitest';
import { BOXTRUCK } from '../sim/vehicle/defs/boxtruck';
import { runStepSteer } from '../sim/vehicle/handling';
it('step2', () => {
  const r = runStepSteer(BOXTRUCK, 0.06);
  const S = r.samples; const n = S[0]!.load.length; const out: string[] = [];
  for (let w = 0; w < n; w++) { let mn = Infinity, mnAvg = Infinity; const st = S[0]!.load[w]!; for (let i = 0; i < S.length; i++) { mn = Math.min(mn, S[i]!.load[w]!); if (i >= 9) { let a = 0; for (let j = i - 9; j <= i; j++) a += S[j]!.load[w]!; mnAvg = Math.min(mnAvg, a / 10); } } out.push(`w${w} static ${st.toFixed(0)} min ${mn.toFixed(0)} min0.1s ${mnAvg.toFixed(0)} (${(100 * mnAvg / st).toFixed(0)}%)`); }
  console.log('STEP', out.join(' | '));
}, 600000);
