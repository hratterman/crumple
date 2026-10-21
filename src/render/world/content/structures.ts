/**
 * Bridges, tunnels and lamp standards (R-WORLD render). Drawn from the SAME
 * content colliders the worker installs (what you see is what you hit) plus
 * the structure records for the parts that never collide (tunnel arch lining,
 * portals + wing walls, parapet rails, lamp standards, light fittings).
 * Everything merged per material: ≤ 6 draws for every structure on the map.
 */
import type { RoadProfile, ResolvedCollider } from '../../../world/types';
import type { StructureInstance, WorldLight } from '../../../world/content/types';
import { createRoadSample, sampleRoad } from '../../../world/roads';
import { add, cross, Geo, norm, qrot, scale, sub, type V3 } from './geo';

export interface StructureGeos {
  concrete: Geo;
  concreteDark: Geo;
  tile: Geo;
  steel: Geo;
  lamp: Geo;
  /** Shadow-only slab over every tunnel bore (the ridge drawn over it does not cast into the cascades). */
  shade: Geo;
}

export function newStructureGeos(): StructureGeos {
  return { concrete: new Geo(), concreteDark: new Geo(), tile: new Geo(), steel: new Geo(), lamp: new Geo(), shade: new Geo() };
}

/** Collider-driven parts: deck slabs, parapets (+ steel top rail and posts), piers, tunnel walkways. */
export function addStructureColliders(g: StructureGeos, colliders: readonly ResolvedCollider[]): void {
  for (const c of colliders) {
    const [hx, hy, hz] = c.size;
    switch (c.visual) {
      case 'deckSlab':
        // Deck: top face in the ribbon's colour range is hidden under the ribbon; sides + soffit dark.
        g.concreteDark.box(c.pos, c.quat, hx, hy, hz, 63 & ~4);
        g.concrete.box(add(c.pos, qrot(c.quat, [0, hy - 0.02, 0])), c.quat, hx, 0.02, hz, 4);
        // Edge beams (drip edges) slightly proud of the slab.
        for (const s of [-1, 1]) g.concrete.box(add(c.pos, qrot(c.quat, [s * (hx + 0.06), hy * 0.35, 0])), c.quat, 0.08, hy * 0.6, hz, 63 & ~(s > 0 ? 2 : 1));
        break;
      case 'railing': {
        // Concrete New-Jersey-ish parapet to 0.85 m (inside the collider), steel rail on posts at 1.0 m.
        const base = add(c.pos, qrot(c.quat, [0, -hy, 0]));
        const wallH = 0.85 + 0.2; // the collider reaches 0.2 below the deck surface
        g.concrete.box(add(base, qrot(c.quat, [0, wallH / 2, 0])), c.quat, hx * 0.9, wallH / 2, hz);
        const railY = 2 * hy - 0.06;
        const a = add(base, qrot(c.quat, [0, railY, -hz]));
        const b = add(base, qrot(c.quat, [0, railY, hz]));
        g.steel.cylinder(a, b, 0.045, 8, false);
        const posts = Math.max(1, Math.round((2 * hz) / 2.2));
        for (let k = 0; k <= posts; k++) {
          const z = -hz + (2 * hz * k) / posts;
          g.steel.cylinder(add(base, qrot(c.quat, [0, wallH, z])), add(base, qrot(c.quat, [0, railY, z])), 0.03, 6, false);
        }
        break;
      }
      case 'pier':
        g.concrete.box(c.pos, c.quat, hx, hy, hz, 63 & ~4);
        // Pier cap: wider head under the soffit.
        g.concrete.box(add(c.pos, qrot(c.quat, [0, hy - 0.35, 0])), c.quat, hx + 0.25, 0.35, hz + 0.25);
        break;
      case 'kerb':
        // Tunnel service walkways (the town kerbs are drawn as strips by the town module).
        if (c.id.startsWith('w:tn:')) g.concrete.box(c.pos, c.quat, hx, hy, hz, 63 & ~8);
        break;
      default:
        break;
    }
  }
}

const SMP = createRoadSample();

