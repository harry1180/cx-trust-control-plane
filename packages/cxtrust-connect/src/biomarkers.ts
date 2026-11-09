// Voice biomarkers: wellness BIOMARKERS + emotion ESTIMATE from prosody.
//
// HARD BOUNDARIES (read first):
//   * NOT a medical device, NOT a diagnosis. Every biomarker is an acoustic
//     MEASUREMENT with an association note AND a caveat. Nothing here says
//     "you have condition X" — persistent concerns go to a clinician.
//   * Emotion is an ESTIMATE of vocal activation from prosody alone. Research
//     accuracy for categorical emotion from acoustics is modest even for
//     trained systems; the confidence field reflects cue coverage, and the
//     disclaimer is mandatory in the payload.
//   * When a voiceprint baseline exists (enrolled with consent), comparable
//     values are shown as deviation from YOUR OWN baseline — honest because
//     it compares you to you, not to a fabricated population norm.
//   * No clinical validation data backs these thresholds; they are explicit
//     calibration constants. Limitations are always present in the report.
//
// RESEARCH GROUNDING (feature selection — measurement choices, NOT classifier
// or diagnostic claims):
//   * Menne F, Dörr F, Schräder J, Tröger J, Habel U, König A, Wagels L
//     (2024) "The voice of depression: speech features as biomarkers for
//     major depressive disorder". BMC Psychiatry 24:794.
//     https://doi.org/10.1186/s12888-024-06253-6 — among the largest reported
//     effect sizes were PITCH CONTOUR SLOPES (intonation trend over time) →
//     we implement pitchSlope.
//   * Rodrigo I, Duñabeitia JA (2025) "Listening to the Mind: Integrating
//     Vocal Biomarkers into Digital Health". Brain Sciences 15(7):762.
//     https://doi.org/10.3390/brainsci15070762 — recent review framing both
//     the promise and the validation requirements of vocal biomarkers.
//   * Riad R, Denais M, de Gennes M, et al. (2024) "Automated Speech
//     Analysis for Risk Detection of Depression, Anxiety, Insomnia, and
//     Fatigue: Algorithm Development and Validation Study". JMIR 2024;1:e58572.
//     https://www.jmir.org/2024/1/e58572 — validates the feature FAMILIES
//     used here (timing, pitch, energy, spectrum) while underscoring that
//     risk use requires supervised models + validated datasets.
//   * Paralinguistic correlates (spectral entropy, pitch variability, F0
//     statistics) — "Voice Biomarkers for Depression and Anxiety",
//     arXiv:2605.09908 (https://arxiv.org/abs/2605.09908), and the Mundt et
//     al. line of work (speech rate / percent pause time vs depression
//     severity; reviewed in https://pmc.ncbi.nlm.nih.gov/articles/PMC13109622/)
//     → we implement spectralEntropy + the pitch/timing stats.
// What we deliberately do NOT implement: supervised diagnostic classifiers —
// no labeled clinical dataset or validation study stands behind them here.
// Published correlations are group-level; every value below is an individual
// signal for review, never an inference about a condition.
//
// Features (speech frames > -50dB @16kHz mono): F0 statistics (Hz + semitone
// range), frame-to-frame pitch perturbation (approximate jitter), amplitude
// perturbation (approximate shimmer), 4–7Hz F0 tremor index, pause ratio,
// syllable-rate proxy (energy-peak count), energy decline slope, spectral
// centroid.

import { frameF0, fft, type VoiceprintTemplate } from './voiceprint.ts';

const SR = 16000;
const FRAME = 512;
const HOP = 256;
const SPEECH_DB = -50;
const MIN_SPEECH_FRAMES = 25;

export interface Biomarker {
  key: string;
  label: string;
  value: number;
  unit: string;
  note: string;                       // association + caveat (never a verdict)
  baselineDeviationPct?: number;      // vs enrolled voiceprint baseline, when available
}
export interface EmotionEstimate {
  activation: number;                 // 0..1
  label: string;
  candidates: string[];
  confidence: number;                 // 0..1 = cue coverage × duration factor
  disclaimer: string;
}
export interface BiomarkerReport {
  biomarkers: Biomarker[];
  emotion: EmotionEstimate;
  limitations: string[];
  analyzedDurationS: number;
  speechFrames: number;
  baselineUsed: boolean;
}

