// Connectors — the "where do I connect my CX platform" surface.
// Probes adapter health DIRECTLY (adapters run on their own ports, not behind
// the API server proxy), server-side, with a short timeout so the page renders
// OFFLINE gracefully during build / when adapters are down.

const ADAPTER_TIMEOUT_MS = 1500;

interface AdapterHealth {
  ok: boolean;
  activeCalls?: number;
  activeStreams?: number;
  active?: number;
}

interface CallRow {
  interactionId?: string;
  contactId?: string;
  callId?: string;
  streamSid?: string;
  started?: string;
  startedAt?: string;
  [k: string]: unknown;
}

async function probe<T>(url: string): Promise<T | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ADAPTER_TIMEOUT_MS);
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface ConnectorStatus {
  key: string;
  name: string;
  port: number;
  base: string;
  live: boolean;
  sessions: number | null;
  calls: CallRow[];
}

async function probeConnector(
  key: string,
  name: string,
  port: number,
  callsPath: string,
): Promise<ConnectorStatus> {
  const base = `http://127.0.0.1:${port}`;
  const health = await probe<AdapterHealth>(`${base}/healthz`);
  const live = !!health?.ok;
  let sessions: number | null = null;
  let calls: CallRow[] = [];
  if (live) {
    const list = await probe<{ calls?: CallRow[]; streams?: CallRow[]; active?: CallRow[] }>(
      `${base}${callsPath}`,
    );
    calls = list?.calls ?? list?.streams ?? list?.active ?? [];
    sessions =
      health?.activeCalls ?? health?.activeStreams ?? health?.active ??
      (Array.isArray(calls) ? calls.length : null);
  }
  return { key, name, port, base, live, sessions, calls };
}

// ---------- How-to-connect snippets ----------

const CONNECT_SNIPPETS = {
  stream: `Amazon Connect contact flow → Live media streaming
  Set "Live media streaming" on the contact flow:
    Start media streaming → Audio: BOTH (customer + agent)
    Destination:  wss://[adapter-host]:8799/ws
  The adapter receives the raw audio websocket and evaluates
  policy on the live transcript.`,

  events: `EventBridge (all calls, inbound + outbound) → API destination → POST /connect/events
  No Lambda needed: EventBridge POSTs the raw event envelope directly.

  1. Expose the adapter with a token (local dev):
       cd packages/cxtrust-connect
       CXTRUST_CONNECT_TOKEN=<random-long-string> node src/index.ts
       cloudflared tunnel --url http://127.0.0.1:8799 → https://xxxx.trycloudflare.com
     The token keeps the public URL private: every route except /healthz
     then requires the x-cxtrust-token header (set the same value in the
     web console env so the connector card keeps working).

  2. EventBridge console → Create rule
       Event pattern: AWS services → Amazon Connect → Amazon Connect Contact Event
       Target: API destination → new API destination
         Endpoint: https://xxxx.trycloudflare.com/connect/events   (POST)
         Connection: new → API key → header name  x-cxtrust-token = <same token>

  3. The adapter consumes the envelope exactly as EventBridge sends it:

       { "detail-type": "Amazon Connect Contact Event",
         "source": "aws.connect",
         "detail": {
           "eventType": "INITIATED | QUEUED | CONNECTED_TO_AGENT | DISCONNECTED",
           "contactId": "…", "channel": "VOICE",
           "initiationMethod": "INBOUND | OUTBOUND | API | TRANSFER",
           "queueInfo": { "queueArn": "…" }
         } }

     INITIATED/QUEUED/CONNECTED_TO_AGENT open a governed session
     (idempotent — safe for at-least-once redelivery), DISCONNECTED closes
     it. Inbound AND outbound contacts are both covered.`,

  action: `Pre-action Lambda → consult the adapter before the action
  Call before any consequential action (transfer, payment step,
  data reveal). The adapter returns ALLOW or DENY:

    const res = await fetch(
      'http://[adapter-host]:8799/connect/action/' + encodeURIComponent(contactId),
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'TRANSFER', target: 'billing-escalation' }) }
    );
    const verdict = await res.json();

  Sample adapter response (DENY is enforced — abort the action):

    {
      "contactId": "abc-123",
      "action": "TRANSFER",
      "decision": "DENY",
      "reason": "No valid consent on file for escalated transfer",
      "matchedRule": "consent-required-for-transfer"
    }

  if (verdict.decision === 'DENY') {
    // do NOT perform the action; log verdict.reason
    return;
  }`,
};

