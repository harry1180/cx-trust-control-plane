// In-house synthetic-voice / replay detection — signal analysis built from
// scratch for telephony audio (G.711 u-law 8kHz -> 16kHz mono 16-bit PCM).
//
// HONESTY POSTURE (read before citing these numbers):
//   * These are evidence-weighted SIGNAL HEURISTICS, not a validated biometric
//     product. They measure measurable regularities and nothing else:
//       - F0 jitter          - synthesizers are near-periodic; humans are not
//       - loudness dynamics  - TTS/AGC-normalized audio has near-constant energy
//       - pause cadence      - generated speech pauses are unnaturally uniform
//       - exact repeats      - replayed/looped/stuck audio duplicates frame bytes
//   * Telephony invalidates cleanliness cues: after u-law + VAD, pauses in a
//     GENUINE call are digitally silent too. noiseFloorDb/silenceRatio are
//     therefore reported as features but carry ZERO scoring weight.
//   * Spectral cues are deliberately absent: at 8kHz telephony everything is
//     band-limited below 4kHz and codec-dominated, so spectral shape mostly
//     measures the codec, not the speaker.
//   * impersonationProbability is ALWAYS 0: telling a voice-converted clone
//     apart from a new genuine speaker needs enrollment data we do not have.
//     Fabricating a number there would violate the product's honesty posture.
//   * Too little audio (no F0-detectable voiced frames) -> all zeros. Absence
//     of evidence is neither authenticity nor fraud.
//
// CALIBRATION (measured with scripts/probe_voice.mjs on 2026-09-30 — rerun it
// against fresh recordings whenever thresholds move):
//   sine control        synthetic 0.88   (near-periodic, unnaturally uniform)
//   white noise         synthetic 0.00   (unvoiced -> no cues -> zeros)
//   TTS attack fixture  synthetic ~0.60   (digital-silence gaps + uniform pause
//                                          cadence; jitter cues fail — modern
//                                          TTS has human-like pitch dynamics)
//   ambience-baked TTS  synthetic ~0.00   (KNOWN EVASION: neural TTS with baked
//   (voice-design/clone)                room noise defeats every current cue.
//                                        Documented limitation, not hidden.)
//
// Weights over AVAILABLE features (renormalized): gapFloor 0.5,
// pauseRegularity 0.2, jitter 0.15, loudnessCV 0.15 — with the CORROBORATION
// RULE: gapFloor counts only when some prosody/cadence cue also scores > 0
// (a noise-gated human mic produces -110dB digital-silence gaps too — it
// alone scored 61% false-synthetic on a real voice before this rule).
// Thresholds are explicit calibration constants, not learned parameters -
// re-tune them with real recordings from your own instance before trusting
// field accuracy.

import type { VoiceAnalysis, VoiceAnalyzer } from './index.ts';

const SR = 16000;          // analysis sample rate (adapter upsampled 8k -> 16k)
const FRAME = 512;         // 32 ms analysis frame
const HOP = 256;           // 16 ms hop
const MIN_VOICED_FRAMES = 6;      // below this, prosody cues are not computable
const LEVEL_VOICED_DB = -45;      // frame loudness gate for "carries speech energy"
const SILENCE_DB = -50;           // frame considered pause
const F0_MIN_HZ = 50;
const F0_MAX_HZ = 400;
const F0_AUTOCORR_MIN = 0.30;     // periodicity confidence to accept an F0
const JITTER_NATURAL_CEILING = 0.005;   // humans modal jitter >= ~0.4-0.5%
const LOUDNESS_CV_NATURAL_FLOOR = 0.30; // real speech energy varies more than this
const MIN_PAUSES_FOR_REGULARITY = 4;
const REPEAT_BASELINE = 0.02;     // byte-identical non-silent frames above this...
const REPEAT_SATURATION = 0.15;   // ...ramps to a full replay score here
const GAP_FLOOR_NATURAL_DB = -60; // gaps with audible content (line noise etc.)
const GAP_FLOOR_SYNTHETIC_DB = -100; // digitally-gated gaps (TTS/VAD artifacts)
const MIN_PCM_BYTES = FRAME * 4;  // need at least a couple of frames

export interface SignalFeatures {
  voicedFrames: number;          // frames with an accepted F0
  levelFrames: number;           // frames above the speech-energy gate
  silenceRatio: number;          // reported, unscored
  noiseFloorDb: number;          // reported, unscored (whole-window percentile)
  /** 10th-percentile dB of INTERIOR gap frames — the scored cleanliness cue:
   *  absolute digital silence between utterances reads as synthetic; audible
   *  gap content (real line noise) reads as natural. */
  gapFloorDb: number | null;
  jitter: number | null;         // mean |dF0|/F0 over adjacent voiced frames
  loudnessCv: number | null;     // std/mean of energy over voiced frames
  pauseRegularity: number | null;// 1 = perfectly uniform pauses, null if <4
  repeatRatio: number | null;    // fraction of byte-identical non-silent frames
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function toSamples(pcm: Buffer): Float64Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2);
  return out;
}