const round = (v: number, d = 3) => Math.round(v * 10 * d) / (10 * d);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const norm = (v: number, lo: number, hi: number) => clamp01((v - lo) / (hi - lo));

const EMOTION_DISCLAIMER =
  'Emotion is ESTIMATED from voice prosody alone and is inherently unreliable — '
  + 'treat it as a weak conversational signal, never as ground truth about how someone feels.';

const LIMITATIONS = [
  'Not a medical device; no diagnostic claims. Biomarkers are acoustic measurements with association notes only — persistent or concerning symptoms go to a clinician.',
  'Emotion estimates from acoustics alone are modest-accuracy even in research systems; confidence reflects cue coverage, not correctness.',
  'Room acoustics, microphone, distance, congestion and recent voice use all shift these values; compare trends, not single readings.',
  'No clinical validation dataset backs these thresholds — they are calibration constants, not medical reference ranges.',
];

function toSamples(pcm: Buffer): Float64Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2);
  return out;
}

/** Count energy peaks (syllable-nucleus proxy) on the smoothed RMS envelope. */
function syllableRate(envelope: number[], hopPerSec: number): number {
  // peak = local max above 45% of the mean speech envelope, min distance 120ms
  const mean = envelope.reduce((s, v) => s + v, 0) / Math.max(1, envelope.length);
  const minGap = Math.max(1, Math.round(0.12 * hopPerSec));
  let peaks = 0, last = -minGap;
  for (let i = 1; i < envelope.length - 1; i++) {
    if (envelope[i]! > mean * 0.45 && envelope[i]! >= envelope[i - 1]! && envelope[i]! > envelope[i + 1]! && i - last >= minGap) {
      peaks++; last = i;
    }
  }
  return peaks / Math.max(1, envelope.length / hopPerSec);
}

/** 4–7Hz oscillation strength of the F0 series (tremor band), 0..1. */
function tremorIndex(f0s: number[], hopPerSec: number): number {
  if (f0s.length < hopPerSec) return 0; // need >=1s
  const mean = f0s.reduce((s, v) => s + v, 0) / f0s.length;
  const x = f0s.map(v => v - mean);
  const variance = x.reduce((s, v) => s + v * v, 0);
  if (variance <= 1e-9) return 0;
  const lagLo = Math.max(1, Math.floor(hopPerSec / 7)); // ~4Hz
  const lagHi = Math.min(x.length - 2, Math.ceil(hopPerSec / 4)); // ~7Hz
  let best = 0;
  for (let lag = lagLo; lag <= lagHi; lag++) {
    let r = 0;
    for (let i = 0; i + lag < x.length; i++) r += x[i]! * x[i + lag]!;
    best = Math.max(best, r / variance);
  }
  return clamp01(best);
}

