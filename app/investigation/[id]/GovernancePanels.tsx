// Investigation extras: tool-call records, retrieval events, and the
// conversation-intelligence summary, fetched client-side per interaction.

'use client';

import { useEffect, useState } from 'react';

interface ToolCall {
  toolCallId: string;
  tool: string;
  participantId?: string;
  riskCategory: string;
  authLevel: string;
  policyAllowed: boolean;
  status: string;
  resultSummary?: string;
  error?: string;
  latencyMs?: number;
  offsetS: number;
}

interface RetrievalEvent {
  retrievalId: string;
  query: string;
  offsetS: number;
  latencyMs?: number;
  sources: { sourceId: string; uri: string; score: number; permission: string }[];
}

interface Summary {
  digest: string;
  topics: { topic: string; mentions: number }[];
  actionItems: { text: string; who: string }[];
  sentiment: { overall: number; label: string };
  decisions: { text: string }[];
}

export default function GovernancePanels({ interactionId }: { interactionId: string }) {
  const [tools, setTools] = useState<ToolCall[] | null>(null);
  const [retrievals, setRetrievals] = useState<RetrievalEvent[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (path: string, set: (v: never) => void) => {
      try {
        const res = await fetch(`/api/cxtrust?path=${encodeURIComponent(path)}`);
        if (!res.ok || cancelled) return;
        set((await res.json()) as never);
      } catch { /* panels are additive */ }
    };
    void load(`/v1/interactions/${encodeURIComponent(interactionId)}/tools`, v => setTools(v as { toolCalls: ToolCall[] } | null ? (v as unknown as { toolCalls: ToolCall[] }).toolCalls : []));
    void load(`/v1/interactions/${encodeURIComponent(interactionId)}/retrievals`, v => setRetrievals(v as unknown as RetrievalEvent[] | null ? (v as unknown as { retrievals: RetrievalEvent[] }).retrievals : []));
    void load(`/v1/interactions/${encodeURIComponent(interactionId)}/summary`, v => setSummary(v as unknown as Summary | null ? (v as unknown as { summary: Summary }).summary : null));
    return () => { cancelled = true; };
  }, [interactionId]);

  return (
    <div style={{ marginTop: 16 }}>
      {tools && tools.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3>Tool Calls</h3>
          {tools.map(t => (
            <div key={t.toolCallId} className="timeline-row" style={{ gridTemplateColumns: 'auto auto auto 1fr' }}>
              <span className="mono" style={{ color: 'var(--dim)' }}>t+{t.offsetS}s</span>
              <span className={`pill ${t.status === 'SUCCESS' ? 'pill-green' : 'pill-red'} mono`} style={{ fontSize: 10 }}>{t.status}</span>
              <span className="mono" style={{ fontSize: 12 }}>{t.tool}</span>
              <span style={{ fontSize: 11, color: 'var(--dim)' }}>
                {t.riskCategory} · auth {t.authLevel} · policy {t.policyAllowed ? 'ALLOWED' : 'DENIED'}
                {t.error ? ` · ${t.error}` : ''}{t.latencyMs !== undefined ? ` · ${t.latencyMs}ms` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {retrievals && retrievals.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3>Retrieval Events</h3>
          {retrievals.map(r => (
            <div key={r.retrievalId} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <span className="mono" style={{ color: 'var(--dim)', fontSize: 11 }}>t+{r.offsetS}s</span>
                <span className="mono" style={{ fontSize: 12 }}>query: {r.query}</span>
                {r.latencyMs !== undefined && <span className="pill pill-gray mono" style={{ fontSize: 10 }}>{r.latencyMs}ms</span>}
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 11, color: 'var(--dim)' }}>
                {r.sources.map(s => (
                  <li key={s.sourceId} className="mono">{s.uri} · score {s.score.toFixed(2)} · {s.permission}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {summary && (
        <div className="panel">
          <h3>Conversation Summary</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <span className={`pill ${summary.sentiment.label === 'NEGATIVE' ? 'pill-red' : summary.sentiment.label === 'POSITIVE' ? 'pill-green' : 'pill-gray'} mono`} style={{ fontSize: 10 }}>
              {summary.sentiment.label}
            </span>
            {summary.topics.slice(0, 6).map(t => (
              <span key={t.topic} className="pill pill-blue mono" style={{ fontSize: 10 }}>{t.topic} ×{t.mentions}</span>
            ))}
          </div>
          {summary.digest && <p style={{ fontSize: 12, margin: '4px 0' }}>{summary.digest}</p>}
          {summary.actionItems.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 11, color: 'var(--dim)' }}>
              {summary.actionItems.slice(0, 5).map((a, i) => <li key={i}>{a.text}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}