/**
 * Offline renders of the synthesized audio to WAV (P8). Skipped unless
 * AUDIO_WAV_DIR is set:
 *   AUDIO_WAV_DIR=/some/dir npx vitest run src/audio/render.wav.test.ts
 * Uses the exact DSP the AudioWorklet runs (src/audio/dsp/*), block by block
 * at 128 frames like the audio thread, so the files are what the game plays
 * (minus the WebAudio mix: panners, bus filters, compressor).
 */
import { describe, expect, it } from 'vitest';

import { renderScenarios } from './render';
import { encodeWav, signalStats } from './wav';

const DIR = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.AUDIO_WAV_DIR;

describe.skipIf(!DIR)('audio WAV renders', () => {
  it('renders every engine (idle / mid / redline / sweep), tyres, wind, ambience and crashes', async () => {
    const fsm = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsm)) as { mkdirSync(p: string, o: { recursive: boolean }): void; writeFileSync(p: string, d: Uint8Array | string): void };
    fs.mkdirSync(DIR!, { recursive: true });
    const sr = 48000;
    const lines: string[] = [];
    for (const s of renderScenarios(sr)) {
      fs.writeFileSync(`${DIR}/${s.name}.wav`, encodeWav(s.channels, sr));
      const st = s.channels.map((c) => signalStats(c));
      const peak = Math.max(...st.map((x) => x.peak));
      const rms = Math.sqrt(st.reduce((a, x) => a + x.rms * x.rms, 0) / st.length);
      const dc = Math.max(...st.map((x) => Math.abs(x.dc)));
      lines.push(`${s.name.padEnd(28)} peak ${peak.toFixed(3)}  rms ${rms.toFixed(4)} (${(20 * Math.log10(rms + 1e-9)).toFixed(1)} dBFS)  dc ${dc.toExponential(1)}`);
      expect(peak).toBeLessThan(1);
      expect(dc).toBeLessThan(0.01);
    }
    fs.writeFileSync(`${DIR}/stats.txt`, lines.join('\n') + '\n');
    console.log(lines.join('\n'));
  }, 240_000);
});
