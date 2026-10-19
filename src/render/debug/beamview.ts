/**
 * Debug beam view: per object a LineSegments wireframe colored by beam strain
 * plus a dim Points overlay for nodes. Geometry is rewritten each frame from
 * interpolated node positions and the static beam index pairs.
 *
 * Strain colors: tension white→red, compression white→blue, |s| > 0.8 hot.
 * Broken (NaN) beams collapse to a zero-length segment.
 *
 * Modes (B cycles): 'beams' = strain wireframe + dim nodes; 'nodes' =
 * nodes only, larger and opaque. Until the P4 body mesh exists the nodes
 * mode is what keeps the car visible with the wireframe off.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
} from 'three';

/** What the view needs from the sim client (structural; keeps render off src/app). */
export interface BeamSource {
  objectRanges(): readonly { objectId: number; nodeOffset: number; nodeCount: number }[];
  /** Interleaved object-local node index pairs [a0, b0, a1, b1, …]. */
  beamPairs(objectId: number): Uint32Array | null;
  /** Object-local signed strain in [-1, 1], NaN = broken; null when unavailable. */
  strains(objectId: number): Float32Array | null;
}

const HOT = 0.8;
const INV_HOT = 1 / HOT;
// Linear-space colors.
const BASE_R = 0.85;
const BASE_G = 0.85;
const BASE_B = 0.85;
const HOT_TENSION: readonly [number, number, number] = [1.0, 0.85, 0.15];
const HOT_COMPRESSION: readonly [number, number, number] = [0.2, 0.95, 1.0];

interface ObjectView {
  objectId: number;
  beamCount: number;
  nodeCount: number;
  lines: LineSegments;
  linePos: BufferAttribute;
  lineCol: BufferAttribute;
  points: Points;
  pointPos: BufferAttribute;
  seen: boolean;
}

export type BeamViewMode = 'beams' | 'nodes';

const POINT_SIZE_BEAMS = 0.045;
const POINT_OPACITY_BEAMS = 0.55;
const POINT_SIZE_NODES = 0.08;

export class BeamView {
  readonly group = new Group();
  private viewMode: BeamViewMode = 'beams';
  private readonly lineMaterial = new LineBasicMaterial({ vertexColors: true, toneMapped: false });
  private readonly pointMaterial = new PointsMaterial({
    color: 0x9aa4b0,
    size: POINT_SIZE_BEAMS,
    sizeAttenuation: true,
    transparent: true,
    opacity: POINT_OPACITY_BEAMS,
    depthWrite: false,
  });
  private readonly views = new Map<number, ObjectView>();

  constructor() {
    this.group.name = 'beamview';
  }

  /** The whole debug view (beams and nodes). */
  set visible(v: boolean) {
    this.group.visible = v;
  }
  get visible(): boolean {
    return this.group.visible;
  }

  get mode(): BeamViewMode {
    return this.viewMode;
  }
  set mode(m: BeamViewMode) {
    this.viewMode = m;
    const beams = m === 'beams';
    for (const v of this.views.values()) v.lines.visible = beams;
    this.pointMaterial.size = beams ? POINT_SIZE_BEAMS : POINT_SIZE_NODES;
    this.pointMaterial.opacity = beams ? POINT_OPACITY_BEAMS : 1;
    this.pointMaterial.color.setHex(beams ? 0x9aa4b0 : 0xd8e2ec);
  }

  /** beams → nodes → beams. */
  cycle(): BeamViewMode {
    this.mode = this.viewMode === 'beams' ? 'nodes' : 'beams';
    return this.viewMode;
  }

  /** True when node points are drawn (both modes while the view is visible). */
  get nodesVisible(): boolean {
    return this.group.visible;
  }

  /** `positions`: interpolated global node array (xyz interleaved) in snapshot order. */
  update(source: BeamSource, positions: Float32Array): void {
    for (const v of this.views.values()) v.seen = false;

    for (const range of source.objectRanges()) {
      const pairs = source.beamPairs(range.objectId);
      if (!pairs) continue;
      const beamCount = pairs.length >> 1;
      let view = this.views.get(range.objectId);
      if (!view || view.beamCount !== beamCount || view.nodeCount !== range.nodeCount) {
        if (view) this.destroy(view);
        view = this.create(range.objectId, beamCount, range.nodeCount);
        this.views.set(range.objectId, view);
      }
      view.seen = true;
      this.write(view, pairs, positions, range.nodeOffset * 3, source.strains(range.objectId));
    }

    for (const v of this.views.values()) {
      if (!v.seen) {
        this.destroy(v);
        this.views.delete(v.objectId);
      }
    }
  }

