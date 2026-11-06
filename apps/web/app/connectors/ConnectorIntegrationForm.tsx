'use client';

// Generic webhook/relay integration form, embedded in each connector card.
// Two flavors:
//   hmac  — shared secret (+ optional public host): NICE, Five9, Cisco, Avaya
//   relay — notification URL (+ optional API token): Genesys Cloud
// Values are sent to the local adapter over localhost and never persisted to
// disk; the browser session only holds them in the form state.

import { useState } from 'react';

type Flavor = 'hmac' | 'relay';

interface ConfigResult {
  ok?: boolean;
  error?: string;
  webhookUrl?: string | null;
  signatureHeader?: string;
  notifUrl?: string;
  note?: string;
}

export default function ConnectorIntegrationForm(props: {
  adapter: string;            // proxy adapter key: nice | five9 | cisco | avaya | genesys
  label: string;              // display name, e.g. "NICE CXone"
  flavor: Flavor;
}) {
  const { adapter, label, flavor } = props;
  const [secret, setSecret] = useState('');
  const [publicHost, setPublicHost] = useState('');
  const [notifUrl, setNotifUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [state, setState] = useState<'idle' | 'working' | 'ok' | 'error'>('idle');
  const [result, setResult] = useState<string>('');

  async function submit() {
    setState('working');
    setResult('');
    const path = `/${adapter}/configure`;
    const body = flavor === 'hmac'
      ? { secret, publicHost }
      : { notifUrl, apiToken };
    try {
      const res = await fetch(`/api/adapter?adapter=${adapter}&path=${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json() as ConfigResult;
      if (j.ok) {
        setState('ok');
        const lines: string[] = [];
        if (flavor === 'hmac') {
          lines.push(`✓ ${label} shared secret saved — signature verification ON (header: ${j.signatureHeader})`);
          if (j.webhookUrl) lines.push(`   point the event subscription at: ${j.webhookUrl}`);
        } else {
          lines.push(`✓ ${label} notification relay saved`);
          if (j.notifUrl) lines.push(`   channel: ${j.notifUrl}`);
        }
        if (j.note) lines.push(`   ${j.note}`);
        setResult(lines.join('\n'));
      } else {
        setState('error');
        setResult(j.error ?? 'configuration failed');
      }
    } catch (e) {
      setState('error');
      setResult(`adapter unreachable: ${String((e as Error).message)} — is the ${label} adapter running?`);
    }
  }

  const inputStyle = { background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' } as const;

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Connect your {label}</div>
      <div style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
        {flavor === 'hmac' ? (
          <>
            <input className="mono" style={inputStyle}
              placeholder="Shared secret (webhook HMAC, min 16 chars)" type="password"
              value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off" />
            <input className="mono" style={inputStyle}
              placeholder="Public host (e.g. xxxx.ngrok.app) — optional"
              value={publicHost} onChange={e => setPublicHost(e.target.value)} autoComplete="off" />
          </>
        ) : (
          <>
            <input className="mono" style={inputStyle}
              placeholder="Notification channel URL (wss://…)"
              value={notifUrl} onChange={e => setNotifUrl(e.target.value)} autoComplete="off" />
            <input className="mono" style={inputStyle}
              placeholder="API token (relay → Genesys) — optional" type="password"
              value={apiToken} onChange={e => setApiToken(e.target.value)} autoComplete="off" />
          </>
        )}
        <button className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={() => { void submit(); }}
          disabled={state === 'working' || (flavor === 'hmac' ? secret.length < 16 : !notifUrl)}>
          {state === 'working' ? 'Saving…' : `Connect ${label}`}
        </button>
      </div>
      {result && (
        <pre className="mono" style={{
          marginTop: 10, padding: 10, borderRadius: 6, background: 'var(--bg2)',
          color: state === 'error' ? 'var(--red)' : 'var(--green)', whiteSpace: 'pre-wrap', fontSize: 12,
        }}>{result}</pre>
      )}
    </div>
  );
}