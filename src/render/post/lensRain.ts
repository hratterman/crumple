/**
 * Rain on the camera lens (subtle): procedural drops that land, bead and
 * slowly slide, refracting and softening the picture behind them. Its own
 * EffectPass after the stack's (it samples the frame at offset UVs, a
 * convolution like SMAA), present only while it rains on a driving camera.
 */
import { Uniform } from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const FRAGMENT = /* glsl */ `
uniform float uAmount;
uniform float uTime;
uniform float uAspect;
float lrHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// one layer of drops: xy = refraction normal, z = coverage
vec3 lrLayer(vec2 uv, float scale, float t, float slide) {
  vec2 g = vec2(uv.x * uAspect, uv.y) * scale;
  vec2 c = floor(g);
  vec3 acc = vec3(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 cc = c + vec2(float(i), float(j));
      float h = lrHash(cc);
      float life = fract(t * (0.05 + 0.08 * h) + h * 7.0);
      if (h > 0.5 * uAmount + 0.08) continue;
      // grows on landing, holds, then slides down a little and evaporates
      vec2 ctr = cc + vec2(0.2 + 0.6 * lrHash(cc + 3.1), 0.25 + 0.5 * lrHash(cc + 7.7));
      ctr.y -= slide * smoothstep(0.55, 1.0, life) * (0.6 + lrHash(cc + 1.9));
      float r = (0.12 + 0.2 * lrHash(cc + 5.3)) * smoothstep(0.0, 0.06, life) * (1.0 - smoothstep(0.85, 1.0, life));
      vec2 d = g - ctr;
      d.y *= 1.0 + 0.6 * smoothstep(0.55, 1.0, life); // elongated while sliding
      float dl = length(d);
      float m = 1.0 - smoothstep(r * 0.85, r, dl);
      if (m <= 0.0) continue;
      vec2 n = d / max(r, 1e-3);
      acc += vec3(n * m, m);
    }
  return acc;
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 a = lrLayer(uv, 9.0, uTime, 0.9);
  vec3 b = lrLayer(uv + 0.37, 17.0, uTime * 1.3, 0.5) * 0.7;
  vec3 d = a + b;
  float m = clamp(d.z, 0.0, 1.0);
  if (m <= 0.001) { outputColor = inputColor; return; }
  // a drop is a small lens: inverted, magnified sample of what is behind it, out of focus
  vec2 off = d.xy * 0.035 * vec2(1.0 / uAspect, 1.0);
  vec2 ruv = uv - off;
  vec2 px = vec2(0.004 / uAspect, 0.004);
  vec3 c = texture2D(inputBuffer, ruv).rgb * 0.4
    + texture2D(inputBuffer, ruv + px).rgb * 0.15 + texture2D(inputBuffer, ruv - px).rgb * 0.15
    + texture2D(inputBuffer, ruv + vec2(px.x, -px.y)).rgb * 0.15 + texture2D(inputBuffer, ruv - vec2(px.x, -px.y)).rgb * 0.15;
  // dark rim + a small specular glint on top of each drop
  float rim = smoothstep(0.55, 1.0, length(d.xy));
  c *= 1.0 - 0.35 * rim;
  c += vec3(0.08) * smoothstep(0.7, 0.95, -d.y) * (1.0 - rim);
  outputColor = vec4(mix(inputColor.rgb, c, m * uAmount), inputColor.a);
}
`;

export class LensRainEffect extends Effect {
  constructor() {
    super('LensRainEffect', FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, Uniform>([
        ['uAmount', new Uniform(0)],
        ['uTime', new Uniform(0)],
        ['uAspect', new Uniform(16 / 9)],
      ]),
    });
  }
  set amount(v: number) {
    this.uniforms.get('uAmount')!.value = v;
  }
  set time(v: number) {
    this.uniforms.get('uTime')!.value = v;
  }
  override setSize(width: number, height: number): void {
    this.uniforms.get('uAspect')!.value = width / Math.max(1, height);
  }
}
