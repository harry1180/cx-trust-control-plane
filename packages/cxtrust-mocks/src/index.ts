// Mock Connectors — LiveKit + Pipecat shapes producing canonical events
// against the real governance API. Demo/testing only; clearly labeled.
//
// LiveKit mock: webhook receiver accepting room_start / participant events
// (the subset a real LiveKit webhook sends) + a token-free demo path.
// Pipecat mock: frame-emitting voice agent — emits transcript "frames" for
// a scripted conversation through the standard governance path.
//
// Both follow the established adapter pattern: own port, /healthz, normalize
// into the SAME POST /v1/interactions flow, degraded-mode honesty.

import * as http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const API_BASE = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
const API_KEY = process.env.CXTRUST_API_KEY;

export interface MockAdapterOpts {
  key: string;
  port: number;
  platform: string;
  label: string;
  /** optional shared secret for webhook HMAC (demo: CXTRUST_<KEY>_SECRET) */
  secretEnv?: string;
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(API_KEY ? { 'x-api-key': API_KEY } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  try { return (await res.json()) as Record<string, unknown>; } catch { return {}; }
}

/** Scripted two-turn demo conversations per adapter. */
const SCRIPTS: Record<string, { customer: string; agent: string; action?: { requestedAction: string; intent?: string } }[]> = {
  livekit: [
    { customer: 'Hi, I am calling from a WebRTC session through LiveKit. I need to check my billing statement.', agent: 'I can help review the billing statement.', action: { requestedAction: 'READ_BALANCE', intent: 'BALANCE_INQUIRY' } },
  ],
  pipecat: [
    { customer: 'Please update the mailing address on my account.', agent: 'Updating the mailing address for you now.', action: { requestedAction: 'UPDATE_ADDRESS', intent: 'PROFILE_CHANGE' } },
  ],
};

export class MockConnectorAdapter {
  private opts: MockAdapterOpts;
  private degraded: boolean;
  private runs = new Map<string, { interactionId: string; script: string; step: number }>();

  constructor(opts: MockAdapterOpts) {
    this.opts = opts;
    this.degraded = !process.env[opts.secretEnv ?? ''];
  }

  /** Verify HMAC if a secret is configured; unsigned accepted in degraded mode (labeled). */
  verifySignature(raw: string, signature: string | undefined): boolean {
    const secret = process.env[this.opts.secretEnv ?? ''];
    if (!secret) return true; // degraded mode — webhooks accepted unsigned, healthz shows it
    if (!signature) return false;
    const mac = createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(mac);
    const b = Buffer.from(signature.replace(/^sha256=/, ''));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  get health(): Record<string, unknown> {
    return {
      ok: true,
      platform: this.opts.platform,
      mode: 'MOCK (synthetic events for demos — not a real integration)',
      degraded: this.degraded,
      activeRuns: this.runs.size,
    };
  }

  /** Run the scripted demo conversation through the real governance path. */
  async runDemo(script: string): Promise<Record<string, unknown>> {
    const steps = SCRIPTS[script] ?? [];
    if (!steps.length) return { ok: false, error: `unknown script '${script}' (have: ${Object.keys(SCRIPTS).join(',')})` };
    const started = await api('POST', '/v1/interactions', {
      organizationId: process.env.CXTRUST_ORG ?? 'org-demo',
      platform: this.opts.platform,
      metadata: { label: `${this.opts.label} demo`, mock: true },
    });
    const interactionId = String(started.interactionId ?? '');
    const pid = 'p-caller';
    await api('POST', `/v1/interactions/${interactionId}/participant`, {
      participantId: pid, interactionId, organizationId: 'org-demo',
      kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.4,
      authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
    });
    let offset = 2;
    let last: Record<string, unknown> = {};
    for (const step of steps) {
      last = (await api('POST', `/v1/interactions/${interactionId}/turns`, { participantId: pid, text: step.customer, offsetS: offset })) as Record<string, unknown>;
      offset += 6;
      last = (await api('POST', `/v1/interactions/${interactionId}/turns`, { participantId: 'p-agent', text: step.agent, offsetS: offset, kind: 'agent' })) as Record<string, unknown>;
      offset += 4;
      if (step.action) {
        last = (await api('POST', `/v1/interactions/${interactionId}/actions`, {
          requestedAction: step.action.requestedAction, participantId: pid, intent: step.action.intent,
        })) as Record<string, unknown>;
      }
    }
    await api('POST', `/v1/interactions/${interactionId}/end`, {});
    this.runs.delete(interactionId);
    return { ok: true, interactionId, platform: this.opts.platform, snapshot: last };
  }
}

/** Build the HTTP server for one mock adapter. */
export function serveMockAdapter(opts: MockAdapterOpts): http.Server {
  const adapter = new MockConnectorAdapter(opts);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, adapter.health);
    const raw: string[] = [];
    for await (const c of req) raw.push(String(c));
    const body = raw.join('');
    const sig = req.headers['x-signature'] as string | undefined;
    if (!adapter.verifySignature(body, sig)) return json(res, 401, { error: 'invalid signature' });
    let payload: Record<string, unknown> = {};
    try { payload = body ? JSON.parse(body) as Record<string, unknown> : {}; } catch { return json(res, 400, { error: 'invalid JSON' }); }

    if (req.method === 'POST' && url.pathname.endsWith('/demo')) {
      return json(res, 200, await adapter.runDemo(String(payload.script ?? opts.key)));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/webhook')) {
      // LiveKit shape: {event:'room_started'|'participant_joined', room:{name}, participant:{identity}}
      // Pipecat shape: {frame:'transcript', text, speaker}
      const ev = String(payload.event ?? payload.frame ?? '');
      return json(res, 200, { received: true, event: ev, note: 'mock webhook accepted (normalized demo path: POST /<key>/demo)' });
    }
    return json(res, 404, { error: 'not found' });
  });
}