// Investigation Console — listing of stored interactions with replay links.

import Link from 'next/link';
import { apiGet, ApiOffline } from '../lib/api';
import { RiskPill } from '../components';

interface StoredInteraction {
  interactionId: string;
  organizationId: string;
  platform: string;
  channel: string;
  startedAt: string;
  endedAt?: string;
  scenarioLabel?: string;
  peakRisk: number;
  finalRisk: number;
}

export default async function InvestigationListPage() {
  const data = await apiGet<{ interactions: StoredInteraction[] }>('/v1/interactions');
  if (!data) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 4 }}>Investigation Console</h2>
        <ApiOffline path="/v1/interactions" />
      </div>
    );
  }

  const rows = data.interactions ?? [];

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Investigation Console</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Synchronized interaction playback — timeline, policy decisions, detections, and the
        evidence chain for every governed interaction in the store.
      </p>
      <div className="grid3">
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <h3>Interactions · newest first</h3>
          {rows.length === 0 && <p style={{ color: 'var(--dim)' }}>No interactions in the store — seed the demo corpus from the Command Center.</p>}
          {rows.map(i => (
            <div key={i.interactionId} className="timeline-row" style={{ gridTemplateColumns: 'auto 1fr auto auto' }}>
              <Link href={`/investigation/${encodeURIComponent(i.interactionId)}`} className="mono" style={{ fontSize: 13 }}>{i.interactionId}</Link>
              <span style={{ fontSize: 12 }}>
                {i.scenarioLabel ?? 'interaction'}
                <span style={{ color: 'var(--dim)' }}> · {i.platform} · {i.organizationId} · {i.startedAt.slice(0, 19).replace('T', ' ')}</span>
              </span>
              <RiskPill risk={i.peakRisk} />
              <Link href={`/investigation/${encodeURIComponent(i.interactionId)}`}>Investigate →</Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
