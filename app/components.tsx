import type { EnforcementAction, IncidentSeverity, TrustClassification } from '@cxtrust/core';

export function riskColor(risk: number): string {
  if (risk >= 70) return 'var(--red)';
  if (risk >= 40) return 'var(--amber)';
  if (risk >= 15) return 'var(--blue)';
  return 'var(--green)';
}

export function RiskPill({ risk }: { risk: number }) {
  const cls = risk >= 70 ? 'pill-red' : risk >= 40 ? 'pill-amber' : risk >= 15 ? 'pill-blue' : 'pill-green';
  return <span className={`pill ${cls} mono`}>RISK {risk}</span>;
}

const CLASS_COLOR: Record<TrustClassification, string> = {
  HUMAN_VERIFIED: 'pill-green', HUMAN_UNKNOWN: 'pill-gray', HUMAN_SUSPECTED: 'pill-amber',
  HUMAN_IMPERSONATION_RISK: 'pill-red', AUTHORIZED_ENTERPRISE_AI: 'pill-green',
  VERIFIED_THIRD_PARTY_AI: 'pill-green', KNOWN_EXTERNAL_AI: 'pill-blue',
  UNKNOWN_AI: 'pill-amber', MALICIOUS_AUTOMATION: 'pill-red', SYNTHETIC_IDENTITY: 'pill-red',
  REPLAYED_AUDIO: 'pill-red', UNKNOWN_PARTICIPANT: 'pill-gray',
};

export function ClassificationPill({ c }: { c: TrustClassification }) {
  return <span className={`pill ${CLASS_COLOR[c] ?? 'pill-gray'}`}>{c.replaceAll('_', ' ')}</span>;
}

const ACTION_COLOR: Partial<Record<EnforcementAction, string>> = {
  ALLOW: 'pill-green', ALLOW_WITH_MONITORING: 'pill-blue', WARN: 'pill-amber',
  REQUIRE_APPROVAL: 'pill-amber', STEP_UP_AUTH: 'pill-amber', CHALLENGE: 'pill-amber',
  DENY: 'pill-red', QUARANTINE: 'pill-red', TERMINATE: 'pill-red',
  REDACT: 'pill-purple', MASK: 'pill-purple', HANDOFF_TO_HUMAN: 'pill-blue',
};

export function ActionPill({ a }: { a: EnforcementAction }) {
  return <span className={`pill ${ACTION_COLOR[a] ?? 'pill-gray'} mono`}>{a.replaceAll('_', ' ')}</span>;
}

export function SeverityPill({ s }: { s: IncidentSeverity }) {
  const cls = s === 'CRITICAL' ? 'pill-red' : s === 'HIGH' ? 'pill-amber' : s === 'MEDIUM' ? 'pill-blue' : 'pill-gray';
  return <span className={`pill ${cls}`}>{s}</span>;
}

export function RiskBar({ risk }: { risk: number }) {
  return (
    <div className="riskbar" style={{ width: '100%' }}>
      <div style={{ width: `${risk}%`, background: riskColor(risk) }} />
    </div>
  );
}