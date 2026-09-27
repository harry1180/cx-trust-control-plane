'use client';

// Trace waterfall — distributed-trace-style view of the governance spans
// recorded around each stage (DETECT / POLICY / …) of an interaction.
// Bars are scaled to the slowest span; percentiles aggregate per stage.

import { useEffect, useState } from 'react';

export interface Span {
  spanId: string;
  traceId: string;
  interactionId: string;
  stage: string;
  name: string;
  startedAt: string;
  durationMs: number;
  attrs?: Record<string, string | number | boolean>;
  error?: string;
}

export interface TraceResponse {
  traceId: string;
  spans: Span[];
  latency: Record<string, { p50: number; p95: number; p99: number; count: number }>;
  error?: string;
}

const STAGE_COLOR: Record<string, string> = {
  DETECT: '#a78bfa',
  POLICY: '#f87171',
  ENFORCE: '#fb923c',
  RISK: '#fbbf24',
  ASR: '#38bdf8',
  TTS: '#38bdf8',
  TOOL: '#34d399',
  RAG: '#34d399',
  AUTH: '#60a5fa',
  EVIDENCE: '#94a3b8',
  LLM: '#34d399',
  OTHER: '#94a3b8',
};

// The live trace is only available while the session is in memory, so the
// client polls once on mount and reports the 404 state honestly.
export default function TraceWaterfall({ interactionId }: { interactionId: string }) {
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [state, setState] = useState<'loading' | 'live' | 'gone' | 'offline'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/cxtrust?path=/v1/interactions/${encodeURIComponent(interactionId)}/trace`)
      .then(async r => {
        if (cancelled) return;
        if (r.status === 200) {
          setTrace((await r.json()) as TraceResponse);
          setState('live');
        } else if (r.status === 404) {
          setState('gone');
        } else {
          setState('offline');
        }
      })
      .catch(() => { if (!cancelled) setState('offline'); });
    return () => { cancelled = true; };
  }, [interactionId]);

  if (state === 'loading') return <div className="panel"><h3>Trace</h3><p style={{ color: 'var(--dim)' }}>Loading spans…</p></div>;
  if (state === 'gone') {
    return (
      <div className="panel">
        <h3>Trace</h3>
        <p style={{ color: 'var(--dim)', fontSize: 12 }}>
          Spans live in the running governance session and are not persisted yet —
          this interaction has already been closed. Run a scenario and open its
          investigation while the session is live to see the waterfall.
        </p>
      </div>
    );
  }
  if (state === 'offline' || !trace) {
    return <div className="panel"><h3>Trace</h3><p style={{ color: 'var(--dim)' }}>Trace unavailable (API offline).</p></div>;
  }

  const max = Math.max(...trace.spans.map(s => s.durationMs), 0.01);
  const stages = Object.entries(trace.latency);

  return (
    <div className="panel">
      <h3>Trace</h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="pill pill-blue mono" style={{ fontSize: 10 }}>TRACE {trace.traceId.slice(0, 16)}…</span>
        <span className="pill pill-gray mono" style={{ fontSize: 10 }}>{trace.spans.length} spans</span>
      </div>

      {trace.spans.map(s => (
        <div key={s.spanId} style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
            <span className="mono" style={{ width: 70, color: STAGE_COLOR[s.stage] ?? '#94a3b8' }}>{s.stage}</span>
            <span style={{ color: 'var(--dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            <span className="mono">{s.durationMs.toFixed(2)} ms</span>
          </div>
          <div style={{ height: 5, background: 'var(--bg2)', borderRadius: 3, marginTop: 2 }}>
            <div style={{
              width: `${Math.max((s.durationMs / max) * 100, 1.5)}%`,
              height: '100%',
              background: STAGE_COLOR[s.stage] ?? '#94a3b8',
              borderRadius: 3,
            }} />
          </div>
          {s.attrs && Object.keys(s.attrs).length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 1 }} className="mono">
              {Object.entries(s.attrs).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}
            </div>
          )}
        </div>
      ))}

      {stages.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>Governance latency</h3>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--dim)', textAlign: 'left' }}>
                <th style={{ padding: '4px 8px 4px 0' }}>STAGE</th>
                <th style={{ padding: 4 }}>P50</th>
                <th style={{ padding: 4 }}>P95</th>
                <th style={{ padding: 4 }}>P99</th>
                <th style={{ padding: 4 }}>N</th>
              </tr>
            </thead>
            <tbody className="mono">
              {stages.map(([stage, v]) => (
                <tr key={stage} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '4px 8px 4px 0', color: STAGE_COLOR[stage] ?? '#94a3b8' }}>{stage}</td>
                  <td style={{ padding: 4 }}>{v.p50.toFixed(2)}</td>
                  <td style={{ padding: 4 }}>{v.p95.toFixed(2)}</td>
                  <td style={{ padding: 4 }}>{v.p99.toFixed(2)}</td>
                  <td style={{ padding: 4 }}>{v.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}