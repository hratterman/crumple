/**
 * Object ↔ water interaction for the surface shader: a ring buffer of
 * expanding ripple rings plus a few "contact" discs (foam + soft
 * intersection where something pierces the surface), derived on main from
 * the interpolated node positions (same precedent as the FX splashes: no
 * protocol event). Per object, a strided subset of its nodes (≤ SAMPLE_NODES)
 * is tested against each body's rectangle and a thin band around the level;
 * the touching nodes' centroid + spread drive one contact and, while it
 * moves (or on entry), a ripple every RIPPLE_INTERVAL_S. Allocation-free
 * per frame (Map entries are reused per object id).
 */
import type { WaterBody } from '../../world/types';
import type { WorldFrame } from '../types';

export const MAX_RIPPLES = 16;
export const MAX_CONTACTS = 6;
/** Ripple lifetime, s (the shader fades it out by then). */
export const RIPPLE_LIFE_S = 4;
const SAMPLE_NODES = 48;
/** Nodes within this distance of the level count as touching the surface, m. */
const BAND_M = 0.35;
const RIPPLE_INTERVAL_S = 0.35;
const RIPPLE_INTERVAL_STILL_S = 1.6;

interface Track {
  x: number;
  z: number;
  t: number;
  lastRipple: number;
  touching: boolean;
  seen: number;
}

export class WaterInteraction {
  /** vec4 per ripple: x, z, start time (s, WorldFrame.time), amplitude (0 = unused). */
  readonly ripples = new Float32Array(MAX_RIPPLES * 4);
  /** vec4 per contact: x, z, radius m, strength 0..1 (0 = unused). */
  readonly contacts = new Float32Array(MAX_CONTACTS * 4);
  contactCount = 0;
  private head = 0;
  private readonly tracks = new Map<number, Track>();
  private frameNo = 0;

  constructor(private readonly bodies: readonly WaterBody[]) {}

  /** Push one ripple (also used by tests / debug). */
  emit(x: number, z: number, time: number, amp: number): void {
    const o = this.head * 4;
    this.ripples[o] = x;
    this.ripples[o + 1] = z;
    this.ripples[o + 2] = time;
    this.ripples[o + 3] = amp;
    this.head = (this.head + 1) % MAX_RIPPLES;
  }

  update(frame: WorldFrame): void {
    this.frameNo++;
    this.contactCount = 0;
    this.contacts.fill(0);
    if (!frame.interpolated || this.bodies.length === 0) return;
    const nodes = frame.nodes;
    const t = frame.time;
    for (const obj of frame.objects) {
      if (obj.nodeCount <= 0) continue;
      const stride = Math.max(1, Math.floor(obj.nodeCount / SAMPLE_NODES));
      let n = 0;
      let sx = 0;
      let sz = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      let body: WaterBody | null = null;
      for (let i = 0; i < obj.nodeCount; i += stride) {
        const o = (obj.nodeOffset + i) * 3;
        const x = nodes[o]!;
        const y = nodes[o + 1]!;
        const z = nodes[o + 2]!;
        const b = bodyAt(this.bodies, x, z);
        if (!b || Math.abs(y - b.level) > BAND_M) continue;
        body = b;
        n++;
        sx += x;
        sz += z;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      let tr = this.tracks.get(obj.objectId);
      if (n === 0 || !body) {
        if (tr) tr.touching = false;
        continue;
      }
      const cx = sx / n;
      const cz = sz / n;
      const radius = 0.5 * Math.max(maxX - minX, maxZ - minZ) + 0.4;
      if (!tr) {
        tr = { x: cx, z: cz, t, lastRipple: -1e9, touching: false, seen: this.frameNo };
        this.tracks.set(obj.objectId, tr);
      }
      const dt = Math.max(1e-3, t - tr.t);
      const speed = Math.sqrt((cx - tr.x) ** 2 + (cz - tr.z) ** 2) / dt;
      const entering = !tr.touching;
      const interval = speed > 0.4 ? RIPPLE_INTERVAL_S : RIPPLE_INTERVAL_STILL_S;
      if (entering || t - tr.lastRipple >= interval) {
        const amp = Math.min(1, 0.25 + 0.12 * speed + (entering ? 0.5 : 0)) * Math.min(1, 0.3 + n / 12);
        // rings start at the object's footprint edge
        this.emit(cx, cz, t - radius / RIPPLE_SPEED_MS, amp);
        tr.lastRipple = t;
      }
      tr.x = cx;
      tr.z = cz;
      tr.t = t;
      tr.touching = true;
      tr.seen = this.frameNo;
      if (this.contactCount < MAX_CONTACTS) {
        const o = this.contactCount++ * 4;
        this.contacts[o] = cx;
        this.contacts[o + 1] = cz;
        this.contacts[o + 2] = radius;
        this.contacts[o + 3] = Math.min(1, 0.4 + n / 16 + 0.1 * speed);
      }
    }
    // forget objects that left (despawned) long ago
    if ((this.frameNo & 255) === 0) {
      for (const [id, tr] of this.tracks) if (this.frameNo - tr.seen > 600) this.tracks.delete(id);
    }
  }
}

/** Ripple ring phase speed, m/s (shared with the shader). */
export const RIPPLE_SPEED_MS = 1.1;

function bodyAt(bodies: readonly WaterBody[], x: number, z: number): WaterBody | null {
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!;
    if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return b;
  }
  return null;
}
