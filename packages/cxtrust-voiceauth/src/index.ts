// VoiceAuthenticityEngine — pluggable voice-authenticity / spoof-detection
// contract with RISK-NOT-VERDICT semantics (charter requirement):
//
//   Never accuse a caller of fraud based on one model output. Return
//   risk + confidence + evidence + model + limitations, and let the policy
//   engine decide what to do.
//
// The existing voice-trust seam (core VoiceDetectionProvider + simulated
// provider) covers classification; this package adds the ASVspoof-style
// evaluation harness + honest reporting contract for real vendors.

import type { Detection } from '@cxtrust/core';

export interface VoiceAuthenticityInput {
  participantId: string;
  /** opaque audio reference (the engine never receives raw PII audio in evidence) */
  audioRef: string;
  /** duration seconds */
  durationS?: number;
  /** claimed caller identity, if known */
  claimedIdentity?: string;
}

export interface VoiceAuthenticityVerdict {
  engine: string;
  model?: string;
  modelVersion?: string;
  /** 0..1 — higher = more likely synthetic/spoofed */
  syntheticRisk: number;
  /** model confidence in its own score */
  confidence: number;
  evidence: { signal: string; detail: string }[];
  /** explicit limitations — REQUIRED, honest scope (e.g. 'not validated on TDM codec audio') */
  limitations: string[];
  /** false-accept / false-reject estimates if the vendor publishes them */
  publishedEER?: { far: number; frr: number; source: string };
}

/** The contract every voice-authenticity vendor adapter implements. */
export interface VoiceAuthenticityEngine {
  readonly engineId: string;
  evaluate(input: VoiceAuthenticityInput): Promise<VoiceAuthenticityVerdict>;
}

/** Convert a verdict into a core Detection the session can ingest. */
export function verdictToDetection(verdict: VoiceAuthenticityVerdict, interactionId: string, offsetS: number): Detection {
  return {
    detectionId: `det-${interactionId}-voice_authenticity-${offsetS}-${Math.floor(Math.random() * 1e6)}`,
    interactionId,
    participantId: undefined,
    category: 'VOICE_TRUST',
    code: 'voice_authenticity_risk',
    title: `Voice authenticity risk ${verdict.syntheticRisk.toFixed(2)} (${verdict.engine})`,
    confidence: verdict.confidence,
    weight: Math.round(verdict.syntheticRisk * 30),
    ts: new Date().toISOString(),
    offsetS,
    evidence: verdict.evidence.map(e => ({ kind: 'audio_signal' as const, text: `${e.signal}: ${e.detail}`, locator: 'voice-authenticity' })),
    providerId: verdict.engine,
  };
}

// ---------- Evaluation harness (ASVspoof-style, offline) ----------

export interface SpoofTrial {
  trialId: string;
  isGenuine: boolean;
  /** engine score for the trial (0..1 synthetic risk) */
  score: number;
}

export interface SpoofMetrics {
  trials: number;
  genuine: number;
  spoofed: number;
  /** score threshold used */
  threshold: number;
  /** false accept: fraction of spoofed trials scored below threshold */
  falseAcceptRate: number;
  /** false reject: fraction of genuine trials scored above threshold */
  falseRejectRate: number;
  accuracy: number;
  eer: number;
}

/** Compute FAR/FRR/EER/accuracy over labeled trials at a threshold. */
export function evaluateSpoofTrials(trials: SpoofTrial[], threshold = 0.5): SpoofMetrics {
  if (!trials.length) return { trials: 0, genuine: 0, spoofed: 0, threshold, falseAcceptRate: 0, falseRejectRate: 0, accuracy: 0, eer: 0 };
  const genuine = trials.filter(t => t.isGenuine);
  const spoofed = trials.filter(t => !t.isGenuine);
  const falseAccept = spoofed.filter(t => t.score < threshold).length;
  const falseReject = genuine.filter(t => t.score >= threshold).length;
  const accuracy = (spoofed.filter(t => t.score >= threshold).length + genuine.filter(t => t.score < threshold).length) / trials.length;
  // EER: sweep thresholds, find where FAR ≈ FRR
  let eer = 0;
  let bestDelta = Infinity;
  for (let th = 0; th <= 1.0001; th += 0.01) {
    const far = spoofed.length ? spoofed.filter(t => t.score < th).length / spoofed.length : 0;
    const frr = genuine.length ? genuine.filter(t => t.score >= th).length / genuine.length : 0;
    const delta = Math.abs(far - frr);
    if (delta < bestDelta) { bestDelta = delta; eer = (far + frr) / 2; }
  }
  return {
    trials: trials.length, genuine: genuine.length, spoofed: spoofed.length, threshold,
    falseAcceptRate: spoofed.length ? falseAccept / spoofed.length : 0,
    falseRejectRate: genuine.length ? falseReject / genuine.length : 0,
    accuracy, eer,
  };
}

// ---------- Demo engine (explicitly labeled, never a real model) ----------

/** Deterministic demo engine: risk derived from the audioRef hash — for tests
 * and demos ONLY; limitations state that plainly. */
export class DemoVoiceAuthenticityEngine implements VoiceAuthenticityEngine {
  readonly engineId = 'demo-voice-authenticity';
  async evaluate(input: VoiceAuthenticityInput): Promise<VoiceAuthenticityVerdict> {
    let h = 0;
    for (const ch of input.audioRef) h = (h * 31 + ch.charCodeAt(0)) % 1000;
    const syntheticRisk = h / 1000;
    return {
      engine: this.engineId,
      model: 'deterministic-hash-demo',
      syntheticRisk,
      confidence: 0.5,
      evidence: [{ signal: 'hash', detail: `audioRef digest bucket ${h}` }],
      limitations: [
        'DEMO ONLY — a hash, not a model. Never use for real decisions.',
        'No codec/telephony validation whatsoever.',
      ],
    };
  }
}