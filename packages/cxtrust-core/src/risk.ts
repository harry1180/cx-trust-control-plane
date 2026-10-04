// Risk Fusion Engine — multi-dimensional, continuously updated.
// No single risk score: 11 dimensions, enterprise-configurable weighting,
// every point attributed to a reason. overall = weighted sum of attributed
// points (capped at 100) so explainability arithmetic is transparent.

import type { Detection, RiskDimension, RiskReason, RiskState } from './schema.ts';

export const DIMENSIONS: RiskDimension[] = [
  'IDENTITY_RISK', 'VOICE_RISK', 'TELEPHONY_RISK', 'FRAUD_RISK', 'CONVERSATION_RISK',
  'CYBER_RISK', 'AI_AGENT_RISK', 'DATA_RISK', 'COMPLIANCE_RISK', 'TRANSACTION_RISK',
  'BEHAVIORAL_RISK',
];

export type DimensionWeights = Partial<Record<RiskDimension, number>>;

export const DEFAULT_WEIGHTS: DimensionWeights = {
  IDENTITY_RISK: 1.0, VOICE_RISK: 1.0, TELEPHONY_RISK: 0.8, FRAUD_RISK: 1.0,
  CONVERSATION_RISK: 0.9, CYBER_RISK: 1.0, AI_AGENT_RISK: 1.0, DATA_RISK: 1.0,
  COMPLIANCE_RISK: 0.7, TRANSACTION_RISK: 0.9, BEHAVIORAL_RISK: 0.6,
};

const DIMENSION_OF: Record<string, RiskDimension> = {
  synthetic_voice: 'VOICE_RISK',
  replay_audio: 'VOICE_RISK',
  telephony_anomaly: 'TELEPHONY_RISK',
  account_takeover_pattern: 'FRAUD_RISK',
  otp_harvesting: 'FRAUD_RISK',
  pin_password_request: 'FRAUD_RISK',
  gift_card_scam: 'FRAUD_RISK',
  wire_transfer_pressure: 'FRAUD_RISK',
  credential_harvesting: 'FRAUD_RISK',
  urgency_coercion: 'BEHAVIORAL_RISK',
  authority_impersonation: 'BEHAVIORAL_RISK',
  reconnaissance: 'CONVERSATION_RISK',
  prompt_injection: 'CYBER_RISK',
  tool_abuse: 'AI_AGENT_RISK',
  data_exfiltration: 'DATA_RISK',
  pci_digits: 'COMPLIANCE_RISK',
  cvv_spoken: 'COMPLIANCE_RISK',
  ssn_spoken: 'COMPLIANCE_RISK',
  pii_email: 'DATA_RISK',
  pii_phone: 'DATA_RISK',
  // behavioral-biometrics seam (@cxtrust/biometrics provider codes)
  robo_cadence: 'BEHAVIORAL_RISK',
  script_following: 'BEHAVIORAL_RISK',
  urgency_escalation: 'BEHAVIORAL_RISK',
  wpm_anomaly: 'VOICE_RISK',
};

export interface RiskBoost {
  dimension: RiskDimension;
  points: number;
  label: string;
  source: string;
  offsetS?: number;
}

/**
 * Fuse prior risk state with new detections + context boosts.
 * Detections contribute weight*(0.5+0.5*confidence) points; boosts contribute
 * their explicit points. Each contribution is attributed to a dimension and
 * a reason; overall is the weighted sum capped at 100.
 */
export function fuseRisk(
  prev: RiskState | undefined,
  detections: Detection[],
  boosts: RiskBoost[] = [],
  weights: DimensionWeights = DEFAULT_WEIGHTS,
): RiskState {
  const dims = Object.fromEntries(DIMENSIONS.map(d => [d, 0])) as Record<RiskDimension, number>;
  const reasons: RiskReason[] = [];

  for (const d of detections) {
    const dim = DIMENSION_OF[d.code] ?? 'CONVERSATION_RISK';
    const pts = Math.round(d.weight * (0.5 + 0.5 * d.confidence));
    dims[dim] = Math.min(100, dims[dim] + pts);
    reasons.push({ points: pts, label: `${d.title} (${Math.round(d.confidence * 100)}%)`, source: d.detectionId });
  }
  for (const b of boosts) {
    dims[b.dimension] = Math.min(100, dims[b.dimension] + b.points);
    reasons.push({ points: b.points, label: b.label, source: b.source });
  }

  let overall = 0;
  const out = {} as Record<RiskDimension, number>;
  for (const d of DIMENSIONS) {
    // dimensions are monotonic within an interaction: new evidence can raise,
    // never silently erase, an earlier dimension score
    out[d] = Math.max(dims[d], prev?.dimensions[d] ?? 0);
    overall += out[d] * (weights[d] ?? 1);
  }
  overall = Math.min(100, Math.round(overall));
  // risk never decays instantly mid-interaction; keep monotonic non-decrease
  // within a session (relief only via explicit reducer, added in Phase 2)
  if (prev && prev.overall > overall) overall = prev.overall;
  return {
    overall,
    dimensions: out,
    reasons: [...(prev?.reasons ?? []), ...reasons],
    asOfOffsetS: detections[0]?.offsetS ?? boosts[0]?.offsetS ?? prev?.asOfOffsetS ?? 0,
  };
}
