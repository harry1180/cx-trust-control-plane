'use client';
// Voice-biomarker capability switch for the Connect adapter.
// OFF = new calls are not analyzed (stored history is kept); the
// ENABLE_VOICE_BIOMARKERS flag/env remains the fallback after restarts.

import { useCallback, useEffect, useState, type CSSProperties } from 'react';

interface Status {
  enabled: boolean;
  source: 'runtime' | 'flag';
  flagDefault: boolean;
}

const PROXY = '/api/adapter?adapter=connect&path=';

export default function BiomarkersToggle() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${PROXY}/connect/biomarkers/status`);
      const b = (await r.json()) as Status;
      if (r.ok && typeof b.enabled === 'boolean') { setStatus(b); setErr(null); }
      else setErr('adapter unreachable');
    } catch { setErr('adapter unreachable'); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function set(enabled: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${PROXY}/connect/biomarkers/toggle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!r.ok) setErr('toggle failed');
      await load();
    } catch { setErr('toggle failed'); }
    setBusy(false);
  }

  const pill = status?.enabled ? 'pill pill-green' : 'pill pill-gray';
  const sourceText = status
    ? status.source === 'runtime'
      ? 'set from this UI (runtime — falls back to flag after restart)'
      : `from ENABLE_VOICE_BIOMARKERS flag (default ${status.flagDefault ? 'ON' : 'OFF'})`
    : '…';

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div>
          <strong>Voice biomarkers &amp; wellbeing signals</strong>
          <div style={{ fontSize: 12, color: 'var(--dim)' }}>
            Acoustic measurements + emotion estimate per call (research-grounded, NOT diagnoses). {sourceText}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={pill} aria-live="polite">{status === null ? '…' : status.enabled ? 'ON' : 'OFF'}</span>
          <button type="button" disabled={busy || status?.enabled === true} onClick={() => void set(true)} style={btn}>Enable</button>
          <button type="button" disabled={busy || status?.enabled === false} onClick={() => void set(false)} style={btn}>Disable</button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 8 }}>
        When OFF, new calls are not analyzed for biomarkers and the capability reports
        disabled; previously stored history stays visible for investigations. If the
        adapter is not running, the switch will read the env flag once it is back.
        {err ? <span style={{ color: 'var(--red)' }}> — {err}</span> : null}
      </div>
    </div>
  );
}

const btn: CSSProperties = {
  fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--line)',
  background: 'transparent', color: 'inherit', cursor: 'pointer',
};