/** Road frame helper (centre at the surface + up / right incl. bank, unit forward 3D). */
function frame(p: RoadProfile, s: number): { o: V3; r: V3; u: V3; f: V3 } {
  sampleRoad(p, s, SMP);
  const o: V3 = [SMP.x, SMP.y, SMP.z];
  sampleRoad(p, Math.min(s + 1, p.length), SMP);
  const o2: V3 = [SMP.x, SMP.y, SMP.z];
  sampleRoad(p, Math.max(s - 1, 0), SMP);
  const o0: V3 = [SMP.x, SMP.y, SMP.z];
  sampleRoad(p, s, SMP);
  const f = norm(sub(o2, o0));
  const r = norm([SMP.rx, SMP.bank, SMP.rz]);
  const u = norm(cross(r, f));
  return { o, r, u, f };
}

/** Tunnel arch section (x lateral, y up from the road centre surface), CCW seen along travel so normals face in. */
function archSection(wall: number, clear: number): [number, number][] {
  // Right bottom → up the right wall → over the crown → down the left wall: the sweep's winding
  // normal is the section's LEFT normal, i.e. pointing into the bore.
  const w = wall - 0.42;
  const spring = clear - 2.2;
  const pts: [number, number][] = [[w, -0.25], [w, spring]];
  const n = 10;
  for (let k = 1; k < n; k++) {
    const a = (Math.PI * k) / n;
    pts.push([Math.cos(a) * w, spring + Math.sin(a) * (clear - spring)]);
  }
  pts.push([-w, spring], [-w, -0.25]);
  return pts;
}

/** Tunnel lining, portals + wing walls; bridge abutment walls. */
export function addStructureRecords(g: StructureGeos, records: readonly StructureInstance[], roads: readonly RoadProfile[]): void {
  for (const st of records) {
    const p = roads.find((r) => r.id === st.road);
    if (!p || st.s0 === undefined || st.s1 === undefined) continue;
    const prm = st.params ?? {};
    if (st.kind === 'tunnel') {
      const wall = prm.wall ?? 6;
      const clear = prm.clear ?? 6.4;
      const sec = archSection(wall, clear);
      const path: V3[] = [];
      const rights: V3[] = [];
      const ups: V3[] = [];
      const n = Math.max(2, Math.ceil((st.s1 - st.s0) / 4));
      for (let k = 0; k <= n; k++) {
        const fr = frame(p, st.s0 + ((st.s1 - st.s0) * k) / n);
        path.push(fr.o);
        rights.push(fr.r);
        ups.push(fr.u);
      }
      g.tile.sweep(sec, path, rights, ups, false, true);
      // Sun blocker: a slab from the crown up 12 m, 6 m wider than the bore, portal to portal.
      for (let k = 0; k < n; k++) {
        const a = path[k]!;
        const b = path[k + 1]!;
        const mid = scale(add(a, b), 0.5);
        const f = norm(sub(b, a));
        const r = rights[k]!;
        const u = norm(cross(r, f));
        const q = quatFromFrame(r, u, scale(f, -1));
        const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        g.shade.box(add(mid, scale(u, clear + 7)), q, wall + 6, 6, len / 2 + 0.2);
      }
      // Portals: a headwall frame around the arch + wing walls splaying out along the cutting.
      for (const [s, dir] of [
        [st.s0, -1],
        [st.s1, 1],
      ] as const) {
        const fr = frame(p, s);
        const out = scale(fr.f, dir);
        const W = wall + 7;
        const H = clear + 5.5;
        const thick = 1.4;
        const at = (x: number, y: number, t: number): V3 => add(add(fr.o, add(scale(fr.r, x), scale(fr.u, y))), scale(out, t));
        // Frame: map every arch point radially onto the outer rectangle; front + back faces + top.
        const cx = 0;
        const cy = clear - 2.2;
        const ring = sec.map(([x, y]) => [x * 1.0 + Math.sign(x) * 0.05, y] as [number, number]);
        const outer = ring.map(([x, y]) => {
          const dx = x - cx;
          const dy = y - cy;
          let t = Infinity;
          if (dx > 1e-6) t = Math.min(t, (W - cx) / dx);
          if (dx < -1e-6) t = Math.min(t, (-W - cx) / dx);
          if (dy > 1e-6) t = Math.min(t, (H - cy) / dy);
          if (dy < -1e-6) t = Math.min(t, (-0.5 - cy) / dy);
          return [cx + dx * t, cy + dy * t] as [number, number];
        });
        for (const [t, flip] of [
          [thick, dir > 0],
          [0.02, dir < 0],
        ] as const) {
          for (let k = 0; k + 1 < ring.length; k++) {
            const a = at(ring[k]![0], ring[k]![1], t);
            const b = at(ring[k + 1]![0], ring[k + 1]![1], t);
            const c = at(outer[k + 1]![0], outer[k + 1]![1], t);
            const d = at(outer[k]![0], outer[k]![1], t);
            if (flip) g.concrete.poly([a, b, c, d]);
            else g.concrete.poly([d, c, b, a]);
          }
        }
        // Outer corners the radial map skips (top-left / top-right) + the coping.
        const q = quatFromFrame(fr.r, fr.u, out);
        g.concrete.box(at(0, H + 0.3, thick / 2), q, W + 0.3, 0.3, thick / 2 + 0.15);
        for (const sx of [-1, 1]) {
          g.concrete.box(at(sx * (W - 1.2), (H - 0.5) / 2, thick / 2), q, 1.2, (H + 0.5) / 2, thick / 2);
          // Wing wall: 22 m long, tapering from the portal height to 2 m, splayed 18°.
          const len = 22;
          const base = at(sx * W, 0, thick);
          const splay = norm(add(scale(out, 0.95), scale(fr.r, sx * 0.31)));
          const end = add(base, scale(splay, len));
          const hb = H;
          const he = 2;
          const side = norm(cross(fr.u, splay));
          const o = scale(side, 0.45);
          const A = add(base, o);
          const B = add(end, o);
          const C = add(add(end, scale(fr.u, he)), o);
          const D = add(add(base, scale(fr.u, hb)), o);
          const A2 = sub(base, o);
          const B2 = sub(end, o);
          const C2 = sub(add(end, scale(fr.u, he)), o);
          const D2 = sub(add(base, scale(fr.u, hb)), o);
          g.concrete.poly([A, B, C, D]);
          g.concrete.poly([B2, A2, D2, C2]);
          g.concrete.poly([D, C, C2, D2]);
          g.concrete.poly([B, B2, C2, C]);
        }
      }
    }
  }
}

