import { it } from 'vitest';
import { BOXTRUCK } from '../sim/vehicle/defs/boxtruck';
import { createHandlingSim, kinematics } from '../sim/vehicle/handling';
import { rollAngleDeg } from '../sim/vehicle/rollover';
import { createMaterialTable } from '../sim/collision/materials';
import { MaterialId } from '../protocol/messages';

it('tilt', () => {
  const sim = createHandlingSim({ def: BOXTRUCK, materialId: MaterialId.concrete });
  const eng = sim.eng;
  eng.materials = createMaterialTable({ concrete: 3 });
  eng.setInput(1, { gearSelect: 0, throttle: 0, brake: 1, handbrake: 1 });
  for (let i = 0; i < 3000; i++) eng.step();
  const W = sim.veh.wheels;
  const st = W.map((w) => 0);
  for (let i = 0; i < 500; i++) { eng.step(); W.forEach((w, k) => (st[k] += w.load / 500)); }
  const s = eng.state;
  const n0 = sim.obj.nodeStart;
  const ids = sim.cv.rig.nodeIds;
  const hub = (wid: string) => { const a = n0 + ids.indexOf(`${wid}.hubI`); const b = n0 + ids.indexOf(`${wid}.hubO`); return [(s.posX[a]! + s.posX[b]!) / 2, (s.posY[a]! + s.posY[b]!) / 2]; };
  console.log('ids sample', ids.filter((x) => x.includes('hub')).slice(0, 4).join(','));
  const g = 9.81;
  let tan = 0;
  const lines: string[] = [];
  let next = 0.3;
  const lifted = new Set<string>();
  const sum = W.map(() => 0); let cnt = 0;
  for (let tick = 0; tick < 2000 * 20; tick++) {
    tan = 0.25 + (tick / 2000) * 0.02;
    const th = Math.atan(tan);
    eng.gravityX = g * Math.sin(th); eng.gravityY = -g * Math.cos(th);
    eng.step();
    W.forEach((w, k) => (sum[k] += w.load)); cnt++;
    if (tick % 100 === 99) {
      const ld = sum.map((x) => x / cnt); sum.fill(0); cnt = 0;
      ld.forEach((l, k) => { if (l < 0.03 * st[k]! && !lifted.has(W[k]!.wheel.id)) { lifted.add(W[k]!.wheel.id); lines.push(`lift ${W[k]!.wheel.id} at tan ${tan.toFixed(3)} roll ${rollAngleDeg(sim).toFixed(1)}`); } });
      if (tan >= next) {
        next += 0.05;
        const k = kinematics(sim);
        const fr = hub('FR'), rr = hub('RR'), rri = hub('RRi'), fl = hub('FL'), rl = hub('RL');
        const grp = (re: RegExp) => { let m = 0, x = 0, y = 0; ids.forEach((id, i) => { if (re.test(id)) { const mm = 1 / s.invMass[n0 + i]!; m += mm; x += mm * s.posX[n0 + i]!; y += mm * s.posY[n0 + i]!; } }); return `${(x / m).toFixed(3)},${(y / m).toFixed(2)} (${m.toFixed(0)})`; };
        const rp = sim.cv.rig.nodePos;
        const tags = ['fc','fi_R','fi_L','fl_R','fl_L','wl_R','wl_L','wm_R','wm_L','rl_R','rl_L','rc','cg'];
        lines.push('   b3 dx: ' + tags.map((t) => { const i = ids.indexOf(`b3_${t}`); return `${t} ${(s.posX[n0 + i]! - rp[3 * i]!).toFixed(3)}/${(s.posY[n0 + i]! - rp[3 * i + 1]!).toFixed(3)}`; }).join(' '));
        const dyOf = (n: string) => { const i = ids.indexOf(n); if (i < 0) return 'NA'; return `${(s.posX[n0 + i]! - rp[3 * i]!).toFixed(3)}/${(s.posY[n0 + i]! - rp[3 * i + 1]!).toFixed(3)}`; };
        const rollAt = (st: string) => { const a = ids.indexOf(st + '_hi_R'), b = ids.indexOf(st + '_hi_L'), c = ids.indexOf(st + '_lo_R'), d = ids.indexOf(st + '_lo_L'); const dy = (s.posY[n0 + b]! + s.posY[n0 + d]! - s.posY[n0 + a]! - s.posY[n0 + c]!) / 2; const dx = (s.posX[n0 + a]! + s.posX[n0 + c]! - s.posX[n0 + b]! - s.posX[n0 + d]!) / 2; return (Math.atan2(dy, dx) * 57.3).toFixed(1); };
        lines.push('   twist: ' + Array.from({ length: 14 }, (_, i) => `f${i} ${rollAt('f' + i)}`).join(' '));
        lines.push('   frame: ' + ['f3_hi_R','f3_hi_L','f6_hi_R','f6_hi_L','f9_hi_R','f9_hi_L','f9_lo_R','f9_lo_L','f10_tw_R','f10_tw_L','RA_kU_R','RA_kU_L','FA_kT_R','FA_kT_L','f2_tw_R','f2_tw_L'].map((n) => `${n} ${dyOf(n)}`).join(' '));
        const P3 = (n: string) => { const i = ids.indexOf(n); return [s.posX[n0 + i]!, s.posY[n0 + i]!, s.posZ[n0 + i]!]; };
        const R3 = (n: string) => { const i = ids.indexOf(n); return [rp[3 * i]!, rp[3 * i + 1]!, rp[3 * i + 2]!]; };
        const dl = (a: string, b: string) => { const p = P3(a), q = P3(b), r = R3(a), t = R3(b); return (Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!) - Math.hypot(r[0]! - t[0]!, r[1]! - t[1]!, r[2]! - t[2]!)).toFixed(4); };
        lines.push('   duals: ' + ['RL.hubO','RL.hubI','RLi.hubO','RLi.hubI','RA_ae_L','RA_kU_L','RA_ab_L','RRi.hubI','RRi.hubO','RR.hubI','RR.hubO','RA_ae_R','RA_kU_R','RA_ab_R'].map((n) => `${n} ${dyOf(n)}`).join(' '));
        lines.push(`   arbR tors ${dl('arbR_T_L', 'arbR_U_R')} ${dl('arbR_T_R', 'arbR_U_L')} drop ${dl('arbR_T_L', 'RA_af_L')} ${dl('arbR_T_R', 'RA_af_R')} body ${dl('arbR_T_L', 'arbR_A_R')} ${dl('arbR_U_L','arbR_A_R')} A ${dyOf('arbR_A_L')} ${dyOf('arbR_A_R')} T ${dyOf('arbR_T_L')} ${dyOf('arbR_T_R')} | arbF tors ${dl('arbF_T_L', 'arbF_U_R')} ${dl('arbF_T_R', 'arbF_U_L')}`);
        let pl = 0, plBox = 0, tot = 0; for (let b = 0; b < sim.cv.bodyBeamCount; b++) { const g = sim.obj.beamStart + b; const a = ids[sim.cv.rig.beamA[b]!]!; if (Math.abs(s.restLen[g]! - s.restLen0[g]!) > 1e-3 * s.restLen0[g]!) { pl++; if (a.startsWith('b')) plBox++; } tot++; }
        lines.push(`   plastic ${pl} (box ${plBox}) of ${tot}`);
        lines.push(`   frame ${grp(/^f\d/)} box ${grp(/^b\d_(?!cg)/)} cargo ${grp(/_cg$/)} cab ${grp(/^c\d/)} axleF ${grp(/^FA_/)} axleR ${grp(/^RA_/)} wheels ${grp(/\./)}`);
        lines.push(`tan ${tan.toFixed(2)} roll ${rollAngleDeg(sim).toFixed(1)} cg x ${k.cx.toFixed(3)} y ${k.cy.toFixed(3)} | hubs FR ${fr.map((v) => v.toFixed(3))} RR ${rr.map((v) => v.toFixed(3))} RRi ${rri.map((v) => v.toFixed(3))} FL ${fl.map((v) => v.toFixed(3))} RL ${rl.map((v) => v.toFixed(3))} | loads ${ld.map((l, i) => (l / st[i]!).toFixed(2)).join(' ')}`);
      }
      if (Math.abs(rollAngleDeg(sim)) > 30) { lines.push(`tipped at tan ${tan.toFixed(3)}`); break; }
    }
  }
  console.log(lines.join('\n'));
}, 600000);
