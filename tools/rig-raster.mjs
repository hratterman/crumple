// R-RIG: a tiny deterministic software rasterizer (z-buffered flat-shaded
// triangles + lines) and PNG writer for offline rig images (no GPU, no deps).
import { deflateSync } from 'node:zlib';

export function createCanvas(width, height, bg = [236, 238, 242]) {
  const rgb = new Uint8Array(width * height * 3);
  const z = new Float32Array(width * height).fill(Infinity);
  for (let i = 0; i < width * height; i++) rgb.set(bg, i * 3);
  return { width, height, rgb, z };
}

/** Pinhole camera: eye, target, up, vertical fov (deg). Returns project(p) → [sx, sy, depth] or null. */
export function camera(c, width, height) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = norm(sub(c.target, c.eye));
  const r = norm(cross(f, c.up ?? [0, 1, 0]));
  const u = cross(r, f);
  const ortho = c.ortho; // half height in metres, or undefined
  const k = ortho ? height / (2 * ortho) : height / (2 * Math.tan(((c.fov ?? 30) * Math.PI) / 360));
  const project = (p) => {
    const d = sub(p, c.eye);
    const zc = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
    if (zc < 0.05) return null;
    const xc = d[0] * r[0] + d[1] * r[1] + d[2] * r[2];
    const yc = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
    const s = ortho ? k : k / zc;
    return [width / 2 + xc * s, height / 2 - yc * s, zc];
  };
  return { project, forward: f, eye: c.eye };
}

/** Flat-shaded triangle (world space p0..p2, base colour rgb 0..255, optional emissive). */
export function drawTriangle(cv, cam, p0, p1, p2, color, opts = {}) {
  const a = cam.project(p0);
  const b = cam.project(p1);
  const c = cam.project(p2);
  if (!a || !b || !c) return;
  // world normal for lighting
  const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (!(nl > 1e-12)) return;
  n = [n[0] / nl, n[1] / nl, n[2] / nl];
  // two-sided: face the camera
  const toEye = [cam.eye[0] - p0[0], cam.eye[1] - p0[1], cam.eye[2] - p0[2]];
  if (n[0] * toEye[0] + n[1] * toEye[1] + n[2] * toEye[2] < 0) n = [-n[0], -n[1], -n[2]];
  const L = opts.light ?? [0.45, 0.8, 0.4];
  const ll = Math.hypot(L[0], L[1], L[2]);
  const diff = Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / ll);
  // half vector spec
  const te = Math.hypot(toEye[0], toEye[1], toEye[2]) || 1;
  const h = [L[0] / ll + toEye[0] / te, L[1] / ll + toEye[1] / te, L[2] / ll + toEye[2] / te];
  const hl = Math.hypot(h[0], h[1], h[2]) || 1;
  const spec = Math.pow(Math.max(0, (n[0] * h[0] + n[1] * h[1] + n[2] * h[2]) / hl), opts.shininess ?? 40) * (opts.specular ?? 0.35);
  const amb = opts.ambient ?? 0.35;
  const shade = (k) => Math.min(255, Math.round(color[k] * (amb + (1 - amb) * diff) + 255 * spec));
  const col = [shade(0), shade(1), shade(2)];
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(cv.width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(cv.height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area;
      const w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const zz = w0 * a[2] + w1 * b[2] + w2 * c[2];
      const i = y * cv.width + x;
      if (zz >= cv.z[i]) continue;
      cv.z[i] = zz;
      cv.rgb[i * 3] = col[0];
      cv.rgb[i * 3 + 1] = col[1];
      cv.rgb[i * 3 + 2] = col[2];
    }
  }
}