/** Row-vector frame (right, up, back = out) → quat (rotation with columns r, u, out). */
function quatFromFrame(r: V3, u: V3, b: V3): [number, number, number, number] {
  const m00 = r[0];
  const m10 = r[1];
  const m20 = r[2];
  const m01 = u[0];
  const m11 = u[1];
  const m21 = u[2];
  const m02 = b[0];
  const m12 = b[1];
  const m22 = b[2];
  const tr = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Lamp standards for street lights (pole from the ground / deck to the head, an outreach arm, the luminaire) + tunnel fittings. */
export function addLights(g: StructureGeos, lights: readonly WorldLight[], groundAt: (x: number, z: number) => number): void {
  for (const l of lights) {
    if (l.kind === 'tunnel') {
      // Fitting: a slim box on the lining aimed down-in.
      const d = norm([l.dir[0], 0, l.dir[2]]);
      const q = quatFromFrame(norm(cross([0, 1, 0], d)), [0, 1, 0], d);
      g.steel.box(l.pos, q, 0.6, 0.08, 0.18);
      g.lamp.box(add(l.pos, [0, -0.09, 0]), q, 0.55, 0.012, 0.13, 8);
      continue;
    }
    if (l.kind !== 'street') continue;
    // Arm reaches 1.6 m from the pole toward the road (the light's dir points down + toward the road).
    const toward = norm([l.dir[0], 0, l.dir[2]]);
    const poleTop: V3 = [l.pos[0] - toward[0] * 1.6, l.pos[1] + 0.25, l.pos[2] - toward[2] * 1.6];
    const base = groundAt(poleTop[0], poleTop[2]);
    const foot = Math.min(base, poleTop[1] - 3);
    g.steel.cylinder([poleTop[0], foot - 0.3, poleTop[2]], [poleTop[0], poleTop[1], poleTop[2]], 0.09, 8, true, 0.06);
    g.steel.cylinder(poleTop, [l.pos[0], l.pos[1] + 0.12, l.pos[2]], 0.04, 6, false);
    const q = quatFromFrame(norm(cross([0, 1, 0], toward)), [0, 1, 0], toward);
    g.steel.box([l.pos[0], l.pos[1] + 0.1, l.pos[2]], q, 0.22, 0.07, 0.38);
    g.lamp.box([l.pos[0], l.pos[1] + 0.02, l.pos[2]], q, 0.18, 0.012, 0.32, 8);
  }
}
