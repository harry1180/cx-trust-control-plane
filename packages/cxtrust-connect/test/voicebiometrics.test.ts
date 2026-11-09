// In-house voice analyzer: mechanics + empirical calibration regression.
// Calibration numbers come from scripts/probe_voice.mjs — if a threshold
// change flips these, rerun the probe and update both together.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { computeFeatures, InHouseSignalAnalyzer } from '../src/voicebiometrics.ts';
import { wavDataOffset } from '../src/transcribe.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const analyzer = new InHouseSignalAnalyzer();

function pcmFromSamples(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i]!, i * 2);
  return b;
}

function sine(seconds: number, hz: number, amp = 8000, rate = 16000): Buffer {
  const n = Math.floor(rate * seconds);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate)));
  return pcmFromSamples(out);
}

function whiteNoise(seconds: number, amp = 6000): Buffer {
  const n = Math.floor(16000 * seconds);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor((Math.random() * 2 - 1) * amp));
  return pcmFromSamples(out);
}

function attackFixture(): Buffer {
  const wav = readFileSync(resolve(HERE, 'fixtures/attack_call.wav'));
  return wav.subarray(wavDataOffset(wav));
}

test('features: perfectly periodic audio is F0-detectable with near-zero jitter', () => {
  const f = computeFeatures(sine(1, 220));
  assert.ok(f.voicedFrames > 30, 'sine yields voiced frames');
  assert.ok(f.jitter !== null && f.jitter < 0.005, 'periodic audio has sub-natural jitter');
  assert.ok(f.loudnessCv !== null && f.loudnessCv < 0.1, 'sine loudness is near-constant');
  assert.equal(f.gapFloorDb, null, 'no interior gaps in continuous audio');
  assert.ok(f.repeatRatio !== null && f.repeatRatio >= 0, 'repeatRatio computed for non-silent audio');
});

test('scores: periodic control scores synthetic, unvoiced noise scores zero', () => {
  const s = analyzer.analyze({ contactId: 't', audioChunk: sine(1, 220) });
  assert.ok(s.syntheticProbability >= 0.7, `sine synthetic >= 0.7, got ${s.syntheticProbability}`);
  assert.ok(s.replayProbability >= 0.8, 'perfectly repeated frames are flagged as replay artifacts');

  const n = analyzer.analyze({ contactId: 't', audioChunk: whiteNoise(1) });
  assert.ok(n.syntheticProbability <= 0.1, `noise synthetic <= 0.1, got ${n.syntheticProbability}`);
  assert.equal(n.replayProbability, 0);
});

test('scores: TTS attack fixture scores clearly synthetic', () => {
  const pcm = attackFixture();
  const f = computeFeatures(pcm);
  assert.equal(f.gapFloorDb, -120, 'fixture has digitally-gated interior gaps');
  const s = analyzer.analyze({ contactId: 't', audioChunk: pcm });
  assert.ok(s.syntheticProbability >= 0.45, `attack fixture synthetic >= 0.45, got ${s.syntheticProbability}`);
  assert.equal(s.impersonationProbability, 0, 'impersonation is never fabricated without enrollment');
});

test('scores: no audio / silence / too short -> honest zeros, never guesses', () => {
  assert.deepEqual(analyzer.analyze({ contactId: 't' }), { syntheticProbability: 0, replayProbability: 0, impersonationProbability: 0 });
  assert.deepEqual(analyzer.analyze({ contactId: 't', audioChunk: Buffer.alloc(64) }), { syntheticProbability: 0, replayProbability: 0, impersonationProbability: 0 });
  assert.deepEqual(analyzer.analyze({ contactId: 't', audioChunk: Buffer.alloc(16000 * 2) }), { syntheticProbability: 0, replayProbability: 0, impersonationProbability: 0 });
});

test('scores are deterministic for the same audio', () => {
  const pcm = attackFixture();
  const a = analyzer.analyze({ contactId: 't', audioChunk: pcm });
  const b = analyzer.analyze({ contactId: 't', audioChunk: pcm });
  assert.deepEqual(a, b);
});

test('gated capture: digital-silence gaps alone must NOT score synthetic (regression on real false positive)', () => {
  // Mimics a noise-gated human mic recording: three phrase-bursts of
  // amplitude- and pitch-modulated (natural-looking) speech with interior
  // digital-silence gaps — the exact pattern that measured 61% before the
  // corroboration rule.
  const bursts = [[0, 4800], [7200, 12000], [15000, 19200]]; // samples @16k, gaps between
  const buf = Buffer.alloc(19200 * 2);
  for (const [a, b] of bursts) {
    for (let i = a; i < b; i++) {
      const f0 = 120 + 40 * Math.sin(i / 900);          // natural pitch movement
      const amp = 5000 + 2500 * Math.sin(i / 500);      // natural loudness dynamics
      buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * f0 * i) / 16000)), i * 2);
    }
  }
  const f = computeFeatures(buf);
  assert.ok(f.gapFloorDb !== null && f.gapFloorDb <= -100, 'interior digital-silence gaps present (the false-positive trigger)');
  const s = analyzer.analyze({ contactId: 't', audioChunk: buf });
  assert.ok(s.syntheticProbability <= 0.15,
    `gated genuine-style audio must score <= 0.15 after corroboration rule, got ${s.syntheticProbability}`);
});

test('analyzer identity is honestly labeled', () => {
  assert.match(analyzer.id, /in-house/);
  assert.match(analyzer.id, /not a validated biometric/);
});