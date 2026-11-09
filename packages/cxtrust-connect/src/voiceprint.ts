// In-house voiceprint: speaker enrollment + 1:1 verification, consent-gated.
//
// HONESTY POSTURE (same rules as voicebiometrics.ts):
//   * Speaker SIMILARITY heuristics computed from scratch (MFCC statistics,
//     pitch statistics, energy stats) — NOT a biometric-grade vendor system.
//     A match means "acoustically similar to the enrolled template under this
//     weighting", nothing about identity certainty.
//   * Enrollment REQUIRES explicit consent (consent: true + consentBy); the
//     consent record is stored WITH the template and returned by status.
//     Without consent the request is rejected before any audio is processed.
//   * The stored template is derived statistics (a ~31-number vector) — raw
//     audio is NEVER persisted. Template file is local + gitignored.
//   * No enrollment → verification returns 400, never a fabricated score.
//
// Feature vector per utterance (speech-bearing frames only, 16kHz mono PCM):
//   13 MFCC means · 13 MFCC std-devs · F0 median/std/range · energy mean/std
// Similarity = weighted cosine of the three blocks:
//   mfcc-mean 0.45 · mfcc-std 0.25 · pitch 0.30
// Match when similarity >= threshold (env CXTRUST_VOICEPRINT_THRESHOLD,
// default 0.80, read at request time — calibrate with real recordings).

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 16000;
const FRAME = 512;
const HOP = 256;
const N_MFCC = 13;
const N_FILTERS = 26;
const SPEECH_DB = -50;        // frames above this carry speech energy
const MIN_SPEECH_FRAMES = 25; // ~0.4s of speech minimum
const DEFAULT_THRESHOLD = 0.80;
const W_MEAN = 0.45, W_STD = 0.25, W_PITCH = 0.30;

export interface VoiceprintConsent {
  at: string;
  by: string;
  note: string;
}
export interface VoiceprintTemplate {
  vector: number[];           // derived stats only — never raw audio
  mfccMean: number[];
  mfccStd: number[];
  pitch: number[];            // [median, std, range] or [] if unvoiced
  enrolledAt: string;
  consent: VoiceprintConsent;
  label?: string;
  durationS: number;
}
export interface VerifyResult {
  similarity: number;
  match: boolean;
  threshold: number;
  parts: { mfccMean: number; mfccStd: number; pitch: number };
}

// ---------- signal helpers ----------

function toSamples(pcm: Buffer): Float64Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2);
  return out;
}

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function melOf(hz: number): number { return 2595 * Math.log10(1 + hz / 700); }
function hzOf(mel: number): number { return 700 * (10 ** (mel / 2595) - 1); }

const hann = new Float64Array(FRAME);
for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

// mel filterbank centers (computed once)
const filterEdges: number[][] = (() => {
  const lo = melOf(0), hi = melOf(SR / 2);
  const centers: number[] = [];
  for (let i = 0; i < N_FILTERS + 2; i++) centers.push(hzOf(lo + ((hi - lo) * i) / (N_FILTERS + 1)));
  const bins = centers.map(c => Math.round((c / (SR / 2)) * (FRAME / 2)));
  const out: number[][] = [];
  for (let m = 1; m <= N_FILTERS; m++) out.push([bins[m - 1]!, bins[m]!, bins[m + 1]!]);
  return out;
})();

/** DCT-II of log filterbank energies → N_MFCC coefficients. */
function dct13(logE: number[]): number[] {
  const out: number[] = [];
  const N = logE.length;
  for (let k = 0; k < N_MFCC; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += logE[n]! * Math.cos((Math.PI * k * (2 * n + 1)) / (2 * N));
    out.push(s * Math.sqrt(2 / N));
  }
  return out;
}

/** Frame-level F0 by normalized autocorrelation (same method as voicebiometrics). */
export function frameF0(x: Float64Array, start: number): number | null {
  const lagMin = Math.floor(SR / 400), lagMax = Math.min(Math.floor(SR / 50), FRAME - 1);
  let r0 = 0;
  for (let i = start; i < start + FRAME; i++) r0 += x[i] * x[i];
  if (r0 <= 1e-9) return null;
  let best = 0, bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let r = 0;
    const end = start + FRAME - lag;
    for (let i = start; i < end; i++) r += x[i] * x[i + lag];
    if (r > best) { best = r; bestLag = lag; }
  }
  if (bestLag === 0 || best / r0 < 0.30) return null;
  return SR / bestLag;
}

