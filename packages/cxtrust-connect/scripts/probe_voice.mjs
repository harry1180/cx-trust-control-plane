// Calibration probe for the in-house voice analyzer: prints features + scores
// for generated controls and every WAV given (default: the attack fixture +
// candidate samples found on this machine). Any sample rate is accepted
// (linear resample to the analyzer's 16kHz contract).
//
//   node scripts/probe_voice.mjs [path/to/file.wav ...]
//
// Use it to sanity-check thresholds against real recordings before trusting
// field numbers. Not a test — a calibration tool.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { computeFeatures, InHouseSignalAnalyzer } from '../src/voicebiometrics.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const analyzer = new InHouseSignalAnalyzer();

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
  // walk chunks: fmt (rate, bits) + data
  let rate = 16000, bits = 16, channels = 1, off = 12, data = null, fmtOff = -1;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { fmtOff = off; rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); channels = b.readUInt16LE(off + 10); }
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + size); }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error('no data chunk');
  if (bits !== 16) throw new Error(`${bits}-bit not supported by probe`);
  const frames = Math.floor(data.length / (2 * channels));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = data.readInt16LE(i * 2 * channels); // first channel
  return { rate, samples: mono };
}

function resampleTo16k(samples, rate) {
  if (rate === 16000) return samples;
  const ratio = rate / 16000;
  const n = Math.floor(samples.length / ratio);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const frac = pos - a;
    out[i] = (samples[a] ?? 0) * (1 - frac) + (samples[a + 1] ?? 0) * frac;
  }
  return out;
}

function toPcm16(samples16k) {
  const b = Buffer.alloc(samples16k.length * 2);
  for (let i = 0; i < samples16k.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples16k[i])));
    b.writeInt16LE(v, i * 2);
  }
  return b;
}

/** 10th-percentile frame dB of INTERIOR frames (between first & last speech). */
function interiorFloorDb(pcm) {
  const FRAME = 512, HOP = 256;
  const n = Math.floor(pcm.length / 2);
  const dbs = [];
  for (let s = 0; s + FRAME <= n; s += HOP) {
    let acc = 0;
    for (let i = s; i < s + FRAME; i++) { const v = pcm.readInt16LE(i * 2); acc += v * v; }
    dbs.push(acc > 1e-12 ? 10 * Math.log10(acc / FRAME / (32768 * 32768)) : -120);
  }
  const speech = dbs.map((d, i) => [d, i]).filter(([d]) => d >= -45);
  if (speech.length < 10) return null;
  const first = speech[0][1], last = speech[speech.length - 1][1];
  const interior = dbs.slice(first, last + 1);
  const sorted = [...interior].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.1)];
}

function report(label, pcm) {
  const f = computeFeatures(pcm);
  const s = analyzer.analyze({ contactId: 'probe', audioChunk: pcm });
  console.log(`\n== ${label} (${(pcm.length / 2 / 16000).toFixed(2)}s @16k)`);
  console.log('  features:', JSON.stringify(f));
  console.log('  interiorFloorDb:', interiorFloorDb(pcm));
  console.log('  scores  :', JSON.stringify(s));
}

function pcmFromSamples(samples) {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], i * 2);
  return b;
}
function sine(seconds, hz, amp = 8000) {
  const n = Math.floor(16000 * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / 16000));
  return pcmFromSamples(out);
}
function noise(seconds) {
  const n = Math.floor(16000 * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor((Math.random() * 2 - 1) * 6000);
  return pcmFromSamples(out);
}

report('sine 220Hz (periodic control)', sine(1, 220));
report('white noise (unvoiced control)', noise(1));

const paths = process.argv.slice(2);
const defaults = [
  resolve(HERE, '../test/fixtures/attack_call.wav'),
  'C:/Users/Kisha/projects/gitrepos/VoiceStudio/tests/fixtures/omnivoice_data/voices/test-voice/sample.wav',
  'C:/Users/Kisha/projects/gitrepos/VoiceStudio/backend/assets/samples/dictation/en_conversational.wav',
  'C:/Users/Kisha/projects/gitrepos/VoiceStudio/backend/assets/samples/voice_design/demo_voice_design_aussie_podcaster.wav',
  'C:/Users/Kisha/projects/gitrepos/VoiceStudio/backend/assets/samples/demo_clone_output.wav',
  'C:/Users/Kisha/projects/gitrepos/VoiceStudio/backend/assets/samples/demo_voice.wav',
];
for (const p of (paths.length ? paths : defaults)) {
  if (!existsSync(p)) { console.log(`\n== SKIP (missing): ${p}`); continue; }
  try {
    const { rate, samples } = readWav(p);
    const pcm = toPcm16(resampleTo16k(samples, rate));
    report(`${p} [src ${rate}Hz]`, pcm);
  } catch (e) {
    console.log(`\n== ERROR ${p}: ${e.message}`);
  }
}