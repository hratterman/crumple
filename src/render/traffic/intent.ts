/**
 * AI intent → lamps (P6 T2): the traffic record's flags as a LightState
 * (the soft-body visual's `lights` override) and as ghost lamp levels.
 * Indicators / hazards blink TRAFFIC_BLINK_ON_S / _OFF_S with a per-agent
 * phase (real cars are never in sync), the same function for the ghost and
 * the soft body, so a hand-over never restarts a blink.
 */
import {
  TRAFFIC_FLAG_BRAKE,
  TRAFFIC_FLAG_HAZARD,
  TRAFFIC_FLAG_HEADLIGHTS,
  TRAFFIC_FLAG_INDICATOR_L,
  TRAFFIC_FLAG_INDICATOR_R,
  TRAFFIC_FLAG_REVERSE,
} from '../../protocol/traffic';
import { TRAFFIC_BLINK_OFF_S, TRAFFIC_BLINK_ON_S, type LightState } from '../vehicle/types';

/** Blink lamp on at wall-clock `time` (s) for agent `agent`. */
export function blinkOn(time: number, agent: number): boolean {
  const period = TRAFFIC_BLINK_ON_S + TRAFFIC_BLINK_OFF_S;
  // golden-ratio phase spread over agents
  const phase = ((agent * 0.618034) % 1) * period;
  const t = (((time + phase) % period) + period) % period;
  return t < TRAFFIC_BLINK_ON_S;
}

/** Lamps of a traffic agent this frame (`out` reused). Brake from the record's lamp intensity. */
export function trafficLights(flags: number, brake: number, agent: number, time: number, out: LightState): LightState {
  const on = blinkOn(time, agent);
  const hazard = (flags & TRAFFIC_FLAG_HAZARD) !== 0;
  out.head = (flags & TRAFFIC_FLAG_HEADLIGHTS) !== 0;
  out.highBeam = false;
  out.fog = false;
  out.brake = (flags & TRAFFIC_FLAG_BRAKE) !== 0 ? Math.min(1, Math.max(0.6, 0.6 + brake)) : 0;
  out.reverse = (flags & TRAFFIC_FLAG_REVERSE) !== 0;
  out.indicatorL = on && (hazard || (flags & TRAFFIC_FLAG_INDICATOR_L) !== 0);
  out.indicatorR = on && (hazard || (flags & TRAFFIC_FLAG_INDICATOR_R) !== 0);
  return out;
}
