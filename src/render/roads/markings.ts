/**
 * Per-station marking decisions (pure): where centre lines may be dashed.
 *
 *  - double-yellow roads (mountain): each direction's line is dashed only
 *    where that direction sees no tight bend within PASS_SIGHT_M ahead
 *    (forward traffic looks +s, oncoming −s) → classic asymmetric passing
 *    zones; zones shorter than MIN_ZONE_M are dropped.
 *  - single centre line (country / street, contract 'center'): dashed,
 *    solid where |κ| > 1/120 within ±NO_PASS_SPREAD_M ("no passing" bends).
 *  - highway: double yellow, both solid (flags 0).
 */
import { ROAD_STATION_STRIDE, RoadStation, type RoadProfile } from '../../world/types';
import type { RoadStyle } from './styles';

export const PASS_SIGHT_M = 140;
export const PASS_KAPPA = 1 / 160;
export const NO_PASS_KAPPA = 1 / 120;
export const NO_PASS_SPREAD_M = 20;
export const MIN_ZONE_M = 60;
/** Open road ends (and so junction approaches at ends) stay solid this far in. */
export const END_SOLID_M = 30;

export interface PassingFlags {
  /** 1 = forward-direction (right-of-centre) line dashed. */
  passR: Float32Array;
  /** 1 = oncoming-direction (left-of-centre) line dashed. */
  passL: Float32Array;
}

function absKappa(p: RoadProfile): Float64Array {
  const k = new Float64Array(p.stationCount);
  for (let i = 0; i < p.stationCount; i++) {
    k[i] = Math.abs(p.stations[i * ROAD_STATION_STRIDE + RoadStation.curvature]!);
  }
  return k;
}

/** Windowed max of k over station offsets [lo, hi] (wraps on closed roads). */
function windowMax(k: Float64Array, closed: boolean, lo: number, hi: number): Float64Array {
  const n = k.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let o = lo; o <= hi; o++) {
      let j = i + o;
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      const v = k[j]!;
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}

function dropShortZones(flags: Float32Array, closed: boolean, minStations: number): void {
  const n = flags.length;
  let i = 0;
  while (i < n) {
    if (flags[i]! < 0.5) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && flags[j]! >= 0.5) j++;
    const wrapsWhole = closed && i === 0 && j === n;
    if (!wrapsWhole && j - i < minStations && !(closed && (i === 0 || j === n))) flags.fill(0, i, j);
    i = j;
  }
}

export function computePassing(p: RoadProfile, style: RoadStyle, spacing: number): PassingFlags {
  const n = p.stationCount;
  const passR = new Float32Array(n);
  const passL = new Float32Array(n);
  if (style === 'highway' || style === 'arena' || style === 'dirt') return { passR, passL };
  const k = absKappa(p);
  if (style === 'mountain') {
    const sight = Math.round(PASS_SIGHT_M / spacing);
    const ahead = windowMax(k, p.closed, 0, sight);
    const behind = windowMax(k, p.closed, -sight, 0);
    for (let i = 0; i < n; i++) {
      passR[i] = ahead[i]! < PASS_KAPPA ? 1 : 0;
      passL[i] = behind[i]! < PASS_KAPPA ? 1 : 0;
    }
  } else {
    const spread = Math.round(NO_PASS_SPREAD_M / spacing);
    const near = windowMax(k, p.closed, -spread, spread);
    for (let i = 0; i < n; i++) passR[i] = passL[i] = near[i]! < NO_PASS_KAPPA ? 1 : 0;
  }
  if (!p.closed) {
    const e = Math.min(n, Math.round(END_SOLID_M / spacing));
    for (let i = 0; i < e; i++) {
      passR[i] = passL[i] = 0;
      passR[n - 1 - i] = passL[n - 1 - i] = 0;
    }
  }
  const minSt = Math.round(MIN_ZONE_M / spacing);
  dropShortZones(passR, p.closed, minSt);
  dropShortZones(passL, p.closed, minSt);
  return { passR, passL };
}
