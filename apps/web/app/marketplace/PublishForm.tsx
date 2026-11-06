'use client';

// Publish a plugin manifest through the API proxy. The manifest JSON arrives
// as a plain string prop from the server page — this bundle never imports
// @cxtrust/marketplace. Client-side JSON.parse errors surface inline before
// anything is sent; the server's response (201 with status/reason, or an
// error body / 503 from the proxy) is rendered inline verbatim.

import { useState } from 'react';

export default function PublishForm({ initialManifest }: { initialManifest: string }) {
  const [text, setText] = useState(initialManifest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function publish() {
    setError(null);
    setResult(null);
    setOk(false);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Manifest is not valid JSON: ${String((e as Error).message)}`);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/cxtrust?path=/v1/marketplace/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setOk(true);
        const b = (body ?? {}) as { pluginId?: string; status?: string; reason?: string };
        setResult(
          [
            `HTTP ${res.status} — published.`,
            b.pluginId ? `pluginId: ${b.pluginId}` : '',
            b.status ? `status: ${b.status}${b.status === 'unverified' ? ' (unsigned — signature required for verification)' : ''}` : '',
            b.reason ? `reason: ${b.reason}` : '',
          ].filter(Boolean).join('\n'),
        );
      } else {
        setResult(`HTTP ${res.status} — ${JSON.stringify(body ?? 'no response body')}`);
      }
    } catch (e) {
      setError(`Publish request failed: ${String((e as Error).message)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h3>Publish a plugin manifest</h3>
      <p style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 10 }}>
        POST /v1/marketplace/publish. Unsigned manifests land as{' '}
        <span className="mono">unverified</span>; a manifest with a valid detached Ed25519
        signature from a trusted issuer key is verified on arrival. Risky permissions still
        require an approver + recorded justification at install time.
      </p>
      <textarea
        className="mono"
        spellCheck={false}
        value={text}
        onChange={e => setText(e.target.value)}
        rows={16}
        style={{
          width: '100%', boxSizing: 'border-box', resize: 'vertical',
          background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)',
          borderRadius: 6, padding: 10, fontSize: 12, lineHeight: 1.5,
        }}
      />
      <div style={{ marginTop: 10 }}>
        <button className="btn btn-primary" onClick={() => { void publish(); }} disabled={busy}>
          {busy ? 'Publishing…' : 'Publish manifest'}
        </button>
      </div>
      {error && (
        <pre className="mono" style={{ marginTop: 10, padding: 10, borderRadius: 6, background: 'var(--bg2)', color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {error}
        </pre>
      )}
      {result && (
        <pre className="mono" style={{ marginTop: 10, padding: 10, borderRadius: 6, background: 'var(--bg2)', color: ok ? 'var(--green)' : 'var(--amber)', whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {result}
        </pre>
      )}
    </div>
  );
}