function frameDb(x: Float64Array, start: number): number {
  let acc = 0;
  for (let i = start; i < start + FRAME; i++) acc += x[i] * x[i];
  const mean = acc / FRAME;
  if (mean <= 1e-12) return -120;
  return 10 * Math.log10(mean / (32768 * 32768));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx]!;
}

/**
 * Estimate F0 of one frame by normalized autocorrelation.
 * Returns null when no peak clears F0_AUTOCORR_MIN (unvoiced/noise).
 */
function estimateF0(x: Float64Array, start: number): number | null {
  const lagMin = Math.floor(SR / F0_MAX_HZ); // 40
  const lagMax = Math.min(Math.floor(SR / F0_MIN_HZ), FRAME - 1); // 320
  let r0 = 0;
  for (let i = start; i < start + FRAME; i++) r0 += x[i] * x[i];
  if (r0 <= 1e-9) return null;
  let best = 0;
  let bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let r = 0;
    const end = start + FRAME - lag;
    for (let i = start; i < end; i++) r += x[i] * x[i + lag];
    if (r > best) { best = r; bestLag = lag; }
  }
  if (bestLag === 0 || best / r0 < F0_AUTOCORR_MIN) return null;
  return SR / bestLag;
}

/** Extract the full feature vector from a 16kHz mono PCM window. */
export function computeFeatures(pcm: Buffer): SignalFeatures {
  const x = toSamples(pcm);
  const frameCount = x.length >= FRAME ? 1 + Math.floor((x.length - FRAME) / HOP) : 0;

  const dbs: number[] = [];
  const levelFlags: boolean[] = [];
  for (let f = 0; f < frameCount; f++) {
    const db = frameDb(x, f * HOP);
    dbs.push(db);
    levelFlags.push(db >= LEVEL_VOICED_DB);
  }
  const silenceFlags = dbs.map((d) => d < SILENCE_DB);
  const silenceRatio = frameCount ? silenceFlags.filter(Boolean).length / frameCount : 0;
  const noiseFloorDb = percentile(dbs, 0.1);

  // Interior gap floor: dB percentile of silent frames that sit BETWEEN
  // speech (first..last level frame). Absolute digital silence between
  // utterances is an artifact cue; audible gap content is natural.
  let gapFloorDb: number | null = null;
  const levelIdx: number[] = [];
  for (let f = 0; f < frameCount; f++) if (levelFlags[f]) levelIdx.push(f);
  if (levelIdx.length >= 10) {
    const first = levelIdx[0]!;
    const last = levelIdx[levelIdx.length - 1]!;
    const interiorSilence: number[] = [];
    for (let f = first; f <= last; f++) if (silenceFlags[f]) interiorSilence.push(dbs[f]!);
    if (interiorSilence.length >= 3) gapFloorDb = percentile(interiorSilence, 0.1);
  }

  // F0 per level-voiced frame (skip frames too close to the buffer edges for
  // the longest lag by simply letting estimateF0 bound its own loop).
  const f0: (number | null)[] = new Array(frameCount).fill(null);
  for (let f = 0; f < frameCount; f++) {
    if (levelFlags[f]) f0[f] = estimateF0(x, f * HOP);
  }
  const voicedIdx: number[] = [];
  for (let f = 0; f < frameCount; f++) if (f0[f] !== null) voicedIdx.push(f);

  // Jitter: adjacent voiced frames only (crossing a pause is not a pitch step).
  let jitter: number | null = null;
  if (voicedIdx.length >= MIN_VOICED_FRAMES) {
    const steps: number[] = [];
    for (let i = 1; i < voicedIdx.length; i++) {
      const a = voicedIdx[i - 1]!;
      const b = voicedIdx[i]!;
      if (b !== a + 1) continue;
      const f0a = f0[a]!;
      const f0b = f0[b]!;
      steps.push(Math.abs(f0b - f0a) / ((f0a + f0b) / 2));
    }
    if (steps.length >= 3) jitter = steps.reduce((s, v) => s + v, 0) / steps.length;
  }

  // Loudness variation across voiced frames (linear RMS).
  let loudnessCv: number | null = null;
  if (voicedIdx.length >= MIN_VOICED_FRAMES) {
    const rms = voicedIdx.map((f) => {
      let acc = 0;
      const start = f * HOP;
      for (let i = start; i < start + FRAME; i++) acc += x[i] * x[i];
      return Math.sqrt(acc / FRAME);
    });
    const mean = rms.reduce((s, v) => s + v, 0) / rms.length;
    if (mean > 1e-6) {
      const variance = rms.reduce((s, v) => s + (v - mean) ** 2, 0) / rms.length;
      loudnessCv = Math.sqrt(variance) / mean;
    }
  }

  // Pause-cadence regularity: runs of >=3 consecutive silent frames.
  let pauseRegularity: number | null = null;
  const pauseRuns: number[] = [];
  let run = 0;
  for (let f = 0; f < frameCount; f++) {
    if (silenceFlags[f]) run++;
    else {
      if (run >= 3) pauseRuns.push(run);
      run = 0;
    }
  }
  if (run >= 3) pauseRuns.push(run);
  if (pauseRuns.length >= MIN_PAUSES_FOR_REGULARITY) {
    const mean = pauseRuns.reduce((s, v) => s + v, 0) / pauseRuns.length;
    if (mean > 0) {
      const variance = pauseRuns.reduce((s, v) => s + (v - mean) ** 2, 0) / pauseRuns.length;
      pauseRegularity = clamp01(1 - Math.sqrt(variance) / mean);
    }
  }

  // Exact-repeat ratio over non-silent frames (replay / stuck-buffer cue).
  let repeatRatio: number | null = null;
  const seen = new Set<string>();
  let nonsilent = 0;
  let dups = 0;
  for (let f = 0; f < frameCount; f++) {
    if (silenceFlags[f]) continue;
    const start = f * HOP * 2; // byte offset (16-bit samples)
    const end = Math.min(start + FRAME * 2, pcm.length);
    if (end <= start) continue;
    const key = pcm.subarray(start, end).toString('base64');
    nonsilent++;
    if (seen.has(key)) dups++;
    else seen.add(key);
  }
  if (nonsilent >= MIN_VOICED_FRAMES) repeatRatio = dups / nonsilent;

  return {
    voicedFrames: voicedIdx.length,
    levelFrames: levelFlags.filter(Boolean).length,
    silenceRatio: round3(silenceRatio),
    noiseFloorDb: round3(noiseFloorDb),
    gapFloorDb: gapFloorDb !== null ? round3(gapFloorDb) : null,
    jitter: jitter !== null ? round3(jitter * 1000) / 1000 : null,
    loudnessCv: loudnessCv !== null ? round3(loudnessCv) : null,
    pauseRegularity: pauseRegularity !== null ? round3(pauseRegularity) : null,
    repeatRatio: repeatRatio !== null ? round3(repeatRatio) : null,
  };
}

