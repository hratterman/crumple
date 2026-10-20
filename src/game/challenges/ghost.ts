/**
 * Ghost runs (types.ts GHOST TRACK): 30 Hz pose keyframes recorded in run
 * time, compact base64 encoding for the PB store, and an allocation-free
 * sampler (linear position, normalized-lerp quaternion) for playback.
 * Also the PB input slice codec (from the P7 ReplayFile input log).
 */
import type { ReplayInputLog } from '../../protocol/replay';
import { GHOST_HZ, type GhostTrack } from './types';

/** Longest ghost kept (s): 10 minutes. */
export const GHOST_MAX_S = 600;
/** PB input slices larger than this (base64 chars) are not stored. */
export const INPUTS_MAX_CHARS = 48 * 1024;

export class GhostRecorder {
  private pos = new Float32Array(3 * 64);
  private quat = new Int16Array(4 * 64);
  private n = 0;

  constructor(
    readonly vehicle: string,
    readonly palette: string | null,
    readonly hz = GHOST_HZ,
  ) {}

  get count(): number {
    return this.n;
  }

  reset(): void {
    this.n = 0;
  }

  /**
   * Offers a pose at run time `t` (s since GO): every keyframe slot k with
   * k / hz ≤ t not yet filled takes this pose (keyframe k = the first pose
   * at or after k / hz, ≤ one snapshot late: 8 ms at 120 Hz; a gap of
   * several slots repeats it, so frame index ↔ time stays exact).
   */
  offer(t: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): void {
    const l = Math.hypot(qx, qy, qz, qw) || 1;
    const max = GHOST_MAX_S * this.hz;
    while (this.n / this.hz <= t && this.n < max) {
      if (3 * (this.n + 1) > this.pos.length) {
        const p = new Float32Array(this.pos.length * 2);
        p.set(this.pos);
        this.pos = p;
        const q = new Int16Array(this.quat.length * 2);
        q.set(this.quat);
        this.quat = q;
      }
      const i = this.n++;
      this.pos[3 * i] = px;
      this.pos[3 * i + 1] = py;
      this.pos[3 * i + 2] = pz;
      this.quat[4 * i] = Math.round((qx / l) * 32767);
      this.quat[4 * i + 1] = Math.round((qy / l) * 32767);
      this.quat[4 * i + 2] = Math.round((qz / l) * 32767);
      this.quat[4 * i + 3] = Math.round((qw / l) * 32767);
    }
  }

  track(): GhostTrack {
    return {
      hz: this.hz,
      vehicle: this.vehicle,
      palette: this.palette,
      count: this.n,
      pos: this.pos.slice(0, 3 * this.n),
      quat: this.quat.slice(0, 4 * this.n),
    };
  }
}

// ------------------------------------------------------------ base64
function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const GHOST_MAGIC = 0x47483031; // 'GH01'

/** Binary: u32 magic, u32 hz, u32 count, u16 vehicle len + utf8, u16 palette len + utf8 (0 = null), pad to 4, f32 pos[3n], i16 quat[4n]. */
export function encodeGhost(g: GhostTrack): string {
  const enc = new TextEncoder();
  const v = enc.encode(g.vehicle);
  const p = enc.encode(g.palette ?? '');
  let head = 12 + 2 + v.length + 2 + p.length;
  head = (head + 3) & ~3;
  const bytes = new Uint8Array(head + 12 * g.count + 8 * g.count);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, GHOST_MAGIC, true);
  dv.setUint32(4, g.hz, true);
  dv.setUint32(8, g.count, true);
  dv.setUint16(12, v.length, true);
  bytes.set(v, 14);
  dv.setUint16(14 + v.length, g.palette === null ? 0xffff : p.length, true);
  bytes.set(p, 16 + v.length);
  for (let i = 0; i < 3 * g.count; i++) dv.setFloat32(head + 4 * i, g.pos[i]!, true);
  const q0 = head + 12 * g.count;
  for (let i = 0; i < 4 * g.count; i++) dv.setInt16(q0 + 2 * i, g.quat[i]!, true);
  return toBase64(bytes);
}

