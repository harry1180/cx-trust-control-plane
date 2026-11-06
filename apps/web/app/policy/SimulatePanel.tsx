'use client';

// What-if policy simulation panel: replays the 8 demo scenarios against a
// candidate policy (preset) and diffs decisions vs the live seed policy.
// All simulation happens server-side via the /api/cxtrust proxy — the
// browser never sees the API key. The candidate presets are demo variants
// of FINANCIAL_SERVICES_POLICY_V4; they are NOT live policies.

import { useState } from 'react';

interface Summary {
  totalActions: number;
  baselineBlocked: number;
  candidateBlocked: number;
  newlyBlocked: number;
  newlyAllowed: number;
  falsePositiveEstimate: number;
}
interface SimResult { scenarioId: string; summary: Summary }
interface SimResponse {
  results?: SimResult[];
  totals?: { newlyBlocked: number; newlyAllowed: number; falsePositiveEstimate: number; scenariosCompared: number };
  error?: string;
}

// Known-benign demo scenarios (the FP reference in the simulator): a
// newly-blocked action here is an estimated false positive, not a win.
const BENIGN = new Set(['normal-customer', 'verified-agent-passport']);

export default function SimulatePanel() {
  const [preset, setPreset] = useState<'stricter' | 'looser'>('stricter');
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [data, setData] = useState<SimResponse | null>(null);

  async function simulate() {
    setState('running');
    try {
      const res = await fetch('/api/cxtrust?path=/v1/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidate: preset }),
      });
      const body = (await res.json()) as SimResponse;
      if (!res.ok) {
        setData(body);
        setState('error');
        return;
      }
      setData(body);
      setState('done');
    } catch {
      setData({ error: 'CX Trust API unreachable' });
      setState('error');
    }
  }

  const totals = data?.totals;
  const results = data?.results ?? [];

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h3>What-if simulation</h3>
      <p style={{ color: 'var(--dim)', fontSize: 13, marginBottom: 12 }}>
        Replays all 8 demo scenarios against a candidate policy and diffs decisions against the
        live seed policy. Demo variants of <span className="mono">FINANCIAL_ACCOUNT_POLICY</span> v4 —
        nothing here writes to the live policy store.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: 'var(--dim)' }}>Candidate</label>
        <select
          className="mono"
          value={preset}
          onChange={e => setPreset(e.target.value === 'looser' ? 'looser' : 'stricter')}
          style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid #24344a', borderRadius: 6, padding: '6px 10px' }}
        >
          <option value="stricter">stricter — synthetic-voice threshold 0.7 + agent R007 deny</option>
          <option value="looser">looser — threshold 0.98, prompt-injection quarantine removed</option>
        </select>
        <button className="btn btn-primary" onClick={() => { void simulate(); }} disabled={state === 'running'}>
          {state === 'running' ? 'Simulating…' : 'Simulate'}
        </button>
      </div>

      {state === 'error' && (
        <p style={{ color: 'var(--amber)', marginTop: 12, fontSize: 13 }}>
          {data?.error ?? 'Simulation failed'} — is the CX Trust API running?
        </p>
      )}

      {state === 'done' && totals && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '14px 0 10px' }}>
            <Stat label="Scenarios compared" value={totals.scenariosCompared} tone="gray" />
            <Stat label="Newly blocked" value={totals.newlyBlocked} tone={totals.newlyBlocked > 0 ? 'green' : 'gray'} />
            <Stat label="Newly allowed" value={totals.newlyAllowed} tone={totals.newlyAllowed > 0 ? 'amber' : 'gray'} />
            <Stat label="FP estimate" value={totals.falsePositiveEstimate} tone={totals.falsePositiveEstimate > 0 ? 'red' : 'gray'} />
          </div>
          <p style={{ color: 'var(--dim)', fontSize: 11, marginBottom: 10 }}>
            FP estimate counts newly-blocked actions inside known-benign scenarios only — a
            heuristic on the labeled demo corpus, not a measured false-positive rate.
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Scenario</th>
                <th style={{ textAlign: 'right' }}>Baseline blocked</th>
                <th style={{ textAlign: 'right' }}>Candidate blocked</th>
                <th style={{ textAlign: 'right' }}>Newly blocked</th>
                <th style={{ textAlign: 'right' }}>Newly allowed</th>
                <th style={{ textAlign: 'right' }}>FP est.</th>
              </tr>
            </thead>
            <tbody>
              {results.map(r => {
                const benign = BENIGN.has(r.scenarioId);
                const fpRow = benign && r.summary.newlyBlocked > 0;
                const cell = (n: number, tone: string) => (
                  <td style={{ textAlign: 'right', color: n > 0 ? `var(--${tone})` : 'var(--dim)' }}>{n}</td>
                );
                return (
                  <tr key={r.scenarioId} style={fpRow ? { background: '#e8b04a12' } : undefined}>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {r.scenarioId}
                      {benign && <span className="pill pill-gray" style={{ marginLeft: 8 }}>benign</span>}
                    </td>
                    {cell(r.summary.baselineBlocked, 'dim')}
                    {cell(r.summary.candidateBlocked, 'text')}
                    {fpRow
                      ? <td style={{ textAlign: 'right', color: 'var(--amber)', fontWeight: 700 }}>{r.summary.newlyBlocked}</td>
                      : cell(r.summary.newlyBlocked, 'green')}
                    {cell(r.summary.newlyAllowed, 'amber')}
                    {cell(r.summary.falsePositiveEstimate, 'red')}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'green' | 'amber' | 'red' | 'gray' }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid #1b2836', borderRadius: 8, padding: '10px 16px', minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 22, color: tone === 'gray' ? 'var(--text)' : `var(--${tone})` }}>{value}</div>
    </div>
  );
}
