/**
 * Challenge course visuals (P8-C): checkpoint gates (two glowing posts + a
 * chevron banner, the finish a chequered one), and a tall light beacon over
 * the NEXT gate, visible from far away. Unlit (MeshBasic, HDR colours so
 * bloom picks them up), instanced: 3 draws whatever the gate count, no
 * shadows.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  type Object3D,
  type Texture,
} from 'three';

export interface GateVisual {
  x: number;
  y: number;
  z: number;
  /** Travel direction (unit, plan). */
  dx: number;
  dz: number;
  halfWidth: number;
  height: number;
}

export interface CourseRenderer {
  readonly object: Object3D;
  /** Next gate index (−1 none); passed gates fade out. */
  setNext(index: number): void;
  /** Per frame: beacon pulse. */
  update(timeS: number): void;
  dispose(): void;
}

const NEXT = new Color(4.2, 1.9, 0.45);
const LATER = new Color(1.3, 1.32, 1.36);
const FINISH = new Color(2.2, 2.2, 2.2);

function bannerTexture(): Texture {
  if (typeof document === 'undefined') {
    const d = new Uint8Array([255, 255, 255, 255]);
    const t = new DataTexture(d, 1, 1, RGBAFormat, UnsignedByteType);
    t.needsUpdate = true;
    return t;
  }
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#121418';
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 512, 5);
  g.fillRect(0, 59, 512, 5);
  // chevrons pointing up (through the gate) at both ends, the word in the middle
  for (const x0 of [14, 446]) {
    for (let k = 0; k < 2; k++) {
      const x = x0 + k * 26;
      g.beginPath();
      g.moveTo(x, 44);
      g.lineTo(x + 13, 20);
      g.lineTo(x + 26, 44);
      g.lineTo(x + 20, 44);
      g.lineTo(x + 13, 31);
      g.lineTo(x + 6, 44);
      g.closePath();
      g.fill();
    }
  }
  g.font = '900 34px "Arial Black", Impact, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('CHECKPOINT', 256, 34);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function finishTexture(): Texture {
  const n = 16;
  const d = new Uint8Array(n * 2 * 4);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < n; x++) {
      const v = (x + y) % 2 ? 20 : 240;
      const i = 4 * (y * n + x);
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
  const t = new DataTexture(d, n, 2, RGBAFormat, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export function createCourseRenderer(gates: readonly GateVisual[]): CourseRenderer {
  const root = new Group();
  root.name = 'challenge-course';
  const n = gates.length;
  const postGeo = new BoxGeometry(0.22, 1, 0.22);
  postGeo.translate(0, 0.5, 0);
  const postMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const posts = new InstancedMesh(postGeo, postMat, Math.max(1, 2 * n));
  posts.count = 2 * n;
  posts.frustumCulled = false;
  const bannerGeo = new PlaneGeometry(1, 1);
  const bannerTex = bannerTexture();
  const bannerMat = new MeshBasicMaterial({ map: bannerTex, side: DoubleSide, toneMapped: false });
  const banners = new InstancedMesh(bannerGeo, bannerMat, Math.max(1, n - 1));
  banners.count = Math.max(0, n - 1);
  banners.frustumCulled = false;
  const finTex = finishTexture();
  const finMat = new MeshBasicMaterial({ map: finTex, side: DoubleSide, toneMapped: false });
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const tmp = new Vector3();
  const scl = new Vector3();
  let finish: Mesh | null = null;
  gates.forEach((g, i) => {
    const rx = -g.dz;
    const rz = g.dx;
    // the banner's face (+Z) looks back at the approaching car, its +X is the travel right
    const yaw = Math.atan2(-g.dx, -g.dz);
    q.setFromAxisAngle(up, yaw);
    for (const side of [-1, 1]) {
      tmp.set(g.x + rx * g.halfWidth * side, g.y, g.z + rz * g.halfWidth * side);
      scl.set(1, g.height, 1);
      m.compose(tmp, q, scl);
      posts.setMatrixAt(2 * i + (side < 0 ? 0 : 1), m);
    }
    const bannerH = 0.9;
    tmp.set(g.x, g.y + g.height - bannerH / 2, g.z);
    scl.set(2 * g.halfWidth, bannerH, 1);
    m.compose(tmp, q, scl);
    if (i === n - 1) {
      finish = new Mesh(bannerGeo, finMat);
      finish.matrixAutoUpdate = false;
      finish.matrix.copy(m);
      finish.name = 'challenge-finish';
      finTex.repeat.set(Math.max(4, Math.round(g.halfWidth * 2)), 1);
    } else banners.setMatrixAt(i, m);
  });
  posts.instanceMatrix.needsUpdate = true;
  banners.instanceMatrix.needsUpdate = true;
  root.add(posts, banners);
  if (finish) root.add(finish);

  // beacon over the next gate: a tall soft light column
  const beaconGeo = new CylinderGeometry(0.9, 0.9, 1, 16, 1, true);
  beaconGeo.translate(0, 0.5, 0);
  const pos = beaconGeo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const a = 1 - pos.getY(i);
    col[3 * i] = a;
    col[3 * i + 1] = a;
    col[3 * i + 2] = a;
  }
  beaconGeo.setAttribute('color', new BufferAttribute(col, 3));
  const beaconMat = new MeshBasicMaterial({ color: new Color(1.6, 0.8, 0.25), vertexColors: true, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
  const beacon = new Mesh(beaconGeo, beaconMat);
  beacon.name = 'challenge-beacon';
  beacon.frustumCulled = false;
  beacon.renderOrder = 5;
  root.add(beacon);

  const color = new Color();
  let next = 0;
  const apply = (): void => {
    for (let i = 0; i < n; i++) {
      const passed = next >= 0 && i < next;
      const isNext = i === next;
      color.copy(i === n - 1 && !isNext ? FINISH : isNext ? NEXT : LATER);
      if (passed || next < 0) color.setRGB(0, 0, 0);
      posts.setColorAt(2 * i, color);
      posts.setColorAt(2 * i + 1, color);
      if (i < n - 1) banners.setColorAt(i, passed || next < 0 ? color.setRGB(0, 0, 0) : isNext ? NEXT : color.setRGB(0.9, 0.9, 0.92));
    }
    if (posts.instanceColor) posts.instanceColor.needsUpdate = true;
    if (banners.instanceColor) banners.instanceColor.needsUpdate = true;
    const g = next >= 0 ? gates[next] : undefined;
    beacon.visible = !!g;
    if (g) {
      beacon.position.set(g.x, g.y, g.z);
      beacon.scale.set(Math.max(1, g.halfWidth * 0.18), 140, Math.max(1, g.halfWidth * 0.18));
      beacon.updateMatrix();
    }
    // a passed gate's geometry is hidden by black: move it out of sight instead
    for (let i = 0; i < n; i++) {
      if (!(next < 0 || i < next)) continue;
      m.makeScale(0, 0, 0);
      posts.setMatrixAt(2 * i, m);
      posts.setMatrixAt(2 * i + 1, m);
      if (i < n - 1) banners.setMatrixAt(i, m);
      else if (finish) finish.visible = false;
    }
    posts.instanceMatrix.needsUpdate = true;
    banners.instanceMatrix.needsUpdate = true;
  };
  apply();
  return {
    object: root,
    setNext(index) {
      if (index === next) return;
      next = index;
      apply();
    },
    update(t) {
      beaconMat.opacity = 0.38 + 0.18 * Math.sin(t * 3.2);
    },
    dispose() {
      root.removeFromParent();
      postGeo.dispose();
      bannerGeo.dispose();
      beaconGeo.dispose();
      for (const mm of [postMat, bannerMat, finMat, beaconMat]) mm.dispose();
      bannerTex.dispose();
      finTex.dispose();
    },
  };
}
