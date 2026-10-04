// Live Transcription page — the standalone TTV Live app (ephemeral mic →
// faster-whisper → share-link viewers) embedded directly in this console
// page.
//
// The app runs as its own sidecar service (compose project `ttv`, :8820)
// behind the same Traefik proxy on the public domain:
//   host page    https://…/live            (sidecar `/`, prefix-stripped)
//   share links  https://…/live/<id>       (sidecar `/live/<id>`)
//   health probe  https://…/live-healthz    (sidecar `/healthz`)
// Transcripts live only in that service's memory and die with the session.
//
// The iframe is same-origin with this console, so the microphone permission
// inherits — no new tab, no extra grant. This page probes healthz, embeds
// the host app, and documents the governance hand-off (turns API).

const LIVE_URL = process.env.NEXT_PUBLIC_LIVE_URL ?? 'https://governance.agenticalchemy.io';
const LIVE_APP_URL = `${LIVE_URL}/live`;
const LIVE_HEALTH_URL = `${LIVE_URL}/live-healthz`;

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
    const res = await fetch(LIVE_HEALTH_URL, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (res.ok) health = (await res.json()) as LiveHealth;
  } catch { /* offline panel below */ }

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Live Transcription</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Ephemeral live transcription — one mic speaker, unlimited anonymous viewers.
        Transcripts live only in the service's memory and are destroyed when the
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
            <span className="pill pill-gray mono">{LIVE_HEALTH_URL}</span>
          </div>
        ) : (
          <div>
            <span className="pill pill-red mono">OFFLINE</span>
            <p style={{ color: 'var(--dim)', fontSize: 12, marginTop: 8 }}>
              The live-transcription sidecar is not reachable at {LIVE_HEALTH_URL}. Start it:
            </p>
            <pre className="mono" style={{ margin: '8px 0', color: 'var(--text)', background: 'var(--bg2)', padding: 10, borderRadius: 6 }}>
cd /opt/yard/thethinkingvoicetranslator && docker compose up -d --build
            </pre>
          </div>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>1 · Host — record & share (this page)</h3>
        <p style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 10 }}>
          Click <strong>Record</strong> and speak — the microphone is transcribed live
          (word-level commit ~0.8 s behind speech) with no cloud speech API. Then click
          <strong> Share</strong>: viewers open the link
          (<span className="mono">{`${LIVE_URL}/live/<session-id>`}</span>) read-only,
          no account.
        </p>
        {health ? (
          <iframe
            src={LIVE_APP_URL}
            title="Live transcription — host"
            allow="microphone"
            style={{
              width: '100%',
              height: '72vh',
              border: '1px solid var(--border, #1e2a38)',
              borderRadius: 8,
              background: '#070a12',
            }}
          />
        ) : (
          <span className="pill pill-gray mono">The host app appears here once the sidecar is online.</span>
        )}
      </div>

      <div className="grid2">
        <div className="panel">
          <h3>2 · Share (anonymous viewers)</h3>
          <p style={{ color: 'var(--dim)', fontSize: 12 }}>
            After recording starts, click <strong>Share</strong> on the host app above —
            it gives a <span className="mono">{`/live/<id>`}</span> link on this domain.
            Anyone with the link (no account) sees the same live transcript, read-only.
          </p>
          <span className="pill pill-gray mono" style={{ fontSize: 10 }}>{`${LIVE_URL}/live/<session-id>`}</span>
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
          The standalone app is served unchanged by the sidecar and embedded
          here; this console documents the governance hand-off.
        </p>
      </div>
    </div>
  );
}
