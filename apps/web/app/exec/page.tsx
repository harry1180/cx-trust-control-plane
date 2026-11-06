// Executive Trust Dashboard — translates security posture into business value.
// Reads the executive rollup from the CX Trust API; charts are plain SVG.

import { apiGet, ApiOffline } from '../lib/api';
import ExecCharts from './ExecCharts';

interface ExecSummary {
  organizationId: string;
  governed: number;
  aiParticipants: number;
  verifiedAiAgents: number;
  unknownAiCallers: number;
  deepfakeAttempts: number;
  fraudAttempts: number;
  promptInjections: number;
  blockedTransactions: number;
  preventedDataLeaks: number;
  incidents: number;
  estFraudPreventedUsd: number;
  estFraudPreventedBasis?: string;
  meanPolicyLatencyMs: number;
  byPlatform: Record<string, number>;
  bySeverity: Record<string, number>;
  byHour?: Record<string, number>;
}

const money = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
  : `$${n.toLocaleString('en-US')}`;

export default async function ExecutivePage() {
  const exec = await apiGet<ExecSummary>('/v1/executive/org-demo');
  if (!exec) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 4 }}>Executive Trust Dashboard</h2>
        <ApiOffline path="/v1/executive/org-demo" />
      </div>
    );
  }

  const platforms = Object.entries(exec.byPlatform ?? {}).sort((a, b) => b[1] - a[1]);
  const maxPlatform = Math.max(1, ...platforms.map(([, n]) => n));

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Executive Trust Dashboard</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Security posture translated into business value for <span className="mono">{exec.organizationId}</span>.
        <span className="pill pill-gray mono" style={{ marginLeft: 8 }}>
          {exec.estFraudPreventedBasis ?? 'estFraudPreventedUsd is a LOWER-BOUND estimate'}
        </span>
      </p>

      <div className="statgrid">
        <div className="stat">
          <div className="num" style={{ color: 'var(--green)' }}>{money(exec.estFraudPreventedUsd)}</div>
          <div className="lbl">Fraud Prevented (lower bound)</div>
        </div>
        <div className="stat">
          <div className="num" style={{ color: 'var(--red)' }}>{exec.blockedTransactions}</div>
          <div className="lbl">Blocked Transactions</div>
        </div>
        <div className="stat">
          <div className="num" style={{ color: 'var(--amber)' }}>{exec.deepfakeAttempts}</div>
          <div className="lbl">Deepfake Attempts</div>
        </div>
        <div className="stat">
          <div className="num" style={{ color: 'var(--amber)' }}>{exec.promptInjections}</div>
          <div className="lbl">Prompt Injections</div>
        </div>
        <div className="stat">
          <div className="num" style={{ color: 'var(--purple)' }}>{exec.preventedDataLeaks}</div>
          <div className="lbl">Data-Leak Prevented</div>
        </div>
        <div className="stat">
          <div className="num mono">{exec.meanPolicyLatencyMs}<span style={{ fontSize: 13, color: 'var(--dim)' }}> ms</span></div>
          <div className="lbl">Mean Policy Latency</div>
        </div>
        <div className="stat">
          <div className="num">{exec.governed}</div>
          <div className="lbl">Governed Interactions</div>
        </div>
        <div className="stat">
          <div className="num" style={{ color: 'var(--red)' }}>{exec.incidents}</div>
          <div className="lbl">Incidents</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>Interactions by platform</h3>
        {platforms.length === 0 && <p style={{ color: 'var(--dim)' }}>No interactions yet.</p>}
        {platforms.map(([platform, count]) => (
          <div key={platform} style={{ display: 'grid', gridTemplateColumns: '260px 1fr 48px', gap: 10, alignItems: 'center', padding: '4px 0' }}>
            <span className="mono" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{platform}</span>
            <div className="riskbar">
              <div style={{ width: `${(count / maxPlatform) * 100}%`, background: 'var(--blue)' }} />
            </div>
            <span className="mono" style={{ fontSize: 12, textAlign: 'right' }}>{count}</span>
          </div>
        ))}
      </div>

      <ExecCharts byHour={exec.byHour ?? {}} />
    </div>
  );
}