/** Depth-tested line (world space), 1 px. */
export function drawLine(cv, cam, p0, p1, color, bias = 0.002) {
  const a = cam.project(p0);
  const b = cam.project(p1);
  if (!a || !b) return;
  const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = Math.round(a[0] + (b[0] - a[0]) * t - 0.5);
    const y = Math.round(a[1] + (b[1] - a[1]) * t - 0.5);
    if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) continue;
    const zz = a[2] + (b[2] - a[2]) * t - bias;
    const i = y * cv.width + x;
    if (zz > cv.z[i]) continue;
    cv.rgb[i * 3] = color[0];
    cv.rgb[i * 3 + 1] = color[1];
    cv.rgb[i * 3 + 2] = color[2];
  }
}

/** Minimal 5×7 bitmap font for labels (digits, upper-case letters, a few symbols). */
const FONT = {
  '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110', '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110', '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000', '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100', ' ': '00000000000000000000000000000000000', '.': '00000000000000000000000000110001100',
  '-': '00000000000000011111000000000000000', ':': '00000011000110000000011000110000000', '/': '00001000010001000100010001000010000',
  '%': '11000110010001000100010001001100011', '=': '00000000001111100000111110000000000', '(': '00010001000100001000010000010000010', ')': '01000001000001000010000100010001000',
};
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LETTER_BITS = [
  '01110100011000111111100011000110001', '11110100011000111110100011000111110', '01110100011000010000100001000101110', '11100100101000110001100011001011100',
  '11111100001000011110100001000011111', '11111100001000011110100001000010000', '01110100011000010111100011000101111', '10001100011000111111100011000110001',
  '01110001000010000100001000010001110', '00111000100001000010000101001001100', '10001100101010011000101001001010001', '10000100001000010000100001000011111',
  '10001110111010110101100011000110001', '10001100011100110101100111000110001', '01110100011000110001100011000101110', '11110100011000111110100001000010000',
  '01110100011000110001101011001001101', '11110100011000111110101001001010001', '01111100001000001110000010000111110', '11111001000010000100001000010000100',
  '10001100011000110001100011000101110', '10001100011000110001100010101000100', '10001100011000110101101011010101010', '10001100010101000100010101000110001',
  '10001100010101000100001000010000100', '11111000010001000100010001000011111',
];
LETTERS.split('').forEach((ch, i) => (FONT[ch] = LETTER_BITS[i]));

export function drawText(cv, x0, y0, text, color = [20, 20, 20], scale = 2) {
  let x = x0;
  for (const ch of String(text).toUpperCase()) {
    const bits = FONT[ch] ?? FONT[' '];
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++) {
        if (bits[r * 5 + c] !== '1') continue;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const px = x + c * scale + dx;
            const py = y0 + r * scale + dy;
            if (px < 0 || py < 0 || px >= cv.width || py >= cv.height) continue;
            cv.rgb.set(color, (py * cv.width + px) * 3);
          }
      }
    x += 6 * scale;
  }
}

/** Pastes canvas `src` into `dst` at (x, y). */
export function blit(dst, src, x, y) {
  for (let r = 0; r < src.height; r++) {
    const ty = y + r;
    if (ty < 0 || ty >= dst.height) continue;
    for (let c = 0; c < src.width; c++) {
      const tx = x + c;
      if (tx < 0 || tx >= dst.width) continue;
      dst.rgb[(ty * dst.width + tx) * 3] = src.rgb[(r * src.width + c) * 3];
      dst.rgb[(ty * dst.width + tx) * 3 + 1] = src.rgb[(r * src.width + c) * 3 + 1];
      dst.rgb[(ty * dst.width + tx) * 3 + 2] = src.rgb[(r * src.width + c) * 3 + 2];
    }
  }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(cv) {
  const raw = Buffer.alloc((cv.width * 3 + 1) * cv.height);
  for (let y = 0; y < cv.height; y++) {
    raw[y * (cv.width * 3 + 1)] = 0;
    Buffer.from(cv.rgb.buffer, cv.rgb.byteOffset + y * cv.width * 3, cv.width * 3).copy(raw, y * (cv.width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.width, 0);
  ihdr.writeUInt32BE(cv.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
