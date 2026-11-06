// Threat Graph — campaign correlation surface. Reads the in-process graph
// exposed by the CX Trust API; synthetic-voice clusters become campaigns.

import Link from 'next/link';
import { apiGet, ApiOffline } from '../lib/api';

interface Campaign {
  campaignId: string;
  interactionIds: string[];
  sharedSignals: string[];
  phoneNumbers: string[];
  firstSeen: string;
  lastSeen: string;
  totalRisk: number;
  description: string;
}

interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  campaigns: Campaign[];
  topSharedSignals: string[];
}

const riskColor = (n: number) =>
  n >= 70 ? 'var(--red)' : n >= 40 ? 'var(--amber)' : 'var(--green)';

const signalPill = (s: string) =>
  s.startsWith('voice') ? 'pill-red' : s.startsWith('destination') ? 'pill-purple' : s.startsWith('code:') ? 'pill-amber' : 'pill-blue';

export default async function CampaignsPage() {
  const data = await apiGet<{ summary: GraphSummary; campaigns: Campaign[] }>('/v1/campaigns');
  if (!data) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 4 }}>Threat Graph</h2>
        <ApiOffline path="/v1/campaigns" />
      </div>
    );
  }

  const { summary, campaigns } = data;

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Threat Graph</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Interactions linked by shared signals — voice signature, fraud-detection codes, phone and
        destination overlap — into coordinated campaigns. Demo limitation: the shared voice
        signature is a synthetic-provider hash, not a production per-identity voiceprint.
      </p>

      <div className="statgrid" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="num mono">{summary.nodeCount}</div>
          <div className="lbl">Graph Nodes</div>
        </div>
        <div className="stat">
          <div className="num mono">{summary.edgeCount}</div>
          <div className="lbl">Graph Edges</div>
        </div>
        <div className="stat">
          <div className="num" style={{ color: campaigns.length ? 'var(--red)' : 'var(--green)' }}>{campaigns.length}</div>
          <div className="lbl">Campaigns Detected</div>
        </div>
      </div>

      {summary.topSharedSignals?.length > 0 && (
        <p style={{ marginBottom: 16, fontSize: 13 }}>
          <span style={{ color: 'var(--dim)' }}>Top shared signals: </span>
          {summary.topSharedSignals.map(s => (
            <span key={s} className={`pill ${signalPill(s)} mono`} style={{ marginRight: 6 }}>{s}</span>
          ))}
        </p>
      )}

      {campaigns.length === 0 && (
        <p style={{ color: 'var(--dim)' }}>
          No campaigns in the graph yet — seed the demo corpus from the Command Center
          (run the attack scenarios so two or more synthetic-voice calls share a signal).
        </p>
      )}

      {campaigns.map(c => (
        <div key={c.campaignId} className="panel" style={{ marginBottom: 16, borderColor: 'var(--red)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <strong className="mono" style={{ fontSize: 14 }}>{c.campaignId}</strong>
            <span className="pill pill-red">RISK {c.totalRisk}</span>
            <span className="pill pill-gray mono">{c.interactionIds.length} interactions</span>
            <span style={{ color: 'var(--dim)', fontSize: 12 }} className="mono">
              {c.firstSeen} → {c.lastSeen}
            </span>
          </div>
          <p style={{ fontSize: 13, marginBottom: 10 }}>{c.description}</p>

          <div style={{ marginBottom: 10 }}>
            <span style={{ color: 'var(--dim)', fontSize: 12 }}>Shared signals: </span>
            {c.sharedSignals.map(s => (
              <span key={s} className={`pill ${signalPill(s)} mono`} style={{ marginRight: 6 }}>{s}</span>
            ))}
          </div>

          {c.phoneNumbers.length > 0 && (
            <p style={{ fontSize: 13, marginBottom: 10 }}>
              <span style={{ color: 'var(--dim)' }}>Phone numbers: </span>
              {c.phoneNumbers.map(p => <span key={p} className="mono" style={{ marginRight: 10 }}>{p}</span>)}
            </p>
          )}

          <table className="tbl">
            <thead>
              <tr><th>Interaction</th><th>Linked to campaign</th></tr>
            </thead>
            <tbody>
              {c.interactionIds.map(id => (
                <tr key={id}>
                  <td><Link href={`/investigation/${encodeURIComponent(id)}`} className="mono" style={{ fontSize: 13 }}>{id}</Link></td>
                  <td><Link href={`/investigation/${encodeURIComponent(id)}`} style={{ fontSize: 12 }}>Investigate →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
