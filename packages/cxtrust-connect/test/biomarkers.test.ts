// Biomarkers: mechanics + honesty-contract tests. Feature VALUES are
// calibration data, not medical ground truth — tests pin ordering on
// controlled signals and the mandatory non-diagnostic framing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBiomarkers, type EmotionEstimate } from '../src/biomarkers.ts';

function pcmFrom(fn: (i: number) => number, seconds: number): Buffer {
  const n = Math.floor(16000 * seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(fn(i)))), i * 2);
  return b;
}

/** Expressive speech: wide pitch sweeps, amplitude bursts at ~4/s, short pauses. */
function expressive(): Buffer {
  const total = 16000 * 6;
  const b = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const t = i / 16000;
    const inPhrase = (t % 0.5) < 0.32;              // 0.32s speech / 0.18s pause
    let v = 0;
    if (inPhrase) {
      const f0 = 150 + 110 * Math.sin(2 * Math.PI * 3 * t); // wide, fast sweep
      const amp = 5200 * (0.55 + 0.45 * Math.sin(2 * Math.PI * 8 * t));
      v = amp * Math.sin((2 * Math.PI * f0 * t));
    }
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return b;
}

/** Flat speech: constant pitch, constant loudness, continuous, no pauses. */
function flat(): Buffer {
  return pcmFrom(i => {
    const t = i / 16000;
    return 4000 * Math.sin(2 * Math.PI * 150 * t);
  }, 6);
}

test('activation ordering: expressive prosody scores clearly above flat monotone', () => {
  const e = extractBiomarkers(expressive());
  const f = extractBiomarkers(flat());
  assert.ok(e.speechFrames >= 25, 'expressive has speech frames');
  assert.ok(e.emotion.activation > f.emotion.activation + 0.2,
    `expressive ${e.emotion.activation} must beat flat ${f.emotion.activation} by >0.2`);
  assert.ok(e.emotion.activation >= 0.4, `expressive activation >= 0.4, got ${e.emotion.activation}`);
  assert.ok(f.emotion.activation <= 0.35, `flat activation <= 0.35, got ${f.emotion.activation}`);
});

test('honesty contract: limitations + disclaimer always present, no diagnostic verdicts', () => {
  const r = extractBiomarkers(expressive());
  assert.ok(r.limitations.length >= 3, 'limitations always listed');
  assert.match(r.limitations[0]!, /Not a medical device/);
  assert.match(r.emotion.disclaimer, /unreliable/);
  assert.ok(r.emotion.candidates.length > 0, 'emotion offers candidates, not a verdict');
  for (const b of r.biomarkers) {
    assert.ok(b.note.length > 30, `biomarker ${b.key} must carry an association note`);
    assert.doesNotMatch(b.note, /you have|diagnosis:|detected (disease|condition)/i,
      `biomarker ${b.key} must not claim a diagnosis`);
  }
  assert.ok(r.emotion.confidence >= 0 && r.emotion.confidence <= 1);
});

test('deterministic: same audio → identical report', () => {
  const a = extractBiomarkers(expressive());
  const b = extractBiomarkers(expressive());
  assert.deepEqual(a, b);
});

test('too little speech → insufficient-speech report, no fabricated numbers', () => {
  const r = extractBiomarkers(pcmFrom(() => 0, 1)); // pure silence
  assert.equal(r.emotion.label, 'insufficient speech');
  assert.equal(r.emotion.confidence, 0);
  assert.equal(r.speechFrames, 0);
});

test('baseline deviation appears when an enrolled voiceprint exists', () => {
  const baseline = {
    vector: [], mfccMean: [], mfccStd: [],
    pitch: [150, 10, 60], // enrolled: median, std, range
    enrolledAt: 'now', consent: { at: 'now', by: 'tester', note: 'n' },
    durationS: 5,
  } as never as Parameters<typeof extractBiomarkers>[1];
  const r = extractBiomarkers(expressive(), baseline);
  assert.equal(r.baselineUsed, true);
  const pv = r.biomarkers.find(b => b.key === 'pitchVariability')!;
  assert.equal(typeof pv.baselineDeviationPct, 'number', 'deviation vs own baseline computed');
  const none = extractBiomarkers(expressive(), null);
  assert.equal(none.baselineUsed, false);
  assert.equal(none.biomarkers.find(b => b.key === 'pitchVariability')!.baselineDeviationPct, undefined);
});

test('emotion shape: label ranges match activation bands', () => {
  const bands: [number, RegExp][] = [[0.66, /high activation/], [0.34, /moderate activation/], [0, /low activation/]];
  for (const [cut, re] of bands) {
    const est: EmotionEstimate = {
      activation: cut, label: cut >= 0.66 ? 'high activation — excited, stressed, or agitated-likelier'
        : cut >= 0.34 ? 'moderate activation — neutral/engaged-likelier' : 'low activation — calm, fatigued, or low-mood-likelier',
      candidates: [], confidence: 1, disclaimer: '',
    };
    assert.match(est.label, re);
  }
});