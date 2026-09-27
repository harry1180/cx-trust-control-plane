// Live Transcription page — integrates the standalone TTV Live app
// (ephemeral mic → faster-whisper → share-link viewers) as a console page.
//
// The app itself runs as its own sidecar service (default :8820) and is used
// UNCHANGED: one microphone speaker hosts a session, any number of anonymous
// read-only viewers join via /live/<id> share links; transcripts live only
// in that service's memory and die with the session.
//
// This page: probes the sidecar's healthz, links into it (host + viewer
// flows), and documents the governance relationship — transcripts produced
// here can be fed into the governed path via the standard turns API.

import { ApiOffline } from '../lib/api';

const LIVE_URL = process.env.NEXT_PUBLIC_LIVE_URL ?? 'http://localhost:8820';

interface LiveHealth {
  ok: boolean;
  model_ready: boolean;
  model: string;
  sessions: number;
}

export default async function LiveTranscriptionPage() {
  // Direct fetch (apiGet prepends the governance API base — wrong host here).
  let health: LiveHealth | null = null;
  try {
    const res = await fetch(`${LIVE_URL}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (res.ok) health = (await res.json()) as LiveHealth;
  } catch { /* offline panel below */ }

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Live Transcription</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Ephemeral live transcription — one mic speaker, unlimited anonymous viewers.
        Transcripts live only in the service&apos;s memory and are destroyed when the
        session ends; share links die with it. Nothing is persisted or logged.
      </p>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>Service status</h3>
        {health ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className={`pill ${health.ok ? 'pill-green' : 'pill-red'} mono`}>
              {health.ok ? 'ONLINE' : 'DOWN'}
            </span>
            <span className={`pill ${health.model_ready ? 'pill-green' : 'pill-amber'} mono`}>
              {health.model_ready ? `MODEL READY — ${health.model}` : 'MODEL LOADING…'}
            </span>
            <span className="pill pill-gray mono">{health.sessions} active session(s)</span>
          </div>
        ) : (
          <div>
            <span className="pill pill-red mono">OFFLINE</span>
            <p style={{ color: 'var(--dim)', fontSize: 12, marginTop: 8 }}>
              The live-transcription sidecar is not reachable at {LIVE_URL}. Start it:
            </p>
            <pre className="mono" style={{ margin: '8px 0', color: 'var(--text)', background: 'var(--bg2)', padding: 10, borderRadius: 6 }}>
cd C:/Users/Kisha/projects/thethinkingvoicetranslator{"\n"}LIVE_PORT=8820 .venv/Scripts/python.exe backend/main.py
            </pre>
          </div>
        )}
      </div>

      <div className="grid3">
        <div className="panel">
          <h3>1 · Host (one speaker)</h3>
          <p style={{ color: 'var(--dim)', fontSize: 12 }}>
            Click Record and speak. Your microphone is transcribed live
            (word-level commit ~0.8 s behind speech) on your own machine —
            no cloud speech API.
          </p>
          <a href={`${LIVE_URL}/`} target="_blank" rel="noreferrer"
            style={{ display: 'inline-block', marginTop: 10, background: 'var(--blue)', color: '#fff', padding: '8px 16px', borderRadius: 6, textDecoration: 'none' }}>
            Open host page ↗
          </a>
        </div>

        <div className="panel">
          <h3>2 · Share (anonymous viewers)</h3>
          <p style={{ color: 'var(--dim)', fontSize: 12 }}>
            After recording starts, click <strong>Share</strong> on the host page —
            it gives a /live/&lt;id&gt; link. Anyone with the link (no account)
            sees the same live transcript, read-only.
          </p>
          <span className="pill pill-gray mono" style={{ fontSize: 10 }}>{LIVE_URL}/live/&lt;session-id&gt;</span>
        </div>

        <div className="panel">
          <h3>3 · Govern (optional)</h3>
          <p style={{ color: 'var(--dim)', fontSize: 12 }}>
            Transcript lines can be posted into the governed path for PII /
            prompt-injection detection, policy decisions, and the evidence chain:
          </p>
          <pre className="mono" style={{ fontSize: 10, background: 'var(--bg2)', padding: 8, borderRadius: 6, overflowX: 'auto' }}>{`POST /v1/interactions
POST /v1/interactions/{id}/turns
  {participantId, text, offsetS}`}</pre>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3>How it works</h3>
        <p style={{ color: 'var(--dim)', fontSize: 12, margin: 0 }}>
          Browser mic (16 kHz mono PCM16, AudioWorklet) → WebSocket → FastAPI
          per-session buffer → faster-whisper rolling decode window with word
          timestamps → partial + final transcript broadcast to host and viewers.
          Model: faster-whisper (open source, MIT); engine runs locally on CPU.
          The standalone app is used unchanged; this console only links to it and
          documents the governance hand-off.
        </p>
      </div>
    </div>
  );
}