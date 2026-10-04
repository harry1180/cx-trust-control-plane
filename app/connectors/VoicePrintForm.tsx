'use client';

// Voice biometrics card: consent-gated enrollment + verification against the
// in-house voiceprint (adapter /connect/voiceprint/*). Enrollment REQUIRES the
// explicit consent checkbox — without it the adapter rejects before touching
// the audio. Only derived statistics are stored (never raw audio), the store
// file is local + gitignored, and delete removes template + consent record.

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

interface VpStatus {
  enrolled: boolean;
  template?: {
    enrolledAt: string;
    consent: { at: string; by: string; note: string };
    label?: string | null;
    durationS: number;
  } | null;
}

const PATH = '/api/adapter?adapter=connect&path=';

async function adapterCall(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(PATH + path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function fileToBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const inputStyle: CSSProperties = { background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' };

export default function VoicePrintForm() {
  const [status, setStatus] = useState<VpStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [consentBy, setConsentBy] = useState('');
  const [enrollFile, setEnrollFile] = useState<File | null>(null);
  const [verifyFile, setVerifyFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const s = await adapterCall('/connect/voiceprint/status');
    if (s.json.ok) setStatus(s.json as unknown as VpStatus);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function enroll() {
    if (!enrollFile || !consent) return;
    setBusy(true); setResult(null);
    try {
      const audio = await fileToBase64(enrollFile);
      const r = await adapterCall('/connect/voiceprint/enroll', { consent: true, consentBy: consentBy || 'unspecified', label: enrollFile.name, audio });
      if (r.json.ok) {
        setResult({ ok: true, text: `✓ Voiceprint enrolled at ${String(r.json.enrolledAt)} · consent by "${String((r.json.consent as { by?: string })?.by)}" · ${String(r.json.speechFrames)} speech frames · pitch captured: ${String(r.json.pitchCaptured)}` });
        setConsent(false); setEnrollFile(null);
      } else setResult({ ok: false, text: String(r.json.error ?? `HTTP ${r.status}`) });
      await refresh();
    } catch (e) {
      setResult({ ok: false, text: String((e as Error).message) });
    } finally { setBusy(false); }
  }

  async function verify() {
    if (!verifyFile) return;
    setBusy(true); setResult(null);
    try {
      const audio = await fileToBase64(verifyFile);
      const r = await adapterCall('/connect/voiceprint/verify', { audio });
      if (r.json.ok) {
        const sim = Number(r.json.similarity);
        const match = r.json.match === true;
        setResult({
          ok: match,
          text: `${match ? '✓ MATCH' : '✗ NO MATCH'} — similarity ${sim.toFixed(3)} (threshold ${String(r.json.threshold)}) · parts: mfcc-mean ${Number((r.json.parts as { mfccMean?: number })?.mfccMean ?? 0).toFixed(2)} · mfcc-std ${Number((r.json.parts as { mfccStd?: number })?.mfccStd ?? 0).toFixed(2)} · pitch ${Number((r.json.parts as { pitch?: number })?.pitch ?? 0).toFixed(2)}`,
        });
      } else setResult({ ok: false, text: String(r.json.error ?? `HTTP ${r.status}`) });
    } catch (e) {
      setResult({ ok: false, text: String((e as Error).message) });
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    const r = await adapterCall('/connect/voiceprint/delete', {});
    setResult({ ok: true, text: r.json.deleted ? '✓ Voiceprint + consent record deleted.' : 'Nothing to delete.' });
    await refresh();
    setBusy(false);
  }

  const enrolled = !!status?.enrolled;

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h3>Voice biometrics · in-house voiceprint</h3>
      <p style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 12 }}>
        Register a voice as a biometric template (MFCC + pitch statistics — derived numbers only,
        raw audio is never stored), then verify a later recording against it. Enrollment requires
        your explicit consent below; the consent record is stored with the template. Speaker
        SIMILARITY heuristic — clearly-labeled in-house capability, not a forensic identity system.
        Audio must be 16kHz mono 16-bit WAV (ffmpeg -i in -ar 16000 -ac 1 -c:a pcm_s16le out.wav).
      </p>

      <div style={{ fontSize: 12, marginBottom: 10 }}>
        {status === null ? <span style={{ color: 'var(--dim)' }}>checking status…</span>
          : enrolled ? (
            <span>
              <span className="pill pill-green">ENROLLED</span>{' '}
              {status.template?.enrolledAt} · consent by “{status.template?.consent.by}” at {status.template?.consent.at}
            </span>
          ) : <span className="pill pill-gray">NOT ENROLLED</span>}
      </div>

      <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
        <input style={inputStyle} type="file" accept=".wav,audio/wav" onChange={e => setEnrollFile(e.target.files?.[0] ?? null)} />
        <input style={inputStyle} placeholder="Consent recorded as (your name or identifier)" value={consentBy} onChange={e => setConsentBy(e.target.value)} autoComplete="off" />
        <label style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ marginTop: 2 }} />
          <span>I consent to enrolling this recording as my voice biometric template, stored locally as derived statistics with this consent record, and to verification against it. (Required — without it, enrollment is rejected before any audio is processed.)</span>
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={busy || !enrollFile || !consent} onClick={() => { void enroll(); }}>
            {busy ? 'Working…' : 'Enroll voiceprint'}
          </button>
          <input style={inputStyle} type="file" accept=".wav,audio/wav" onChange={e => setVerifyFile(e.target.files?.[0] ?? null)} />
          <button className="btn" disabled={busy || !verifyFile || !enrolled} onClick={() => { void verify(); }}>
            Verify identity
          </button>
          <button className="btn" disabled={busy || !enrolled} onClick={() => { void remove(); }}>
            Delete template
          </button>
        </div>
      </div>

      {result && (
        <pre className="mono" style={{
          marginTop: 12, padding: 10, borderRadius: 6,
          background: 'var(--bg2)', color: result.ok ? 'var(--green)' : 'var(--red)',
          whiteSpace: 'pre-wrap', fontSize: 12,
        }}>{result.text}</pre>
      )}
    </div>
  );
}