export function extractBiomarkers(pcm: Buffer, baseline?: VoiceprintTemplate | null): BiomarkerReport {
  const x = toSamples(pcm);
  const hopPerSec = SR / HOP;
  const frames = x.length >= FRAME ? 1 + Math.floor((x.length - FRAME) / HOP) : 0;

  const speechIdx: number[] = [];
  const rmsVals: number[] = [];
  const dbs: number[] = [];
  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    let e = 0;
    for (let i = start; i < start + FRAME; i++) e += x[i]! * x[i]!;
    const rms = Math.sqrt(e / FRAME);
    const db = rms > 1e-6 ? 20 * Math.log10(rms / 32768) : -120;
    dbs.push(db);
    rmsVals.push(rms);
    if (db >= SPEECH_DB) speechIdx.push(f);
  }

  // pause ratio over the whole window
  const silenceCount = dbs.filter(d => d < SPEECH_DB).length;
  const pauseRatio = frames ? silenceCount / frames : 0;

  // F0 series on speech frames
  const f0s: number[] = [];
  const amps: number[] = [];
  const f0Times: number[] = []; // seconds per voiced frame — pitch slope over time
  for (const f of speechIdx) {
    const f0 = frameF0(x, f * HOP);
    if (f0 !== null) { f0s.push(f0); f0Times.push((f * HOP) / SR); }
    amps.push(rmsVals[f]!);
  }

  const limited = speechIdx.length < MIN_SPEECH_FRAMES;
  const no = (key: string, label: string, unit: string, note: string): Biomarker => ({ key, label, value: 0, unit, note });

  if (limited) {
    return {
      biomarkers: [
        no('pitchVariability', 'Pitch variability', 'st', 'Needs >= ~0.4s of speech to measure.'),
        no('pauseRatio', 'Pause ratio', '%', `${Math.round(pauseRatio * 100)}% of the window was below the speech threshold — too little speech to analyze.`),
      ],
      emotion: { activation: 0, label: 'insufficient speech', candidates: [], confidence: 0, disclaimer: EMOTION_DISCLAIMER },
      limitations: LIMITATIONS,
      analyzedDurationS: Math.round((x.length / SR) * 10) / 10,
      speechFrames: speechIdx.length,
      baselineUsed: false,
    };
  }

  // ---- statistics ----
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  const st = (hz: number, ref: number) => 12 * Math.log2(hz / ref);

  const f0Mean = f0s.length ? mean(f0s) : 0;
  const f0Std = f0s.length ? std(f0s) : 0;
  const pitchRangeSemis = f0s.length > 2 ? st(Math.max(...f0s), Math.min(...f0s)) : 0;

  // frame-to-frame pitch perturbation (approximate jitter, %)
  let jitterPct = 0;
  if (f0s.length > 3) {
    const steps: number[] = [];
    for (let i = 1; i < f0s.length; i++) steps.push(Math.abs(f0s[i]! - f0s[i - 1]!) / ((f0s[i]! + f0s[i - 1]!) / 2));
    jitterPct = (mean(steps) * 100);
  }
  // amplitude perturbation (approximate shimmer, %)
  let shimmerPct = 0;
  if (amps.length > 3) {
    const steps: number[] = [];
    for (let i = 1; i < amps.length; i++) if (amps[i]! > 1e-6) steps.push(Math.abs(amps[i]! - amps[i - 1]!) / ((amps[i]! + amps[i - 1]!) / 2));
    if (steps.length) shimmerPct = mean(steps) * 100;
  }
  const tremor = tremorIndex(f0s, hopPerSec);

  // pitch contour slope: least-squares trend of F0 (semitones vs mean) over
  // time, st/s. A falling intonation trend is one of the largest reported
  // effect sizes for depressive speech (Menne et al. 2024, BMC Psychiatry).
  // Group-level correlate — never an individual diagnosis.
  let pitchSlopeStPerS = 0;
  if (f0s.length >= 10 && f0Mean > 0) {
    const ys = f0s.map(v => st(v, f0Mean));
    const n = ys.length;
    const xm = (f0Times[0]! + f0Times[n - 1]!) / 2, ym = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (f0Times[i]! - xm) * (ys[i]! - ym); den += (f0Times[i]! - xm) ** 2; }
    pitchSlopeStPerS = den ? num / den : 0;
  }

  // spectral entropy (normalized 0..1): complexity of the long-term spectrum.
  // Paralinguistic shifts in spectral structure accompany depressive/anxious
  // speech in the literature (Mundt et al. 2012 lineage; see header), but the
  // value also moves with codec, noise, and bandwidth — channel-aware
  // measurement, not a condition reading.
  let spectralEntropy = 0;
  {
    const hann = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FRAME - 1)));
    const Hs: number[] = [];
    const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
    for (let si = 0; si < speechIdx.length; si += 2) {
      const start = speechIdx[si]! * HOP;
      for (let i = 0; i < FRAME; i++) {
        const s = start + i;
        re[i] = s < x.length ? x[s]! * hann[i]! : 0;
        im[i] = 0;
      }
      fft(re, im);
      const pow: number[] = [];
      let total = 0;
      for (let k = 1; k <= FRAME / 2; k++) {
        const p = re[k]! * re[k]! + im[k]! * im[k]!;
        pow.push(p);
        total += p;
      }
      if (total <= 0) continue;
      let h = 0;
      for (const p of pow) { const q = p / total; if (q > 0) h -= q * Math.log(q); }
      Hs.push(h / Math.log(pow.length));
    }
    spectralEntropy = Hs.length ? mean(Hs) : 0;
  }

  // energy envelope over speech frames (for rate + decline), smoothed ~80ms
  // so windowing micro-ripples on sustained tones can't fake syllable peaks
  const rawEnv = speechIdx.map(f => rmsVals[f]!);
  const env = rawEnv.map((_, i) => {
    const a = Math.max(0, i - 2), b = Math.min(rawEnv.length, i + 3);
    let s = 0;
    for (let j = a; j < b; j++) s += rawEnv[j]!;
    return s / (b - a);
  });
  const syllRate = syllableRate(env, hopPerSec);
  // decline: least-squares slope of level (dB) over speech-frame order, per 10s
  let declineDbPer10s = 0;
  if (env.length > 10) {
    const ys = env.map(v => (v > 1e-6 ? 20 * Math.log10(v / 32768) : -120));
    const n = ys.length;
    const xm = (n - 1) / 2, ym = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - xm) * (ys[i]! - ym); den += (i - xm) ** 2; }
    const slopePerFrame = den ? num / den : 0;
    declineDbPer10s = slopePerFrame * (10 * hopPerSec); // frame→per 10 seconds
  }
  // spectral centroid (every 4th speech frame, via Goertzel-free FFT reuse: bin by zero-crossing proxy)
  // Use zero-crossing rate as a cheap brightness proxy (Hz) — no FFT needed here.
  let zcrMean = 0;
  {
    const zcrs: number[] = [];
    for (const f of speechIdx.slice(0, 400)) {
      const start = f * HOP;
      let z = 0;
      for (let i = start + 1; i < start + FRAME; i++) if ((x[i - 1]! >= 0) !== (x[i]! >= 0)) z++;
      zcrs.push(z / (FRAME / 2) * (SR / 2));
    }
    zcrMean = mean(zcrs);
  }

  // ---- baseline deviations (compare you to you) ----
  const dev = (current: number, base?: number | null): number | undefined => {
    if (base === undefined || base === null || !Number.isFinite(base) || Math.abs(base) < 1e-9) return undefined;
    return Math.round(((current - base) / Math.abs(base)) * 1000) / 10; // tenths of %
  };
  const basePitch = baseline?.pitch?.length === 3 ? baseline.pitch : null;
  const baselineUsed = !!basePitch;

  const biomarkers: Biomarker[] = [
    {
      key: 'pitchLevel', label: 'Pitch level (F0 mean)', value: Math.round(f0Mean), unit: 'Hz',
      note: 'Absolute pitch is highly individual (anatomy, sex, age, voice use) — meaningful only as deviation from your OWN enrolled baseline, never as a population comparison.',
      ...(basePitch ? { baselineDeviationPct: dev(f0Mean, basePitch[0]) } : {}),
    },
    {
      key: 'pitchVariability', label: 'Pitch variability (F0 std)', value: round(f0Std, 2), unit: 'Hz',
      note: 'Elevated variability can accompany emotional strain, urgency, or laryngeal tension; unusually low variability can accompany fatigue or flat affect. Context-dependent — not a diagnosis.',
      ...(basePitch ? { baselineDeviationPct: dev(f0Std, basePitch[1]) } : {}),
    },
    {
      key: 'pitchRange', label: 'Pitch range', value: round(pitchRangeSemis, 2), unit: 'semitones',
      note: 'Narrow range appears with restrained/low-energy speech, wide range with expressive or agitated speech. Association only — not a mood verdict.',
      ...(basePitch ? { baselineDeviationPct: dev(pitchRangeSemis, basePitch[2]) } : {}),
    },
    {
      key: 'pitchSlope', label: 'Pitch contour slope', value: round(pitchSlopeStPerS, 3), unit: 'st/s',
      note: 'Falling intonation over an utterance is among the largest reported acoustic correlates of depressive speech in group studies (Menne et al. 2024); rising slopes accompany energetic or questioning speech. Group-level correlation — not a diagnosis of this speaker.',
    },
    {
      key: 'pitchPerturbation', label: 'Pitch perturbation (jitter proxy)', value: round(jitterPct, 2), unit: '%',
      note: 'Elevated values are associated with vocal-fold irregularity (laryngitis, strain, aging, heavy voice use) — and also with noisy/loud conditions. Not a medical measurement.',
    },
    {
      key: 'amplitudePerturbation', label: 'Amplitude perturbation (shimmer proxy)', value: round(shimmerPct, 2), unit: '%',
      note: 'Elevated values can accompany breathiness, hoarseness, or microphone instability. Association only — not a diagnosis.',
    },
    {
      key: 'tremorIndex', label: 'Pitch tremor index (4–7Hz)', value: round(tremor), unit: '0..1',
      note: 'Visible periodic pitch oscillation can accompany fatigue, stress, caffeine, or neurological conditions when persistent. Occasional values are normal — see a clinician for persistent concerns.',
    },
    {
      key: 'pauseRatio', label: 'Pause ratio', value: Math.round(pauseRatio * 1000) / 10, unit: '%',
      note: 'Elevated pause ratio can accompany breathing effort, pain, cognitive load, or simply thoughtful speech. Not a diagnosis.',
    },
    {
      key: 'speechRate', label: 'Speech rate (syllable proxy)', value: round(syllRate, 2), unit: 'est/s',
      note: 'Reduced rate can accompany fatigue, sedation, or pain; elevated rate can accompany agitation. Rough energy-peak proxy, not linguistic syllable counting.',
    },
    {
      key: 'energyDecline', label: 'Energy decline over utterance', value: round(declineDbPer10s, 2), unit: 'dB/10s',
      note: 'Declining energy across an utterance can indicate vocal fatigability or reduced effort; rising levels can indicate warming-up or escalation. Association only.',
      ...(baselineUsed ? { baselineDeviationPct: undefined } : {}),
    },
    {
      key: 'brightness', label: 'Spectral brightness (ZCR proxy)', value: Math.round(zcrMean), unit: 'Hz',
      note: 'Higher brightness can accompany tension or a lighter voice quality; lower values accompany darker/muffled recordings. Sensitive to microphone and distance.',
    },
    {
      key: 'spectralEntropy', label: 'Spectral entropy', value: round(spectralEntropy, 3), unit: '0..1',
      note: 'Reduced spectral complexity is reported alongside flat affect/depressive speech (Mundt et al. 2012 lineage); values also shift with codec, noise and audio bandwidth. Measurement with a caveat — not a mental-health reading.',
    },
  ];

  // ---- emotion estimate (activation from prosody) ----
  const cuesAvailable = [pitchRangeSemis > 0, env.length > 5, syllRate >= 0, f0s.length >= 5].filter(Boolean).length;
  const activation = clamp01(
    0.32 * norm(pitchRangeSemis, 1, 12)
    + 0.26 * norm(std(env) / Math.max(1e-6, mean(env)), 0.05, 0.75)
    + 0.24 * norm(syllRate, 1, 6)
    + 0.18 * (1 - norm(pauseRatio, 0.05, 0.6)),
  );
  const durationFactor = Math.min(1, (speechIdx.length / hopPerSec) / 4); // full confidence at >=4s speech
  const label = activation >= 0.66
    ? 'high activation — excited, stressed, or agitated-likelier'
    : activation >= 0.34
      ? 'moderate activation — neutral/engaged-likelier'
      : 'low activation — calm, fatigued, or low-mood-likelier';
  const emotion: EmotionEstimate = {
    activation: round(activation),
    label,
    candidates: activation >= 0.66 ? ['excited', 'stressed', 'angry', 'anxious']
      : activation >= 0.34 ? ['neutral', 'engaged', 'conversational']
        : ['calm', 'tired', 'sad', 'distracted'],
    confidence: round(clamp01((cuesAvailable / 4) * durationFactor)),
    disclaimer: EMOTION_DISCLAIMER,
  };

  return {
    biomarkers,
    emotion,
    limitations: LIMITATIONS,
    analyzedDurationS: Math.round((x.length / SR) * 10) / 10,
    speechFrames: speechIdx.length,
    baselineUsed,
  };
}