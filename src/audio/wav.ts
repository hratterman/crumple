/** 16-bit PCM WAV encoder (tests / offline renders; pure). Channels are interleaved from `channels`. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const nCh = channels.length;
  const n = channels[0]?.length ?? 0;
  const bytes = 44 + n * nCh * 2;
  const out = new Uint8Array(bytes);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  v.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const x = channels[c]![i]!;
      const s = x > 1 ? 1 : x < -1 ? -1 : x;
      v.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }
  }
  return out;
}

/** Peak, RMS and DC of a signal (analysis helpers for tests). */
export function signalStats(x: Float32Array): { peak: number; rms: number; dc: number } {
  let peak = 0;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i]!;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    sum += s;
    sq += s * s;
  }
  const n = Math.max(1, x.length);
  return { peak, rms: Math.sqrt(sq / n), dc: sum / n };
}
