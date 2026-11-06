// Policy Studio — reads the active policy from the CX Trust API, plus
// industry threat packs and the what-if simulation console.

import { apiGet, ApiOffline } from '../lib/api';
import SimulatePanel from './SimulatePanel';
import PolicyCraftPanel from './PolicyCraftPanel';

interface Policy {
  policyId: string; name: string; version: number; failMode: string;
  execution?: 'shadow' | 'enforce';
  rules: {
    id: string; description: string; severity: string; match: string;
    conditions: { field: string; op: string; value: unknown }[];
    actions: string[];
  }[];
}

interface Pack {
  packId: string; name: string; industry: string; description: string;
  detectionCount: number; policyRuleCount: number; refs: string[]; jurisdictions: string[];
}

const INDUSTRY_PILL: Record<string, string> = {
  banking: 'pill-green',
  insurance: 'pill-blue',
  healthcare: 'pill-purple',
  telecom: 'pill-amber',
};

export default async function PolicyPage() {
  const [data, packsData] = await Promise.all([
    apiGet<{ policies: Policy[] }>('/v1/policy'),
    apiGet<{ packs: Pack[] }>('/v1/packs'),
  ]);
  if (!data) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 4 }}>Policy Studio</h2>
        <ApiOffline path="/v1/policy" />
      </div>
    );
  }

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Policy Studio</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Active policies served by the CX Trust API · evaluated on the deterministic fast path
        (no LLM in the decision loop).
      </p>
      {data.policies.map(p => (
        <div key={p.policyId}>
          <div className="panel" style={{ marginBottom: 12, background: 'var(--bg2)' }}>
            <strong className="mono">{p.policyId}</strong> v{p.version} · {p.name} · fail mode{' '}
            <span className={`pill ${p.failMode === 'CLOSED' ? 'pill-red' : 'pill-amber'}`}>{p.failMode}</span>
            <span
              className={`pill ${p.execution === 'shadow' ? 'pill-amber' : 'pill-green'} mono`}
              style={{ marginLeft: 8 }}
              title={p.execution === 'shadow'
                ? 'SHADOW mode — decisions are detected and recorded but nothing is blocked. wouldEnforceActions shows what WOULD have been enforced.'
                : 'ENFORCE mode — policy decisions block in real time (DENY/QUARANTINE/…).'}
            >
              {p.execution === 'shadow' ? 'SHADOW MODE' : 'ENFORCE MODE'}
            </span>
          </div>
          {p.rules.map(r => (
            <div key={r.id} className="panel" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontSize: 13 }}>{r.id}</span>
                <span className={`pill ${r.severity === 'CRITICAL' ? 'pill-red' : r.severity === 'HIGH' ? 'pill-amber' : 'pill-blue'}`}>{r.severity}</span>
                <span className="pill pill-gray mono">{r.match}</span>
              </div>
              <p style={{ marginBottom: 10, fontSize: 13 }}>{r.description}</p>
              <div className="mono" style={{ fontSize: 12, color: 'var(--blue)', marginBottom: 6 }}>
                IF {r.conditions.map(c => `${c.field} ${c.op} ${JSON.stringify(c.value)}`).join(` ${r.match} `)}
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--green)' }}>
                THEN {r.actions.join(' + ')}
              </div>
            </div>
          ))}
        </div>
      ))}
      <div className="panel" style={{ marginTop: 24, marginBottom: 12 }}>
        <h3>Industry Threat Packs</h3>
        {!packsData ? (
          <p style={{ color: 'var(--dim)' }}>Pack catalog unavailable — start the CX Trust API to list industry packs.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginTop: 10 }}>
            {packsData.packs.map(pack => (
              <div key={pack.packId} className="panel" style={{ background: 'var(--bg2)', margin: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>{pack.name}</strong>
                  <span className={`pill ${INDUSTRY_PILL[pack.industry] ?? 'pill-gray'}`}>{pack.industry}</span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 10 }}>{pack.description}</p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  <span className="pill pill-gray mono">{pack.detectionCount} detections</span>
                  <span className="pill pill-gray mono">{pack.policyRuleCount} policy rules</span>
                  {(pack.jurisdictions ?? []).map(j => <span key={j} className="pill pill-blue mono">{j}</span>)}
                </div>
                {(pack.refs ?? []).map(ref => (
                  <div key={ref} className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginBottom: 2 }}>· {ref}</div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <SimulatePanel />
      <PolicyCraftPanel />
    </div>
  );
}