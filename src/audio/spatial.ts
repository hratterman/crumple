/**
 * Spatialization (P8 audio): PannerNodes for world sources (HRTF for the
 * player car where affordable, equal-power elsewhere), inverse distance
 * attenuation, the AudioListener following the camera. Doppler is manual
 * (PannerNode Doppler was removed from WebAudio): `params.dopplerFactor`
 * feeds each voice's pitch. Allocation-free per frame.
 */
import { ParamSlot } from './io';

export interface SpatialOptions {
  hrtf: boolean;
  refDistance: number;
  rolloff?: number;
  /** Directional source (exhaust): inner / outer cone degrees and the outer gain. */
  cone?: [number, number, number];
}

export class SpatialVoice {
  readonly panner: PannerNode;
  /** Level in front of the panner (set per voice). */
  readonly input: GainNode;
  private readonly px: ParamSlot | null;
  private readonly py: ParamSlot | null;
  private readonly pz: ParamSlot | null;
  private readonly ox: ParamSlot | null;
  private readonly oy: ParamSlot | null;
  private readonly oz: ParamSlot | null;
  private readonly gain: ParamSlot;

  constructor(ctx: BaseAudioContext, dst: AudioNode, o: SpatialOptions) {
    const p = ctx.createPanner();
    p.panningModel = o.hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = o.refDistance;
    p.rolloffFactor = o.rolloff ?? 1;
    p.maxDistance = 10000;
    if (o.cone) {
      p.coneInnerAngle = o.cone[0];
      p.coneOuterAngle = o.cone[1];
      p.coneOuterGain = o.cone[2];
    }
    this.panner = p;
    this.input = ctx.createGain();
    this.input.gain.value = 0;
    this.input.connect(p).connect(dst);
    const has = typeof p.positionX !== 'undefined';
    // positions jump per frame: a short glide avoids zipper noise without lagging the picture
    this.px = has ? new ParamSlot(p.positionX, 0.012, 0.005) : null;
    this.py = has ? new ParamSlot(p.positionY, 0.012, 0.005) : null;
    this.pz = has ? new ParamSlot(p.positionZ, 0.012, 0.005) : null;
    this.ox = has && o.cone ? new ParamSlot(p.orientationX, 0.02, 0.01) : null;
    this.oy = has && o.cone ? new ParamSlot(p.orientationY, 0.02, 0.01) : null;
    this.oz = has && o.cone ? new ParamSlot(p.orientationZ, 0.02, 0.01) : null;
    this.gain = new ParamSlot(this.input.gain, 0.03);
  }

  setPosition(x: number, y: number, z: number, now: number): void {
    if (this.px) {
      this.px.set(x, now);
      this.py!.set(y, now);
      this.pz!.set(z, now);
    } else this.panner.setPosition(x, y, z);
  }

  setOrientation(x: number, y: number, z: number, now: number): void {
    if (this.ox) {
      this.ox.set(x, now);
      this.oy!.set(y, now);
      this.oz!.set(z, now);
    } else if (!this.px) this.panner.setOrientation(x, y, z);
  }

  setGain(g: number, now: number): void {
    this.gain.set(g, now);
  }
}

/** Camera → AudioListener (position, forward, up). */
export class ListenerRig {
  private readonly l: AudioListener;
  private readonly s: ParamSlot[] | null;
  /** Listener position and (smoothed, wall-clock) velocity, for Doppler. */
  readonly pos = new Float64Array(3);
  readonly vel = new Float64Array(3);
  private primed = false;

  constructor(ctx: BaseAudioContext) {
    this.l = ctx.listener;
    const l = this.l;
    this.s =
      typeof l.positionX !== 'undefined'
        ? [l.positionX, l.positionY, l.positionZ, l.forwardX, l.forwardY, l.forwardZ, l.upX, l.upY, l.upZ].map((p) => new ParamSlot(p, 0.012, 0.002))
        : null;
  }

  /** `m` = camera.matrixWorld.elements (column-major 4×4). */
  update(m: ArrayLike<number>, dt: number, now: number): void {
    const x = m[12]!;
    const y = m[13]!;
    const z = m[14]!;
    if (this.primed && dt > 1e-4) {
      const k = Math.min(1, dt * 8);
      const jump = Math.abs(x - this.pos[0]!) + Math.abs(y - this.pos[1]!) + Math.abs(z - this.pos[2]!);
      // a camera cut is not a velocity
      if (jump < 60 * dt + 2) {
        this.vel[0] = this.vel[0]! + ((x - this.pos[0]!) / dt - this.vel[0]!) * k;
        this.vel[1] = this.vel[1]! + ((y - this.pos[1]!) / dt - this.vel[1]!) * k;
        this.vel[2] = this.vel[2]! + ((z - this.pos[2]!) / dt - this.vel[2]!) * k;
      } else this.vel.fill(0);
    }
    this.primed = true;
    this.pos[0] = x;
    this.pos[1] = y;
    this.pos[2] = z;
    const fx = -m[8]!;
    const fy = -m[9]!;
    const fz = -m[10]!;
    const ux = m[4]!;
    const uy = m[5]!;
    const uz = m[6]!;
    const s = this.s;
    if (s) {
      s[0]!.set(x, now);
      s[1]!.set(y, now);
      s[2]!.set(z, now);
      s[3]!.set(fx, now);
      s[4]!.set(fy, now);
      s[5]!.set(fz, now);
      s[6]!.set(ux, now);
      s[7]!.set(uy, now);
      s[8]!.set(uz, now);
    } else {
      this.l.setPosition(x, y, z);
      this.l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }
}
