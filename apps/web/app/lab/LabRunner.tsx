// Test Lab console — run the CX red-team corpus against the live engine and
// render the honest scorecard. Client component: POST /v1/lab/run on demand.

'use client';

import { useEffect, useState } from 'react';

interface CaseResult {
  caseId: string;
  category: string;
  title: string;
  verdict: 'PASS' | 'FAIL' | 'SKIP';
  checks: { check: string; ok: boolean; detail: string }[];
  risk: number;
  detections: string[];
  error?: string;
}

interface LabRun {
  runId: string;
  startedAt: string;
  results: CaseResult[];
  summary: { pass: number; fail: number; skip: number; total: number; scorePct: number };
}

const VERDICT_PILL: Record<string, string> = { PASS: 'pill-green', FAIL: 'pill-red', SKIP: 'pill-gray' };

export default function LabRunner() {
  const [run, setRun] = useState<LabRun | null>(null);
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState<string>('');

  const runLab = async () => {
    setState('running');
    setError('');
    try {
      const res = await fetch('/api/cxtrust?path=/v1/lab/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error(`lab run failed (${res.status})`);
      setRun((await res.json()) as LabRun);
      setState('idle');
    } catch (e) {
      setError(String((e as Error).message));
      setState('error');
    }
  };

  useEffect(() => { void runLab(); }, []);

  return (
    <div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>CX Red-Team Lab</h3>
          <button onClick={() => void runLab()} disabled={state === 'running'}
            style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>
            {state === 'running' ? 'Running…' : '▶ Run corpus'}
          </button>
          {run && (
            <>
              <span className={`pill ${run.summary.scorePct >= 80 ? 'pill-green' : run.summary.scorePct >= 50 ? 'pill-amber' : 'pill-red'} mono`}>
                SCORE {run.summary.scorePct}%
              </span>
              <span className="pill pill-green mono">{run.summary.pass} PASS</span>
              <span className="pill pill-red mono">{run.summary.fail} FAIL</span>
              {run.summary.skip > 0 && <span className="pill pill-gray mono">{run.summary.skip} SKIP</span>}
              <span style={{ color: 'var(--dim)', fontSize: 11 }} className="mono">{run.runId}</span>
            </>
          )}
        </div>
        <p style={{ color: 'var(--dim)', fontSize: 12, margin: '8px 0 0' }}>
          Each case opens a fresh governed interaction against the real engine and checks the
          expected detection / risk floor / decision outcome. FAILs here are genuine governance
          gaps — that is the point. Synthetic data only.
        </p>
      </div>

      {state === 'error' && (
        <div className="panel" style={{ borderColor: 'var(--red)' }}>
          <p style={{ color: 'var(--red)', margin: 0 }}>{error}</p>
        </div>
      )}

      {run?.results.map(r => (
        <div key={r.caseId} className="panel" style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`pill ${VERDICT_PILL[r.verdict]} mono`}>{r.verdict}</span>
            <span className="mono" style={{ fontSize: 12 }}>{r.caseId}</span>
            <span style={{ fontSize: 12 }}>{r.title}</span>
            <span className="pill pill-gray mono" style={{ fontSize: 10 }}>{r.category}</span>
            <span className={`pill ${r.risk >= 40 ? 'pill-red' : r.risk >= 15 ? 'pill-amber' : 'pill-gray'} mono`} style={{ fontSize: 10 }}>RISK {r.risk}</span>
          </div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--dim)' }}>
            {r.checks.map((c, i) => (
              <li key={i} style={{ color: c.ok ? 'var(--dim)' : 'var(--red)' }}>
                {c.ok ? '✓' : '✗'} {c.check} — {c.detail}
              </li>
            ))}
            {r.error && <li style={{ color: 'var(--red)' }}>error: {r.error}</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}