export interface UtteranceStats {
  mfccMean: number[]; mfccStd: number[]; pitch: number[];
  energyMean: number; energyStd: number; speechFrames: number; durationS: number;
}

/** Extract speaker statistics from 16kHz mono PCM. Null when too little speech. */
export function extractSpeakerStats(pcm: Buffer): UtteranceStats | null {
  const x = toSamples(pcm);
  const frames = x.length >= FRAME ? 1 + Math.floor((x.length - FRAME) / HOP) : 0;
  const mfccs: number[][] = [];
  const f0s: number[] = [];
  const energies: number[] = [];
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);

  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    let e = 0;
    for (let i = 0; i < FRAME; i++) { const v = x[start + i]!; e += v * v; }
    const rms = Math.sqrt(e / FRAME);
    const db = rms > 1e-6 ? 20 * Math.log10(rms / 32768) : -120;
    if (db < SPEECH_DB) continue;
    energies.push(rms);
    // spectrum
    for (let i = 0; i < FRAME; i++) { re[i] = x[start + i]! * hann[i]!; im[i] = 0; }
    fft(re, im);
    const pow = new Float64Array(FRAME / 2);
    for (let i = 0; i < FRAME / 2; i++) pow[i] = (re[i]! * re[i]! + im[i]! * im[i]!) / FRAME;
    // mel filterbank
    const logE: number[] = [];
    for (const [b0, b1, b2] of filterEdges) {
      let s = 0;
      for (let b = b0 ?? 0; b < (b1 ?? 1); b++) s += (pow[b] ?? 0) * ((b - (b0 ?? 0)) / Math.max(1, (b1 ?? 1) - (b0 ?? 0)));
      for (let b = b1 ?? 1; b <= (b2 ?? 2); b++) s += (pow[b] ?? 0) * (((b2 ?? 2) - b) / Math.max(1, (b2 ?? 2) - (b1 ?? 1)));
      logE.push(Math.log(s + 1e-10));
    }
    mfccs.push(dct13(logE));
    const f0 = frameF0(x, start);
    if (f0 !== null) f0s.push(f0);
  }

  if (mfccs.length < MIN_SPEECH_FRAMES) return null;

  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a: number[]) => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  const mfccMean: number[] = [], mfccStd: number[] = [];
  for (let k = 0; k < N_MFCC; k++) {
    const col = mfccs.map(c => c[k]!);
    mfccMean.push(mean(col)); mfccStd.push(std(col));
  }
  let pitch: number[] = [];
  if (f0s.length >= 5) {
    const sorted = [...f0s].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)]!;
    const range = sorted[sorted.length - 1]! - sorted[0]!;
    pitch = [med, std(f0s), range];
  }
  return {
    mfccMean, mfccStd, pitch,
    energyMean: mean(energies), energyStd: std(energies),
    speechFrames: mfccs.length,
    durationS: Math.round((x.length / SR) * 10) / 10,
  };
}