const TWILIO_SNIPPET = `TwiML → Connect Stream (bidirectional)

<Response>
  <Connect>
    <Stream url="wss://[adapter-host]:8800/twilio">
      <Parameter name="customer_phone" value="{{From}}"/>
      <Parameter name="call_sid" value="{{CallSid}}"/>
    </Stream>
  </Connect>
</Response>

Bidirectional audio: the adapter can inject audio back on the
same websocket (audio/delta payloads) — use tracks="inbound"
only if you do NOT want injected audio played to the caller.`;

const GENESYS_SNIPPET = `Genesys Cloud → notification relay / webhook
  1. Create a Genesys Cloud notification channel + topic
     (v2.notifications.channels) for conversation events.
  2. Relay the notifications to the adapter webhook:

    POST http://[adapter-host]:8801/genesys/events
    Content-Type: application/json

    {
      "topicName": "v2.conversations",
      "eventBody": {
        "id": "<conversationId>",
        "state": "connected",
        "participants": [ ... ]
      }
    }

  The adapter derives interaction state and evaluates policy
  from the relayed conversation events.`;

const FUTURE_PLATFORMS: string[] = []; // all charter platforms now have adapters

const NICE_SNIPPET = `NICE CXone → Interaction Events webhook (HMAC-signed)
  1. Set a shared secret on the adapter:
       export CXTRUST_NICE_SECRET=<your-shared-secret>
  2. Expose the receiver (dev: ngrok; prod: your HTTPS host):
       ngrok http 8802
  3. Point the CXone event subscription at:
       https://<ngrok-host>/nice/events
     with header  x-nice-signature = hex( HMAC-SHA256(secret, rawBody) )

    Example signed delivery (Node):

      import crypto from 'node:crypto';
      const raw = JSON.stringify({
        interactionId: 'ACID-123',
        customerId: 'cust-1', ani: '<ANI>', mediaType: 'VOICE',
        events: [{ type: 'CUSTOMER_MESSAGE', text: 'hello', timestamp: new Date().toISOString() }]
      });
      await fetch('https://<ngrok-host>/nice/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nice-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex')
        },
        body: raw
      });

  Unsigned/invalid requests are rejected 401 when CXTRUST_NICE_SECRET is
  set; without a secret the adapter accepts but reports config.degraded.`;

function webhookSnippet(platform: string, key: string, port: number, env: string, note: string): string {
  return `${platform} → signed event webhook (pattern identical to NICE)
  1. export ${env}=<your-shared-secret>
  2. ngrok http ${port}   (dev) — point your ${platform} event subscription at:
       https://<ngrok-host>/${key}/events
     with header  x-${key}-signature = hex( HMAC-SHA256(secret, rawBody) )
  3. ${note}`;
}

const FIVE9_SNIPPET = webhookSnippet(
  'Five9', 'five9', 8803, 'CXTRUST_FIVE9_SECRET',
  'Payload: {sessionId, ani, mediaType, events:[{eventType, transcript?, aiSuspected?}]} — CALL_STARTED/CUSTOMER_TALK_DETECT/CALL_END normalized onto the governance flow.');
const CISCO_SNIPPET = webhookSnippet(
  'Cisco (Finesse/UCCX-style)', 'cisco', 8804, 'CXTRUST_CISCO_SECRET',
  'Payload: {interactionId, udid, ani, queue, events:[{type, text?, aiSuspected?}]} — INTERACTION_STARTED/CUSTOMER_DATA/INTERACTION_END normalized onto the governance flow.');
const AVAYA_SNIPPET = webhookSnippet(
  'Avaya (Engagement Orchestration-style)', 'avaya', 8805, 'CXTRUST_AVAYA_SECRET',
  'Payload: {sessionUrn, ani, mediaType, events:[{name, content?, aiSuspected?}]} — SESSION_STARTED/MESSAGE_RECEIVED/SESSION_ENDED normalized onto the governance flow.');

// ---------- Page ----------

import TwilioIntegrationForm from './TwilioIntegrationForm';
import ConnectIntegrationForm from './ConnectIntegrationForm';
import VoicePrintForm from './VoicePrintForm';
import BiomarkersToggle from './BiomarkersToggle';
import ConnectorIntegrationForm from './ConnectorIntegrationForm';
import ConnectorDemoButton from './ConnectorDemoButton';

