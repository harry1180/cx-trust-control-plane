// Investigation Console — synchronized interaction playback.
// LEFT pane: playback-driven timeline stream. RIGHT pane: policy decisions,
// detections, and the evidence chain.

import { apiGet, ApiOffline } from '../../lib/api';
import { ActionPill } from '../../components';
import PlaybackClient, { type TimelineEntry } from './PlaybackClient';
import TraceWaterfall from './TraceWaterfall';
import GovernancePanels from './GovernancePanels';

interface ReplayResponse {
  interaction: {
    interactionId: string; organizationId: string; platform: string; channel: string;
    startedAt: string; endedAt?: string; scenarioLabel?: string; peakRisk: number; finalRisk: number;
  } | null;
  timeline: TimelineEntry[];
  decisions: Record<string, unknown>[];
  detections: { refId?: string; kind: string; label: string; detail?: string; offsetS: number }[];
  evidenceCount: number;
  chainValid: boolean;
}

interface Decision {
  decisionId: string; policyId: string; policyVersion: number; matchedRule: string;
  allowed: boolean; actions: string[]; reasons: string[];
  execution?: 'shadow' | 'enforce';
  wouldEnforceActions?: string[];
}

export default async function InvestigationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const path = `/v1/interactions/${encodeURIComponent(id)}/replay`;
  const [replay, decisionsData] = await Promise.all([
    apiGet<ReplayResponse>(path),
    apiGet<{ decisions: Decision[] }>(`/v1/interactions/${encodeURIComponent(id)}/decisions`),
  ]);

  if (!replay) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 4 }}>Investigation · {id}</h2>
        <ApiOffline path={path} />
      </div>
    );
  }

  const interaction = replay.interaction;
  const decisions = (decisionsData?.decisions ?? (replay.decisions as unknown as Decision[])) ?? [];

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Investigation · {id}</h2>
      {interaction ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
          <span className="pill pill-blue mono">{interaction.platform}</span>
          <span className="pill pill-gray mono">{interaction.organizationId}</span>
          <span className="pill pill-gray mono">{interaction.channel}</span>
          <span className={`pill ${interaction.peakRisk >= 70 ? 'pill-red' : interaction.peakRisk >= 40 ? 'pill-amber' : 'pill-green'} mono`}>
            PEAK RISK {interaction.peakRisk}
          </span>
          <span className={`pill ${interaction.finalRisk >= 70 ? 'pill-red' : interaction.finalRisk >= 40 ? 'pill-amber' : 'pill-green'} mono`}>
            FINAL RISK {interaction.finalRisk}
          </span>
          {interaction.scenarioLabel && <span className="pill pill-purple mono">{interaction.scenarioLabel}</span>}
          <span style={{ color: 'var(--dim)', fontSize: 12 }} className="mono">
            {interaction.startedAt.slice(0, 19).replace('T', ' ')}{interaction.endedAt ? ` → ${interaction.endedAt.slice(11, 19)}` : ''}
          </span>
        </div>
      ) : (
        <p style={{ color: 'var(--dim)', marginBottom: 16 }}>No stored interaction record — live session not found.</p>
      )}

      <div className="grid3">
        <div>
          <PlaybackClient timeline={replay.timeline ?? []} />
        </div>

        <div>
          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>Policy Decisions</h3>
            {decisions.length === 0 && <p style={{ color: 'var(--dim)' }}>No policy decisions recorded.</p>}
            {decisions.map(d => (
              <div key={String(d.decisionId)} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`pill ${d.allowed ? 'pill-green' : 'pill-red'} mono`}>{d.allowed ? 'ALLOWED' : 'DENIED'}</span>
                  {d.execution === 'shadow' && (
                    <span className="pill pill-amber mono" title={`Shadow mode — nothing was blocked. Would have enforced: ${(d.wouldEnforceActions ?? []).join(', ')}`}>
                      SHADOW{d.wouldEnforceActions?.length ? ` → ${(d.wouldEnforceActions ?? []).join(' + ')}` : ''}
                    </span>
                  )}
                  <span className="mono" style={{ fontSize: 12 }}>{d.matchedRule}</span>
                  <span style={{ color: 'var(--dim)', fontSize: 11 }} className="mono">{String(d.policyId)} v{String(d.policyVersion)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0 6px' }}>
                  {(d.actions ?? []).map(a => <ActionPill key={a} a={a as never} />)}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--dim)', fontSize: 12 }}>
                  {(d.reasons ?? []).map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            ))}
          </div>

          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>Detections</h3>
            {replay.detections.length === 0 && <p style={{ color: 'var(--dim)' }}>No detections in the timeline.</p>}
            {replay.detections.map((d, i) => (
              <div key={d.refId ?? i} className="timeline-row" style={{ gridTemplateColumns: 'auto auto 1fr' }}>
                <span className="mono" style={{ color: 'var(--dim)' }}>t+{d.offsetS}s</span>
                <span className="pill pill-purple mono" style={{ fontSize: 10 }}>{d.kind}</span>
                <span>{d.label}{d.detail ? <span style={{ color: 'var(--dim)' }}> — {d.detail}</span> : null}</span>
              </div>
            ))}
          </div>

          <div className="panel">
            <h3>Evidence Chain</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="pill pill-gray mono">{replay.evidenceCount} records</span>
              <span className={`pill ${replay.chainValid ? 'pill-green' : 'pill-red'} mono`}>
                {replay.chainValid ? 'CHAIN VALID' : 'CHAIN INVALID'}
              </span>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <TraceWaterfall interactionId={id} />
          </div>

          <GovernancePanels interactionId={id} />
        </div>
      </div>
    </div>
  );
}