  dispose(): void {
    for (const v of this.views.values()) this.destroy(v);
    this.views.clear();
    this.lineMaterial.dispose();
    this.pointMaterial.dispose();
  }

  private create(objectId: number, beamCount: number, nodeCount: number): ObjectView {
    const lineGeo = new BufferGeometry();
    const linePos = new BufferAttribute(new Float32Array(beamCount * 6), 3).setUsage(DynamicDrawUsage);
    const lineCol = new BufferAttribute(new Float32Array(beamCount * 6), 3).setUsage(DynamicDrawUsage);
    lineGeo.setAttribute('position', linePos);
    lineGeo.setAttribute('color', lineCol);
    const lines = new LineSegments(lineGeo, this.lineMaterial);
    // Bounds change every frame; skip culling instead of recomputing spheres.
    lines.frustumCulled = false;
    lines.name = `beams:${objectId}`;
    lines.visible = this.viewMode === 'beams';

    const pointGeo = new BufferGeometry();
    const pointPos = new BufferAttribute(new Float32Array(nodeCount * 3), 3).setUsage(DynamicDrawUsage);
    pointGeo.setAttribute('position', pointPos);
    const points = new Points(pointGeo, this.pointMaterial);
    points.frustumCulled = false;
    points.name = `nodes:${objectId}`;
    points.renderOrder = 1;

    this.group.add(lines, points);
    return { objectId, beamCount, nodeCount, lines, linePos, lineCol, points, pointPos, seen: true };
  }

  private destroy(v: ObjectView): void {
    this.group.remove(v.lines, v.points);
    v.lines.geometry.dispose();
    v.points.geometry.dispose();
  }

  private write(
    v: ObjectView,
    pairs: Uint32Array,
    pos: Float32Array,
    base: number,
    strains: Float32Array | null,
  ): void {
    const lp = v.linePos.array as Float32Array;
    const lc = v.lineCol.array as Float32Array;
    const nStrain = strains ? strains.length : 0;

    for (let i = 0, n = v.beamCount; i < n; i++) {
      const a = base + pairs[2 * i]! * 3;
      const b = base + pairs[2 * i + 1]! * 3;
      const o = i * 6;
      const s = i < nStrain ? strains![i]! : 0;
      const ax = pos[a]!;
      const ay = pos[a + 1]!;
      const az = pos[a + 2]!;
      lp[o] = ax;
      lp[o + 1] = ay;
      lp[o + 2] = az;
      if (s !== s) {
        // Broken: collapse onto endpoint a.
        lp[o + 3] = ax;
        lp[o + 4] = ay;
        lp[o + 5] = az;
        lc[o] = lc[o + 1] = lc[o + 2] = lc[o + 3] = lc[o + 4] = lc[o + 5] = 0;
        continue;
      }
      lp[o + 3] = pos[b]!;
      lp[o + 4] = pos[b + 1]!;
      lp[o + 5] = pos[b + 2]!;

      let r: number;
      let g: number;
      let bl: number;
      const m = s < 0 ? -s : s;
      if (m > HOT) {
        const hot = s > 0 ? HOT_TENSION : HOT_COMPRESSION;
        r = hot[0];
        g = hot[1];
        bl = hot[2];
      } else {
        const t = m * INV_HOT;
        if (s >= 0) {
          r = BASE_R + (1 - BASE_R) * t;
          g = BASE_G * (1 - t);
          bl = BASE_B * (1 - t);
        } else {
          r = BASE_R * (1 - t);
          g = BASE_G * (1 - t) + 0.25 * t;
          bl = BASE_B + (1 - BASE_B) * t;
        }
      }
      lc[o] = lc[o + 3] = r;
      lc[o + 1] = lc[o + 4] = g;
      lc[o + 2] = lc[o + 5] = bl;
    }

    const pp = v.pointPos.array as Float32Array;
    pp.set(pos.subarray(base, base + v.nodeCount * 3));

    markDirty(v.linePos);
    markDirty(v.lineCol);
    markDirty(v.pointPos);
  }
}

function markDirty(attr: BufferAttribute): void {
  // r185: updateRange is gone; ranges are cleared by the renderer after upload.
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, attr.array.length);
  attr.needsUpdate = true;
}
