'use client';

// Amazon Connect integration form: enter AWS Access Key ID + Secret Access Key
// + region + Connect instance ID, plus an OPTIONAL AWS Session Token for
// temporary (ASIA…) credentials. The adapter validates credentials against
// the real AWS Connect API (DescribeInstance + ListQueues). Credentials are
// sent to the local adapter over localhost and never persisted to disk; the
// browser session only holds them in the form state.

import { useState } from 'react';

export default function ConnectIntegrationForm() {
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [instanceId, setInstanceId] = useState('');
  const [state, setState] = useState<'idle' | 'working' | 'ok' | 'error'>('idle');
  const [result, setResult] = useState<string>('');

  async function submit() {
    setState('working');
    setResult('');
    try {
      const res = await fetch('/api/adapter?adapter=connect&path=/connect/configure', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessKeyId, secretAccessKey, sessionToken, region, instanceId }),
      });
      const j = await res.json() as { ok?: boolean; error?: string; validated?: boolean; temporaryAuth?: boolean; instanceAlias?: string; region?: string; queues?: { id: string; name: string }[] };
      if (j.ok) {
        setState('ok');
        const lines = [
          `✓ AWS credentials validated against Connect instance ${j.instanceAlias ?? instanceId} (${j.region ?? region})`,
          `   queues: ${(j.queues ?? []).slice(0, 8).map(q => q.name).join(', ') || 'none listed'}`,
          ...(j.temporaryAuth ? ['⚠ Temporary credentials (ASIA…): the session token expires — re-enter them when AWS rejects the next call.'] : []),
          'Media streaming (wss :8799/ws) and contact events are governed by this instance.',
        ];
        setResult(lines.join('\n'));
      } else {
        setState('error');
        setResult(j.error ?? 'configuration failed');
      }
    } catch (e) {
      setState('error');
      setResult(`adapter unreachable: ${String((e as Error).message)} — is the Connect adapter running? (cd packages/cxtrust-connect && node src/index.ts)`);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h3>Connect your Amazon Connect instance</h3>
      <p style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 12 }}>
        Paste an AWS Access Key ID and Secret Access Key (IAM user with
        connect:DescribeInstance / connect:ListQueues), the region, and your Connect
        instance ID (e.g. b03c9f29-8f2f-4d1e-… or the instance alias). For temporary
        (ASIA…) credentials also paste the AWS Session Token — it expires, so
        re-configure the connector when AWS starts rejecting calls. AKIA… keys need no
        token. The adapter validates everything against the AWS Connect API and lists
        your queues. Credentials stay in adapter memory only and are never logged or persisted.
      </p>
      <div style={{ display: 'grid', gap: 8, maxWidth: 520 }}>
        <input className="mono" style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          placeholder="AWS Access Key ID (AKIA…)" value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} autoComplete="off" />
        <input className="mono" style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          placeholder="AWS Secret Access Key" type="password" value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)} autoComplete="off" />
        <input className="mono" style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          placeholder="AWS Session Token (ASIA… temporary keys only — optional)" type="password" value={sessionToken} onChange={e => setSessionToken(e.target.value)} autoComplete="off" />
        <input className="mono" style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          placeholder="Region (e.g. us-east-1)" value={region} onChange={e => setRegion(e.target.value)} autoComplete="off" />
        <input className="mono" style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}
          placeholder="Connect Instance ID or alias" value={instanceId} onChange={e => setInstanceId(e.target.value)} autoComplete="off" />
        <button className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={() => { void submit(); }} disabled={state === 'working' || !accessKeyId || !secretAccessKey || !instanceId}>
          {state === 'working' ? 'Validating with AWS…' : 'Connect Amazon Connect'}
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