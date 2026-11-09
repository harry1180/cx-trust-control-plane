// Behavioral biometrics detectors. Each detector:
//   - takes a ParticipantFeatures (from features.ts) + conversation context;
//   - returns a Detection-shaped object or null when evidence is too thin;
//   - NEVER fires on insufficient data; confidence scales with sample size.
//
// Detectors are pure: no I/O, no clock, no randomness (detectionId is supplied
// by the caller via DetectionContext).

import type { BehavioralFeatures, ParticipantFeatures, BehaviorTurn } from './features.ts';
import { extractFeatures } from './features.ts';

export interface Detection {
  detectionId: string;
  participantId?: string;
  code: string;
  title: string;
  /** 0..1 */
  confidence: number;
  /** 0..100 contribution weight applied by risk fusion */
  weight: number;
  evidence: { kind: 'behavior'; text: string; locator?: string }[];
  providerId: string;
}

export interface DetectionContext {
  interactionId: string;
  /** ISO timestamp of the evaluation moment */
  now: string;
  /** seconds into the interaction */
  offsetS: number;
  /** stable suffix (e.g. sequence number) used to build detectionId */
  seq?: number;
}

type Detector = (p: ParticipantFeatures, ctx: DetectionContext) => Detection | null;

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function mkDetection(pid: string, code: string, title: string, confidence: number,
  weight: number, evidenceText: string[], ctx: DetectionContext): Detection {
  const suffix = ctx.seq !== undefined ? `-${ctx.seq}` : '';
  return {
    detectionId: `det-${ctx.interactionId}-${code}${suffix}`,
    participantId: pid,
    code,
    title,
    confidence: round(Math.min(1, Math.max(0, confidence)), 3),
    weight,
    evidence: evidenceText.map((text) => ({ kind: 'behavior' as const, text, locator: 'behavioral-v1' })),
    providerId: 'behavioral-v1',
  };
}

function fmt(n: number): string {
  return String(round(n));
}

// ---------- (a) robo_cadence ----------
// Inhumanly regular turn gaps: perfectly spaced replies are the signature of
// a bot reading a script or a caller hammering IVR keys.
export const roboCadence: Detector = (p, ctx) => {
  const f: BehavioralFeatures = p.features;
  if (f.turnGaps.length < 3) return null; // need >=4 turns
  if (!(f.gapVariance < 0.05)) return null;
  if (!(f.meanGapS < 2.5)) return null;
  // confidence grows with the number of regular gaps
  const confidence = Math.min(0.95, 0.6 + 0.08 * f.turnGaps.length);
  return mkDetection(p.participantId, 'robo_cadence', 'Robotic turn cadence (bot/IVR signature)',
    confidence, 14, [
      `gap variance ${fmt(f.gapVariance)}s over ${f.turnGaps.length + 1} turns`,
      `mean gap ${fmt(f.meanGapS)}s — metronomic reply spacing`,
    ], ctx);
};

// ---------- (b) script_following ----------
// High 3-gram repetition with no questions = reading a rehearsed script
// (classic social-engineering opener).
export const scriptFollowing: Detector = (p, ctx) => {
  const f = p.features;
  if (p.turns.length < 3) return null;
  if (!(f.repetitionScore > 0.6)) return null;
  if (!(f.questionRatio < 0.34)) return null;
  const confidence = Math.min(0.95, 0.5 + 0.15 * p.turns.length);
  return mkDetection(p.participantId, 'script_following', 'Rehearsed-script delivery (social-engineering pattern)',
    confidence, 12, [
      `3-gram repetition score ${fmt(f.repetitionScore)} over ${p.turns.length} turns`,
      `question ratio ${fmt(f.questionRatio)} — no genuine conversational probing`,
    ], ctx);
};

// ---------- (c) urgency_escalation ----------
// Urgency marker density rising across the conversation: last third more
// than double the first third, with at least 3 urgency turns total.
export const urgencyEscalation: Detector = (p, ctx) => {
  const turns = p.turns;
  if (turns.length < 6) return null;
  const urgencyRe = /\b(now|immediately|right away|today|hurry)\b|[!]/i;
  const urgentCount = turns.filter((t) => urgencyRe.test(t.text)).length;
  if (urgentCount < 3) return null;
  const third = Math.floor(turns.length / 3);
  const first = turns.slice(0, third);
  const last = turns.slice(-third);
  const firstDensity = first.length === 0 ? 0 : first.filter((t) => urgencyRe.test(t.text)).length / first.length;
  const lastDensity = last.length === 0 ? 0 : last.filter((t) => urgencyRe.test(t.text)).length / last.length;
  if (!(lastDensity > 2 * firstDensity)) return null;
  const confidence = Math.min(0.95, 0.55 + 0.1 * urgentCount);
  return mkDetection(p.participantId, 'urgency_escalation', 'Urgency pressure escalating over the call',
    confidence, 12, [
      `urgency density rose ${fmt(firstDensity)} -> ${fmt(lastDensity)} (first third -> last third)`,
      `${urgentCount} of ${turns.length} turns carried urgency markers`,
    ], ctx);
};

// ---------- (d) wpm_anomaly ----------
// Speaking rate far outside the human conversational band sustained across
// >=3 turns: playback of recorded/TTS speech at wrong speed.
const WPM_LOW = 100;
const WPM_HIGH = 220;
export const wpmAnomaly: Detector = (p, ctx) => {
  const f = p.features;
  const turns = p.turns;
  if (turns.length < 4) return null; // WPM defined from turn 2 onward; need >=3 sampled turns
  const wpmPerTurn: number[] = [];
  for (let i = 1; i < turns.length; i++) {
    const dur = Math.min(60, Math.max(3, turns[i].offsetS - turns[i - 1].offsetS));
    const wc = turns[i].text.split(/\s+/).filter(Boolean).length;
    wpmPerTurn.push((wc / dur) * 60);
  }
  const outOfBand = wpmPerTurn.filter((w) => w < WPM_LOW || w > WPM_HIGH);
  if (outOfBand.length < 3) return null;
  const allOut = outOfBand.length === wpmPerTurn.length;
  const lowCount = outOfBand.filter((w) => w < WPM_LOW).length;
  const highCount = outOfBand.length - lowCount;
  const direction = highCount > lowCount ? 'above' : 'below';
  const confidence = Math.min(0.95, 0.6 + 0.1 * outOfBand.length) * (allOut ? 1 : 0.85);
  return mkDetection(p.participantId, 'wpm_anomaly', 'Speech rate far outside human band (TTS/tape-speed indicator)',
    confidence, 10, [
      `${outOfBand.length}/${wpmPerTurn.length} measured turns ${direction} the ${WPM_LOW}-${WPM_HIGH} WPM human band`,
      `mean WPM ${fmt(f.wordsPerMinute)}, burstiness ${fmt(f.burstiness)}`,
      `turn gaps used as duration estimate: ${turns.slice(0, 5).map((t) => t.offsetS).join(', ')}...`,
    ], ctx);
};

export const DETECTORS: Detector[] = [roboCadence, scriptFollowing, urgencyEscalation, wpmAnomaly];

/**
 * Analyze behavior for ALL participants; returns one Detection per firing
 * detector, each attributed to the flagged participant via participantId.
 * Pure: deterministic given (turns, ctx).
 */
export function analyzeBehavior(turns: BehaviorTurn[], ctx: DetectionContext): Detection[] {
  const perParticipant = extractFeatures(turns);
  const out: Detection[] = [];
  for (const pf of perParticipant) {
    for (const det of DETECTORS) {
      const d = det(pf, ctx);
      if (d) out.push(d);
    }
  }
  return out;
}
