// Federation: signal merge + reputation scoring.
//
// ReputationScore for a fingerprint is a confidence-weighted, source-trust
// weighted, recency-decayed aggregate of the signals that reference it:
//   weight_i = confidence_i * severity_i * trust_i * 0.9^days_i
//   score    = 1 - Π(1 - w_i)   (noisy-OR, capped at 1)

import type { TrustSignal, TrustSignalKind } from './types.ts';

/** Merge two signal sets, deduping by signalId (first occurrence wins). */
export function mergeSignals(local: TrustSignal[], incoming: TrustSignal[]): TrustSignal[] {
  const seen = new Set<string>();
  const out: TrustSignal[] = [];
  for (const s of [...local, ...incoming]) {
    if (seen.has(s.signalId)) continue;
    seen.add(s.signalId);
    out.push(s);
  }
  return out;
}

export interface SourceTrustEntry {
  organizationId: string;
  /** 0..1 — how much we trust this reporting source. */
  trustScore: number;
}

export interface ReputationScore {
  /** 0..1 aggregate reputation impact (higher = more corroborated). */
  score: number;
  sources: string[];
  firstSeen: string;
  contributions: { signalId: string; kind: TrustSignalKind; organizationId: string; weight: number }[];
}

const HALF_LIFE_FACTOR = 0.9; // weight multiplier per day of age

export function decayWeight(createdAt: string, now: number = Date.now()): number {
  const days = Math.max(0, (now - Date.parse(createdAt)) / 86_400_000);
  return Math.pow(HALF_LIFE_FACTOR, days);
}

/** Weight of a single signal given source trust and age. */
export function signalWeight(signal: TrustSignal, trustByOrg: Map<string, number>, now: number = Date.now()): number {
  const trust = trustByOrg.get(signal.organizationId) ?? 0.5;
  const recency = decayWeight(signal.createdAt, now);
  return signal.confidence * signal.severity * trust * recency;
}

/**
 * Compute a ReputationScore for a fingerprint across the given (already
 * merged) signal set.
 */
export function computeReputation(
  fingerprint: string,
  signals: TrustSignal[],
  partnerTrust: SourceTrustEntry[] = [],
  now: number = Date.now(),
): ReputationScore {
  const trustByOrg = new Map(partnerTrust.map(p => [p.organizationId, p.trustScore]));
  const matching = signals.filter(s => s.fingerprint === fingerprint);
  const contributions = matching.map(s => ({
    signalId: s.signalId,
    kind: s.kind,
    organizationId: s.organizationId,
    weight: signalWeight(s, trustByOrg, now),
  }));
  // Noisy-OR combination of per-signal weights.
  let score = 0;
  for (const c of contributions) score = 1 - (1 - score) * (1 - Math.min(1, Math.max(0, c.weight)));
  score = Math.min(1, Math.round(score * 1e6) / 1e6);
  const firstSeen = matching.length
    ? matching.map(s => s.createdAt).sort()[0]!
    : '';
  return {
    score,
    sources: [...new Set(matching.map(s => s.organizationId))],
    firstSeen,
    contributions,
  };
}

/** Convenience: reputation lookup over a node's merged signal store. */
export function lookupFingerprint(
  fingerprint: string,
  signals: TrustSignal[],
  partnerTrust: SourceTrustEntry[] = [],
): ReputationScore {
  return computeReputation(fingerprint, signals, partnerTrust);
}
