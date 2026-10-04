// Agent Registry — reads from the CX Trust API.

import { apiGet, ApiOffline } from '../lib/api';

interface AgentRegistration {
  agentId: string; name: string; owner: string; environment: string;
  modelProvider: string; model: string; purpose: string; riskClassification: string;
  jurisdiction: string; humanEscalationPolicy: string; deploymentVersion: string;
  policyVersion: number; maxTransactionLimit: number;
  permittedActions: string[]; approvedTools: string[]; permittedDataClasses: string[];
  approvedChannels: string[];
  passport?: { certificateId: string };
}

export default async function AgentsPage() {
  const data = await apiGet<{ agents: AgentRegistration[] }>('/v1/agents');
  if (!data) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 4 }}>AI Agent Registry</h2>
        <ApiOffline path="/v1/agents" />
      </div>
    );
  }

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>AI Agent Registry</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Registered enterprise AI agents with zero-trust authorization scopes, served by the CX
        Trust API. Unregistered agents are classified UNKNOWN_AI and denied sensitive actions.
      </p>
      {data.agents.map(a => (
        <div key={a.agentId} className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <strong className="mono" style={{ fontSize: 15 }}>{a.agentId}</strong>
            <span className="pill pill-purple">{a.purpose}</span>
            <span className={`pill ${a.riskClassification === 'HIGH' ? 'pill-red' : a.riskClassification === 'MEDIUM' ? 'pill-amber' : 'pill-green'}`}>
              RISK {a.riskClassification}
            </span>
            <span className={`pill ${a.environment === 'PROD' ? 'pill-green' : 'pill-amber'}`}>{a.environment}</span>
            {a.passport && <span className="pill pill-green mono">PASSPORT · {a.passport.certificateId}</span>}
          </div>
          <div className="grid2">
            <div>
              <h3 style={{ color: 'var(--dim)', fontSize: 11, textTransform: 'uppercase', marginBottom: 6 }}>Identity</h3>
              <table className="tbl"><tbody>
                <tr><td>Name</td><td>{a.name}</td></tr>
                <tr><td>Owner</td><td>{a.owner}</td></tr>
                <tr><td>Model</td><td className="mono">{a.modelProvider} / {a.model}</td></tr>
                <tr><td>Deployment</td><td className="mono">v{a.deploymentVersion} · policy v{a.policyVersion}</td></tr>
                <tr><td>Jurisdiction</td><td>{a.jurisdiction}</td></tr>
                <tr><td>Escalation</td><td>{a.humanEscalationPolicy}</td></tr>
              </tbody></table>
            </div>
            <div>
              <h3 style={{ color: 'var(--dim)', fontSize: 11, textTransform: 'uppercase', marginBottom: 6 }}>Zero-trust scope</h3>
              <div style={{ fontSize: 13, lineHeight: 2 }}>
                <div><span style={{ color: 'var(--dim)' }}>Permitted actions:</span> {a.permittedActions.map(x => <span key={x} className="pill pill-green mono">{x}</span>)}</div>
                <div><span style={{ color: 'var(--dim)' }}>Approved tools:</span> {a.approvedTools.map(x => <span key={x} className="pill pill-blue mono">{x}</span>)}</div>
                <div><span style={{ color: 'var(--dim)' }}>Data classes:</span> {a.permittedDataClasses.map(x => <span key={x} className="pill pill-gray mono">{x}</span>)}</div>
                <div><span style={{ color: 'var(--dim)' }}>Max transaction:</span> <span className="mono">${a.maxTransactionLimit.toLocaleString()}</span></div>
                <div><span style={{ color: 'var(--dim)' }}>Channels:</span> {a.approvedChannels.join(', ')}</div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}