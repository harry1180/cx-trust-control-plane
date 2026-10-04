'use client';

// Twilio integration form: enter Account SID + Auth Token + public host.
// The adapter validates credentials against Twilio's API, lists your numbers,
// and (optionally) sets the voice webhook to its /twiml endpoint automatically.
// Credentials are sent to the local adapter over localhost and never persisted
// to disk; the browser session only holds them in the form state.

import { useState } from 'react';

export default function TwilioIntegrationForm() {
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [publicHost, setPublicHost] = useState('');
  const [configureNumbers, setConfigureNumbers] = useState(true);
  const [state, setState] = useState<'idle' | 'working' | 'ok' | 'error'>('idle');
  const [result, setResult] = useState<string>('');

  async function submit() {
    setState('working');
    setResult('');
    try {
      const res = await fetch('/api/adapter?adapter=twilio&path=/twilio/configure', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountSid, authToken, publicHost, configureNumbers }),
      });
      const j = await res.json() as { ok?: boolean; error?: string; validated?: boolean; numbers?: { phoneNumber: string; configured: boolean }[]; configuredNumbers?: number; note?: string };
      if (j.ok) {
        setState('ok');
        const lines = [
          `✓ Twilio credentials validated${j.validated ? '' : ' (unverified)'}`,
          ...(j.numbers ?? []).map(n => `   ${n.phoneNumber} — ${n.configured ? 'webhook set ✓' : 'webhook NOT set (update in Twilio console)'}`),
          j.note ?? '',
          publicHost ? `Calls to your number now stream into CX Trust (wss://${publicHost}/twilio).` : '',
        ];
        setResult(lines.filter(Boolean).join('\n'));
      } else {
        setState('error');
        setResult(j.error ?? 'configuration failed');
      }
    } catch (e) {
      setState('error');
      setResult(`adapter unreachable: ${String((e as Error).message)} — is the Twilio adapter running? (cd packages/cxtrust-twilio && node src/index.ts)`);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h3>Connect your Twilio account</h3>
      <p style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 12 }}>
        Paste your Twilio Account SID and Auth Token (console.twilio.com → dashboard). The adapter
        validates them against Twilio&apos;s API, lists your phone numbers, and — with a public host
        set — auto-points every number&apos;s voice webhook at the governance stream. Credentials stay
        in adapter memory only and are never logged or persisted.
      </p>
      <div style={{ display: 'grid', gap: 8, maxWidth: 520 }}>
        <input className="mono" style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          placeholder="Account SID (AC…)" value={accountSid} onChange={e => setAccountSid(e.target.value)} autoComplete="off" />
        <input className="mono" style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          placeholder="Auth Token" type="password" value={authToken} onChange={e => setAuthToken(e.target.value)} autoComplete="off" />
        <input className="mono" style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          placeholder="Public host (e.g. xxxx.ngrok.app) — optional" value={publicHost} onChange={e => setPublicHost(e.target.value)} />
        <label style={{ fontSize: 12, color: 'var(--dim)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={configureNumbers} onChange={e => setConfigureNumbers(e.target.checked)} />
          Auto-configure voice webhooks on my numbers
        </label>
        <button className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={() => { void submit(); }} disabled={state === 'working' || !accountSid || !authToken}>
          {state === 'working' ? 'Validating with Twilio…' : 'Connect Twilio'}
        </button>
      </div>
      {result && (
        <pre className="mono" style={{
          marginTop: 12, padding: 10, borderRadius: 6, background: 'var(--bg2)',
          color: state === 'error' ? 'var(--red)' : 'var(--green)', whiteSpace: 'pre-wrap', fontSize: 12,
        }}>{result}</pre>
      )}
    </div>
  );
}