/**
 * Default voice analyzer for the Connect adapter: scores real media-stream
 * audio in-process (sync, no network, no vendor). Passes `audioChunk` only —
 * without audio it returns all zeros rather than guessing.
 */
export class InHouseSignalAnalyzer implements VoiceAnalyzer {
  readonly id = 'in-house-signal-v1 (telephony heuristics — not a validated biometric vendor)';

  analyze(input: { contactId: string; customerPhoneNumber?: string; audioChunk?: Buffer }): VoiceAnalysis {
    const pcm = input.audioChunk;
    if (!pcm || pcm.length < MIN_PCM_BYTES) {
      return { syntheticProbability: 0, replayProbability: 0, impersonationProbability: 0 };
    }
    const f = computeFeatures(pcm);
    const others: { w: number; s: number }[] = [];
    if (f.pauseRegularity !== null) {
      others.push({ w: 0.2, s: f.pauseRegularity });
    }
    if (f.voicedFrames >= MIN_VOICED_FRAMES && f.jitter !== null) {
      others.push({ w: 0.15, s: clamp01((JITTER_NATURAL_CEILING - f.jitter) / JITTER_NATURAL_CEILING) });
    }
    if (f.voicedFrames >= MIN_VOICED_FRAMES && f.loudnessCv !== null) {
      others.push({ w: 0.15, s: clamp01((LOUDNESS_CV_NATURAL_FLOOR - f.loudnessCv) / LOUDNESS_CV_NATURAL_FLOOR) });
    }
    // CORROBORATION RULE: the gap-floor (cleanliness) cue only counts when at
    // least one prosodic/cadence cue also scores above zero. Consumer mics
    // noise-gate GENUINE speech into digital silence too — measured -110dB
    // interior gaps in a real human recording, which alone scored 61%
    // synthetic (false positive). The TTS attack fixture keeps its score
    // because its pause cadence is uniform (corroborating cue > 0); a gated
    // human voice drops to the prosody-only result.
    const corroborated = others.some(p => p.s > 0);
    const parts = [
      ...others,
      ...(f.gapFloorDb !== null && corroborated
        ? [{ w: 0.5, s: clamp01((f.gapFloorDb - GAP_FLOOR_NATURAL_DB) / (GAP_FLOOR_SYNTHETIC_DB - GAP_FLOOR_NATURAL_DB)) }]
        : []),
    ];
    const totalW = parts.reduce((a, p) => a + p.w, 0);
    const synthetic = totalW > 0
      ? parts.reduce((a, p) => a + p.w * p.s, 0) / totalW
      : 0;
    const replay = f.repeatRatio !== null
      ? clamp01((f.repeatRatio - REPEAT_BASELINE) / REPEAT_SATURATION)
      : 0;
    return {
      syntheticProbability: round3(synthetic),
      replayProbability: round3(replay),
      impersonationProbability: 0, // not measurable without enrollment — never fabricated
    };
  }
}