function cos(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Compare two utterance stats against a stored template. */
export function similarityOf(t: VoiceprintTemplate, s: UtteranceStats): VerifyResult {
  const parts = {
    mfccMean: cos(t.mfccMean, s.mfccMean),
    mfccStd: cos(t.mfccStd, s.mfccStd),
    pitch: t.pitch.length && s.pitch.length ? cos(t.pitch, s.pitch) : 0,
  };
  // pitch only counts when BOTH sides have it — otherwise renormalize
  const havePitch = t.pitch.length > 0 && s.pitch.length > 0;
  const wSum = W_MEAN + W_STD + (havePitch ? W_PITCH : 0);
  const similarity = (W_MEAN * parts.mfccMean + W_STD * parts.mfccStd + (havePitch ? W_PITCH * parts.pitch : 0)) / wSum;
  const threshold = Number(process.env.CXTRUST_VOICEPRINT_THRESHOLD ?? DEFAULT_THRESHOLD); // request-time
  return {
    similarity: Math.round(Math.max(0, similarity) * 1000) / 1000,
    match: similarity >= threshold,
    threshold,
    parts,
  };
}

// ---------- consent-gated store (template file, never raw audio) ----------

let cache: VoiceprintTemplate | null | undefined;

function storePath(): string {
  return process.env.CXTRUST_VOICEPRINT_FILE
    ?? fileURLToPath(new URL('../.voiceprint-store.json', import.meta.url));
}

function load(): VoiceprintTemplate | null {
  if (cache !== undefined) return cache;
  try {
    if (existsSync(storePath())) cache = JSON.parse(readFileSync(storePath(), 'utf8')) as VoiceprintTemplate;
    else cache = null;
  } catch { cache = null; }
  return cache;
}

/** Enroll — REJECTS before processing anything unless consent is explicit. */
export function enrollVoiceprint(input: {
  consent: unknown; consentBy?: unknown; label?: unknown; pcm: Buffer;
}): { ok: true; template: VoiceprintTemplate; stats: UtteranceStats } | { ok: false; error: string; status: number } {
  if (input.consent !== true) {
    return { ok: false, status: 400, error: 'consent required: explicit consent must be granted before voice enrollment (consent: true)' };
  }
  const consentBy = String(input.consentBy ?? 'unspecified').slice(0, 120);
  const stats = extractSpeakerStats(input.pcm);
  if (!stats) {
    return { ok: false, status: 400, error: `not enough speech audio to build a template (need >= ~0.4s above -50dB at 16kHz mono PCM; got ${Math.round(input.pcm.length / 2 / SR * 10) / 10}s)` };
  }
  const template: VoiceprintTemplate = {
    vector: [...stats.mfccMean, ...stats.mfccStd, ...stats.pitch],
    mfccMean: stats.mfccMean, mfccStd: stats.mfccStd, pitch: stats.pitch,
    enrolledAt: new Date().toISOString(),
    consent: { at: new Date().toISOString(), by: consentBy, note: 'Enrollment consent granted explicitly via the console voice biometrics card.' },
    label: input.label ? String(input.label).slice(0, 80) : undefined,
    durationS: stats.durationS,
  };
  cache = template;
  try {
    const p = storePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(template, null, 2));
  } catch { /* in-memory only if the path is unwritable */ }
  return { ok: true, template, stats };
}

export function voiceprintStatus(): { enrolled: boolean; template: Omit<VoiceprintTemplate, 'vector' | 'mfccMean' | 'mfccStd' | 'pitch'> | null } {
  const t = load();
  if (!t) return { enrolled: false, template: null };
  const { vector: _v, mfccMean: _m, mfccStd: _s, pitch: _p, ...rest } = t;
  return { enrolled: true, template: rest };
}

export function verifyVoiceprint(pcm: Buffer): { ok: true; result: VerifyResult; stats: UtteranceStats } | { ok: false; error: string; status: number } {
  const t = load();
  if (!t) return { ok: false, status: 400, error: 'no voiceprint enrolled — enroll with consent first' };
  const stats = extractSpeakerStats(pcm);
  if (!stats) return { ok: false, status: 400, error: 'not enough speech audio to verify (need >= ~0.4s above -50dB)' };
  return { ok: true, result: similarityOf(t, stats), stats };
}

/** Test/diagnostic hook: drop the in-process cache (does not delete the file). */
export function _resetVoiceprintCache(): void { cache = undefined; }

/** Remove the enrolled template (and its consent record) permanently. */
export function deleteVoiceprint(): { deleted: boolean } {
  const existed = load() !== null;
  cache = null;
  try { if (existsSync(storePath())) unlinkSync(storePath()); } catch { /* already gone */ }
  return { deleted: existed };
}

/** Full template (incl. vector) for baseline comparisons — never exposed via HTTP. */
export function getVoiceprintTemplate(): VoiceprintTemplate | null {
  return load();
}

export const VOICEPRINT_THRESHOLD_DEFAULT = DEFAULT_THRESHOLD;