/** Inverse of encodeGhost; null on anything malformed. */
export function decodeGhost(b64: string): GhostTrack | null {
  try {
    const bytes = fromBase64(b64);
    const dv = new DataView(bytes.buffer);
    if (bytes.length < 16 || dv.getUint32(0, true) !== GHOST_MAGIC) return null;
    const hz = dv.getUint32(4, true);
    const count = dv.getUint32(8, true);
    const vl = dv.getUint16(12, true);
    const dec = new TextDecoder();
    const vehicle = dec.decode(bytes.subarray(14, 14 + vl));
    const plRaw = dv.getUint16(14 + vl, true);
    const pl = plRaw === 0xffff ? 0 : plRaw;
    const palette = plRaw === 0xffff ? null : dec.decode(bytes.subarray(16 + vl, 16 + vl + pl));
    let head = 12 + 2 + vl + 2 + pl;
    head = (head + 3) & ~3;
    if (!(hz > 0) || bytes.length < head + 20 * count) return null;
    const pos = new Float32Array(3 * count);
    const quat = new Int16Array(4 * count);
    for (let i = 0; i < 3 * count; i++) pos[i] = dv.getFloat32(head + 4 * i, true);
    const q0 = head + 12 * count;
    for (let i = 0; i < 4 * count; i++) quat[i] = dv.getInt16(q0 + 2 * i, true);
    return { hz, vehicle, palette, count, pos, quat };
  } catch {
    return null;
  }
}

/** Ghost pose at run time t (clamped to the track): position + unit quaternion [x, y, z, w]. False for an empty track. */
export function sampleGhost(g: GhostTrack, t: number, outPos: number[] | Float32Array, outQuat: number[] | Float32Array): boolean {
  if (g.count === 0) return false;
  let f = t * g.hz;
  if (!(f > 0)) f = 0;
  const last = g.count - 1;
  if (f > last) f = last;
  const i = Math.floor(f);
  const j = i < last ? i + 1 : i;
  const u = f - i;
  for (let k = 0; k < 3; k++) outPos[k] = g.pos[3 * i + k]! + (g.pos[3 * j + k]! - g.pos[3 * i + k]!) * u;
  // nlerp on the shorter arc
  let d = 0;
  for (let k = 0; k < 4; k++) d += g.quat[4 * i + k]! * g.quat[4 * j + k]!;
  const s = d < 0 ? -1 : 1;
  let l = 0;
  for (let k = 0; k < 4; k++) {
    const a = g.quat[4 * i + k]! / 32767;
    const b = (s * g.quat[4 * j + k]!) / 32767;
    const v = a + (b - a) * u;
    outQuat[k] = v;
    l += v * v;
  }
  l = Math.sqrt(l) || 1;
  for (let k = 0; k < 4; k++) outQuat[k] = outQuat[k]! / l;
  return true;
}

/** Ghost duration, s. */
export function ghostDuration(g: GhostTrack): number {
  return g.count > 0 ? (g.count - 1) / g.hz : 0;
}

// ------------------------------------------------------------ PB input slice
const INPUT_MAGIC = 0x494e3031; // 'IN01'

/**
 * The input entries of `objectId` with goTick ≤ tick ≤ endTick, ticks
 * relative to goTick: u32 magic, u32 count, then per entry u32 Δtick, u8
 * action, f32 value (9 B). Null when the slice is larger than INPUTS_MAX_CHARS.
 */
export function encodeInputs(log: ReplayInputLog, objectId: number, goTick: number, endTick: number): string | null {
  let n = 0;
  for (let i = 0; i < log.count; i++) if (log.objectId[i] === objectId && log.tick[i]! >= goTick && log.tick[i]! <= endTick) n++;
  const bytes = new Uint8Array(8 + 9 * n);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, INPUT_MAGIC, true);
  dv.setUint32(4, n, true);
  let o = 8;
  for (let i = 0; i < log.count; i++) {
    if (log.objectId[i] !== objectId || log.tick[i]! < goTick || log.tick[i]! > endTick) continue;
    dv.setUint32(o, log.tick[i]! - goTick, true);
    dv.setUint8(o + 4, log.action[i]!);
    dv.setFloat32(o + 5, log.value[i]!, true);
    o += 9;
  }
  const s = toBase64(bytes);
  return s.length <= INPUTS_MAX_CHARS ? s : null;
}

export function decodeInputs(b64: string): { tick: number; action: number; value: number }[] | null {
  try {
    const bytes = fromBase64(b64);
    const dv = new DataView(bytes.buffer);
    if (bytes.length < 8 || dv.getUint32(0, true) !== INPUT_MAGIC) return null;
    const n = dv.getUint32(4, true);
    if (bytes.length < 8 + 9 * n) return null;
    const out: { tick: number; action: number; value: number }[] = [];
    for (let i = 0, o = 8; i < n; i++, o += 9) out.push({ tick: dv.getUint32(o, true), action: dv.getUint8(o + 4), value: dv.getFloat32(o + 5, true) });
    return out;
  } catch {
    return null;
  }
}
