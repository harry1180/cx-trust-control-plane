// Incidents — reads from the CX Trust API evidence store.

import Link from 'next/link';
import { apiGet, ApiOffline } from '../lib/api';
import { ActionPill, SeverityPill } from '../components';

interface ApiIncident {
  incidentId: string; organizationId: string; interactionId: string;
  title: string; severity: string; status: string; openedAt: string; summary: string;
}

interface Decision {
  decisionId: string; interactionId: string; matchedRule: string;
  allowed: boolean; actions: string[]; reasons: string[];
}

export default async function IncidentsPage() {
  const data = await apiGet<{ incidents: ApiIncident[] }>('/v1/incidents');
  if (!data) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 4 }}>Incidents</h2>
        <ApiOffline path="/v1/incidents" />
      </div>
    );
  }

  // fetch enforcement actions per incident from the decisions store
  const rows = data.incidents ?? [];
  const decisionsByInteraction = new Map<string, Decision[]>();
  await Promise.all([...new Set(rows.map(r => r.interactionId))].slice(0, 30).map(async iid => {
    const d = await apiGet<{ decisions: Decision[] }>(`/v1/interactions/${iid}/decisions`);
    if (d) decisionsByInteraction.set(iid, d.decisions.filter(x => !x.allowed));
  }));

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Incidents</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Persisted incidents from the CX Trust API evidence store. Enforcement actions shown from
        the linked policy decisions.
      </p>
      {rows.length === 0 && <p style={{ color: 'var(--dim)' }}>No incidents in the store — run the Attack Simulator or seed the demo corpus.</p>}
      {rows.map(i => (
        <div key={i.incidentId} className="panel" style={{ marginBottom: 12, borderColor: i.severity === 'CRITICAL' ? 'var(--red)' : undefined }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <SeverityPill s={i.severity as never} />
            <span className="mono" style={{ fontSize: 13 }}>{i.incidentId}</span>
            <span style={{ color: 'var(--dim)', fontSize: 12 }} className="mono">{i.interactionId}</span>
            <span className="pill pill-amber">{i.status}</span>
          </div>
          <p style={{ fontSize: 13, marginBottom: 8 }}>{i.title}</p>
          <p style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 8 }}>{i.summary}</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Link href={`/investigation/${encodeURIComponent(i.interactionId)}`} style={{ fontSize: 12 }}>Investigate →</Link>
            {(decisionsByInteraction.get(i.interactionId) ?? []).flatMap(d => d.actions).filter((a, idx, arr) => arr.indexOf(a) === idx).slice(0, 4).map(a => (
              <ActionPill key={a} a={a as never} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}