'use client';

// One-click connector demo: POSTs to the adapter's /<platform>/demo through
// the server-side /api/adapter proxy (the browser never touches adapter
// ports directly). The adapter drives a scripted interaction through the
// SAME event path a real webhook would use, and we surface the governance
// outcome + a link into the Investigation Console. Clearly demo data.

import { useState } from 'react';
import Link from 'next/link';

interface DemoInteraction {
  scenario?: string;
  interactionId: string;
  classification?: string;
  risk?: number;
  blocked?: boolean;
  matchedRule?: string | null;
}

interface DemoResponse {
  // connect/genesys shape
  interactionId?: string;
  blocked?: boolean;
  matchedRule?: string | null;
  note?: string;
  // nice/five9/cisco/avaya shape
  interactions?: DemoInteraction[];
  error?: string;
}

export default function ConnectorDemoButton({ adapter, path, mode = 'kind' }: {
  adapter: string; path: string;
  /** 'kind' → adapter accepts ?kind=attack|benign; 'pair' → one click runs both scripted interactions */
  mode?: 'kind' | 'pair';
}) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [rows, setRows] = useState<DemoInteraction[]>([]);
  const [err, setErr] = useState('');

  async function run(kind?: 'attack' | 'benign') {
    setState('running'); setRows([]); setErr('');
    try {
      const full = kind ? `${path}?kind=${kind}` : path;
      const res = await fetch(`/api/adapter?adapter=${adapter}&path=${encodeURIComponent(full)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const j = (await res.json()) as DemoResponse;
      if (!res.ok || j.error) {
        setState('error'); setErr(j.error ?? `adapter returned HTTP ${res.status}`); return;
      }
      const list: DemoInteraction[] = j.interactions ?? (j.interactionId
        ? [{ interactionId: j.interactionId, blocked: j.blocked, matchedRule: j.matchedRule }]
        : []);
      setRows(list);
      setState(list.length ? 'done' : 'error');
      if (!list.length) setErr('adapter returned no interactions');
    } catch (e) {
      setState('error');
      setErr(`adapter unreachable — is it running? (${String((e as Error).message)})`);
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {mode === 'kind' ? (
          <>
            <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={state === 'running'} onClick={() => void run('attack')}>
              {state === 'running' ? 'Running…' : '▶ Run attack demo'}
            </button>
            <button className="btn" style={{ fontSize: 12 }} disabled={state === 'running'} onClick={() => void run('benign')}>
              Run benign demo
            </button>
          </>
        ) : (
          <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={state === 'running'} onClick={() => void run()}>
            {state === 'running' ? 'Running…' : '▶ Run demo (benign + attack)'}
          </button>
        )}
        <span style={{ fontSize: 10, color: 'var(--dim)' }}>scripted · labeled demo data</span>
      </div>
      {state === 'error' && (
        <div className="mono" style={{ marginTop: 8, fontSize: 11, color: 'var(--red)' }}>{err}</div>
      )}
      {rows.map(r => (
        <div key={r.interactionId} style={{ marginTop: 8, fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {r.blocked
            ? <span className="pill pill-red">BLOCKED {r.matchedRule ? `· ${r.matchedRule}` : ''}</span>
            : <span className="pill pill-green">ALLOWED</span>}
          {r.scenario && <span style={{ color: 'var(--dim)' }}>{r.scenario}</span>}
          {r.classification && <span className="pill pill-gray" style={{ fontSize: 10 }}>{r.classification}</span>}
          <Link href={`/investigation/${encodeURIComponent(r.interactionId)}`} className="mono" style={{ fontSize: 11, color: 'var(--blue)', textDecoration: 'none' }}>
            {r.interactionId} → investigate
          </Link>
        </div>
      ))}
    </div>
  );
}