export default async function ConnectorsPage() {
  const [connect, twilio, genesys, nice, five9, cisco, avaya] = await Promise.all([
    probeConnector('connect', 'Amazon Connect', 8799, '/connect/calls'),
    probeConnector('twilio', 'Twilio', 8800, '/twilio/streams'),
    probeConnector('genesys', 'Genesys Cloud', 8801, '/genesys/active'),
    probeConnector('nice', 'NICE CXone', 8802, '/nice/interactions'),
    probeConnector('five9', 'Five9', 8803, '/five9/interactions'),
    probeConnector('cisco', 'Cisco', 8804, '/cisco/interactions'),
    probeConnector('avaya', 'Avaya', 8805, '/avaya/interactions'),
  ]);
  const connectors = [connect, twilio, genesys, nice, five9, cisco, avaya];
  const live = connectors.filter(c => c.live);
  const anyLive = live.length > 0;

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Connectors</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Where each CX platform plugs into the CX Trust control plane. Status is probed
        directly against each adapter's health endpoint (1.5s timeout).
      </p>

      <ConnectIntegrationForm />

      <VoicePrintForm />

      <BiomarkersToggle />

      <TwilioIntegrationForm />

      {/* --- Adapter status cards --- */}
      <div className="statgrid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 16 }}>
        {connectors.map(c => (
          <div key={c.key} className="stat">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700 }}>{c.name}</span>
              <span className={`pill ${c.live ? 'pill-green' : 'pill-gray'}`}>
                {c.live ? 'LIVE' : 'OFFLINE'}
              </span>
            </div>
            <div className="num" style={{ marginTop: 6 }}>
              {c.live ? (c.sessions ?? '—') : <span style={{ color: 'var(--dim)' }}>—</span>}
            </div>
            <div className="lbl">active sessions · port {c.port}</div>
          </div>
        ))}
      </div>

      <div className="grid2" style={{ marginBottom: 16, alignItems: 'start' }}>
        {/* --- How to connect: Amazon Connect --- */}
        <div className="panel">
          <h3>Amazon Connect · port 8799</h3>
          <div style={{ marginBottom: 8 }}>
            <span className={`pill ${connect.live ? 'pill-green' : 'pill-gray'}`}>
              {connect.live ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <HowTo>
            <p style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 6 }}>
              Three integration points: live media streaming, contact events, and pre-action checks.
            </p>
            <Snippet label="1 · Live media streaming (contact flow)" code={CONNECT_SNIPPETS.stream} />
            <Snippet label="2 · Contact events (EventBridge + Lambda)" code={CONNECT_SNIPPETS.events} />
            <Snippet label="3 · Pre-action check (ALLOW / DENY)" code={CONNECT_SNIPPETS.action} />
          </HowTo>
          <ConnectorDemoButton adapter="connect" path="/connect/demo" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* --- How to connect: Twilio --- */}
          <div className="panel">
            <h3>Twilio · port 8800</h3>
            <div style={{ marginBottom: 8 }}>
              <span className={`pill ${twilio.live ? 'pill-green' : 'pill-gray'}`}>
                {twilio.live ? 'LIVE' : 'OFFLINE'}
              </span>
            </div>
            <HowTo>
              <Snippet label="TwiML Connect Stream" code={TWILIO_SNIPPET} />
            </HowTo>
          </div>

          {/* --- How to connect: Genesys --- */}
          <div className="panel">
            <h3>Genesys Cloud · port 8801</h3>
            <div style={{ marginBottom: 8 }}>
              <span className={`pill ${genesys.live ? 'pill-green' : 'pill-gray'}`}>
                {genesys.live ? 'LIVE' : 'OFFLINE'}
              </span>
            </div>
            <HowTo>
              <Snippet label="Notification relay / webhook" code={GENESYS_SNIPPET} />
            </HowTo>
            <ConnectorIntegrationForm adapter="genesys" label="Genesys Cloud" flavor="relay" />
            <ConnectorDemoButton adapter="genesys" path="/genesys/demo" />
          </div>

          {/* --- How to connect: NICE CXone --- */}
          <div className="panel">
            <h3>NICE CXone · port 8802</h3>
            <div style={{ marginBottom: 8 }}>
              <span className={`pill ${nice.live ? 'pill-green' : 'pill-gray'}`}>
                {nice.live ? 'LIVE' : 'OFFLINE'}
              </span>
            </div>
            <HowTo>
              <Snippet label="Interaction Events webhook (HMAC + ngrok)" code={NICE_SNIPPET} />
            </HowTo>
            <ConnectorIntegrationForm adapter="nice" label="NICE CXone" flavor="hmac" />
            <ConnectorDemoButton adapter="nice" path="/nice/demo" mode="pair" />
          </div>

          {/* --- No adapter yet --- */}
          {FUTURE_PLATFORMS.length > 0 && (
          <div className="panel">
            <h3>No adapter yet?</h3>
            <p style={{ fontSize: 13, color: 'var(--dim)', marginBottom: 8 }}>
              For <strong style={{ color: 'var(--text)' }}>{FUTURE_PLATFORMS.join(', ')}</strong> —
              follow the Connector interface — <span className="mono">docs/CONNECTOR_SDK.md</span>.
              Implement healthz, the events ingest, and the action consult endpoint to appear here.
            </p>
          </div>
          )}

          {/* --- How to connect: Five9 / Cisco / Avaya --- */}
          {[
            { c: five9, title: 'Five9 · port 8803', snippet: FIVE9_SNIPPET, demoPath: '/five9/demo' },
            { c: cisco, title: 'Cisco Contact Center · port 8804', snippet: CISCO_SNIPPET, demoPath: '/cisco/demo' },
            { c: avaya, title: 'Avaya EO-style · port 8805', snippet: AVAYA_SNIPPET, demoPath: '/avaya/demo' },
          ].map(({ c, title, snippet, demoPath }) => (
            <div className="panel" key={c.key}>
              <h3>{title}</h3>
              <div style={{ marginBottom: 8 }}>
                <span className={`pill ${c.live ? 'pill-green' : 'pill-gray'}`}>
                  {c.live ? 'LIVE' : 'OFFLINE'}
                </span>
              </div>
              <HowTo>
                <Snippet label="Signed event webhook (HMAC + ngrok)" code={snippet} />
              </HowTo>
              <ConnectorIntegrationForm adapter={c.key} label={c.name} flavor="hmac" />
              <ConnectorDemoButton adapter={c.key} path={demoPath} mode="pair" />
            </div>
          ))}
        </div>
      </div>

      {/* --- Live calls table / startup help --- */}
      {anyLive ? (
        <div className="panel">
          <h3>Live calls</h3>
          <table className="tbl">
            <thead>
              <tr>
                <th>Connector</th>
                <th>Interaction</th>
                <th>Contact / Call</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {live.flatMap(c =>
                c.calls.slice(0, 25).map((row, i) => (
                  <tr key={`${c.key}-${row.interactionId ?? row.contactId ?? i}`}>
                    <td className="mono">{c.name}</td>
                    <td className="mono">{str(row.interactionId)}</td>
                    <td className="mono">{str(row.contactId ?? row.callId ?? row.streamSid)}</td>
                    <td className="mono" style={{ color: 'var(--dim)' }}>
                      {str(row.started ?? row.startedAt)}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <h3>No adapters running</h3>
          <p style={{ fontSize: 13, color: 'var(--dim)', marginBottom: 10 }}>
            No adapters running — start them:
          </p>
          <pre className="mono" style={preStyle}>
{`cd packages/cxtrust-connect     && node src/index.ts   # Amazon Connect · :8799
cd packages/cxtrust-twilio      && node src/index.ts   # Twilio        · :8800
cd packages/cxtrust-genesys     && node src/index.ts   # Genesys       · :8801
cd packages/cxtrust-nice        && node src/index.ts   # NICE CXone    · :8802
cd packages/cxtrust-five9       && node src/index.ts   # Five9         · :8803
cd packages/cxtrust-cisco       && node src/index.ts   # Cisco         · :8804
cd packages/cxtrust-avaya       && node src/index.ts   # Avaya         · :8805`}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------- small local helpers (server components) ----------

const preStyle: React.CSSProperties = {
  background: 'var(--bg0)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 12,
  overflowX: 'auto',
  whiteSpace: 'pre',
  marginBottom: 10,
};

function str(v: unknown): string {
  if (v === undefined || v === null) return '—';
  return String(v);
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <details style={{ marginBottom: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13, marginBottom: 6 }}>{label}</summary>
      <pre className="mono" style={preStyle}>{code}</pre>
    </details>
  );
}

function HowTo({ children }: { children: React.ReactNode }) {
  return (
    <details>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>How to connect ▾</summary>
      <div style={{ marginTop: 10 }}>{children}</div>
    </details>
  );
}
