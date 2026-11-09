// Five9 Intelligent Cloud connector — adapts Five9 into the CX Trust governance API.
//
// Ingestion surface (documented against Five9's real one, implemented here for
// the standard event shape):
//   Five9 Intelligent Cloud emits conversation-intelligence / call events
//   (CALL_STARTED, CUSTOMER_TALK_DETECT, CALLCENTER_AGENT_TALK,
//   PARTICIPANT_JOIN, CALL_END) to a configured HTTPS webhook. This adapter
//   receives them at POST /five9/events and verifies the HMAC-SHA256 signature
//   over the RAW request body (header x-five9-signature) when
//   CXTRUST_FIVE9_SECRET is configured.
//
// Five9 production payload shapes vary by subscription (Core Control vs
// Conversation Intelligence add-ons); this adapter validates signatures and
// NORMALIZES the standard shape below into the governance event flow. It does
// not claim to parse every variant natively — a thin translation shim in
// front of handleEvent() covers vendor-specific encodings.
//
// Standard Five9-style payload:
//   { sessionId, ani, dialedNumber, customerName, mediaType: 'VOICE'|'CHAT',
//     events: [{ eventType: 'CUSTOMER_TALK_DETECT'|'CALLCENTER_AGENT_TALK'
//                  |'CALL_STARTED'|'CALL_END'|'PARTICIPANT_JOIN',
//               transcript?, aiSuspected?, timestamp? }] }
//
// Enforcement: a customer turn that requests a sensitive action
// (CHANGE_BANK_ACCOUNT-style phrases, detected like the nice adapter)
// triggers the session actions evaluate endpoint with the customer
// participant classified UNKNOWN_AI when the payload carries an aiSuspected
// flag (production: real voice-trust vendor + agent registry; demo:
// DemoVoiceAnalyzer maps the flag to a synthetic probability).
//
// Routes:
//   GET  /healthz               → { ok, adapter:'five9', interactions, blocks, ... }
//   POST /five9/events          → signed webhook receiver (401 on bad signature)
//   POST /five9/demo            → scripted 2-interaction demo (see src/demo.ts)
//   POST /five9/action/:id      → pre-action enforcement gate (same pattern as nice)
//   GET  /five9/interactions    → live governed interactions

import http from 'node:http';
import crypto from 'node:crypto';
import {
  detectSensitiveAction, runScriptedDemo, DEMO_FIVE9_AI_ANI,
  type DemoInteractionProcessor, type DemoSummary,
  type Five9Event, type Five9InteractionPayload,
} from './demo.ts';

const DEFAULT_API_BASE = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
const API_KEY = process.env.CXTRUST_API_KEY;
const PORT = Number(process.env.CXTRUST_FIVE9_PORT ?? 8803);
const ORG = process.env.CXTRUST_ORG ?? 'org-demo';

export type { DemoInteractionProcessor, DemoSummary, Five9Event, Five9InteractionPayload };
export { detectSensitiveAction, runScriptedDemo, FIVE9_SCRIPTED_INTERACTIONS, DEMO_FIVE9_BENIGN_ANI, DEMO_FIVE9_AI_ANI } from './demo.ts';

/** Voice analysis provider seam (same shape as the nice/genesys adapters). */
export interface VoiceAnalysis {
  syntheticProbability: number;
  replayProbability: number;
  impersonationProbability: number;
}
export interface VoiceAnalyzer {
  readonly id: string;
  analyze(input: { ani?: string; aiSuspected?: boolean }): VoiceAnalysis;
}

/**
 * DEMO analyzer — NOT production voice forensics. It maps the payload's own
 * aiSuspected flag (or the demo attack ANI) to a synthetic-voice probability
 * so the policy engine's R001 conditions can act on it. A real deployment
 * swaps in a voice-trust vendor here.
 */
export class DemoVoiceAnalyzer implements VoiceAnalyzer {
  readonly id = 'demo-signal-analyzer (NOT production voice forensics)';
  analyze(input: { ani?: string; aiSuspected?: boolean }): VoiceAnalysis {
    const suspect = input.aiSuspected === true || input.ani === DEMO_FIVE9_AI_ANI;
    return suspect
      ? { syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9 }
      : { syntheticProbability: 0.02, replayProbability: 0.01, impersonationProbability: 0.05 };
  }
}

let API_BASE = DEFAULT_API_BASE;
export function setApiBase(url: string) { API_BASE = url; }
export function getApiBase() { return API_BASE; }

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const init = {
    method,
    headers: { 'content-type': 'application/json', connection: 'close', ...(API_KEY ? { 'x-api-key': API_KEY } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  // retry once on transient connection resets (keep-alive races under load)
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, init);
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// HMAC signature verification (constant-time)
// ---------------------------------------------------------------------------

export function computeSignature(secret: string, rawBody: Buffer | string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verify the x-five9-signature header against the RAW body bytes.
 * Accepts a bare lowercase hex digest or a 'sha256=<hex>' prefixed form.
 * Uses timingSafeEqual; length mismatch short-circuits to false (timingSafeEqual
 * throws on unequal lengths).
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const presented = header.replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(presented)) return false;
  const expected = Buffer.from(computeSignature(secret, rawBody), 'utf8');
  const got = Buffer.from(presented, 'utf8');
  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(expected, got);
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export interface Five9InteractionState {
  interactionId: string; // governance id, INT-FIVE9-<five9SessionId>
  five9SessionId: string;
  scenario: string;
  ani?: string;
  dialedNumber?: string;
  customerName?: string;
  mediaType: 'VOICE' | 'CHAT';
  aiSuspected: boolean;
  eventsProcessed: number;
  violations: { decision: Record<string, unknown> }[];
  startedAt: string;
}

export class Five9IntelligentCloudConnector implements DemoInteractionProcessor {
  readonly id = 'five9';
  readonly platform = 'five9-intelligent-cloud';
  private interactions = new Map<string, Five9InteractionState>();
  private voice: VoiceAnalyzer;
  /** cumulative counters for /healthz */
  private interactionsTotal = 0;
  private blocksTotal = 0;
  /** true while CXTRUST_FIVE9_SECRET is unset and webhooks are being accepted unsigned */
  private configDegraded = false;
  /** In-memory HMAC secret set via POST /five9/configure (overrides env). */
  private configuredSecret?: string;
  private configuredAt?: string;

  constructor(opts: { voice?: VoiceAnalyzer } = {}) {
    this.voice = opts.voice ?? new DemoVoiceAnalyzer();
  }

  /** Connector-shaped adapter surface: no handshake — Five9 webhooks are configured out-of-band in the Five9 admin. */
  async register(): Promise<void> { /* webhook receiver is passive; nothing to negotiate */ }

  get activeCount() { return this.interactions.size; }

  /** Effective HMAC secret: UI-configured (in-memory) takes precedence over env. */
  private get secret(): string { return this.configuredSecret ?? process.env.CXTRUST_FIVE9_SECRET ?? ''; }

  /** Save the webhook HMAC secret (in-memory, never logged or persisted). */
  configure(input: { secret: string; publicHost?: string }): Record<string, unknown> {
    const secret = String(input.secret ?? '').trim();
    if (secret.length < 16) return { ok: false, error: 'shared secret must be at least 16 characters' };
    this.configuredSecret = secret;
    this.configuredAt = new Date().toISOString();
    this.configDegraded = false;
    const publicHost = String(input.publicHost ?? '').trim();
    return {
      ok: true,
      signatureVerification: true,
      webhookPath: '/five9/events',
      webhookUrl: publicHost ? `https://${publicHost.replace(/\/$/, '')}/five9/events` : null,
      signatureHeader: 'x-five9-signature',
      note: 'Point the Five9 event subscription at this URL; sign deliveries with hex(HMAC-SHA256(secret, rawBody)).',
    };
  }

  configureStatus(): Record<string, unknown> {
    const secret = this.secret;
    return {
      configured: !!secret,
      source: this.configuredSecret ? 'ui' : secret ? 'env' : null,
      configuredAt: this.configuredAt ?? null,
      degraded: !secret,
      secretMasked: secret ? `${secret.slice(0, 3)}…${secret.slice(-2)}` : null,
    };
  }
  get processedCount() { return this.interactionsTotal; }
  get blockCount() { return this.blocksTotal; }
  getInteraction(five9SessionId: string) { return this.interactions.get(five9SessionId); }
  health() {
    return {
      ok: true as const,
      adapter: 'five9',
      interactions: this.interactionsTotal,
      blocks: this.blocksTotal,
      active: this.interactions.size,
      config: {
        signatureVerification: !!process.env.CXTRUST_FIVE9_SECRET,
        degraded: this.configDegraded,
      },
    };
  }

  /** Create (once) the governed interaction + customer participant for a Five9 payload. */
  private async ensureSession(payload: Five9InteractionPayload, scenario: string): Promise<Five9InteractionState> {
    const existing = this.interactions.get(payload.sessionId);
    if (existing) return existing;
    if (!payload.sessionId) throw new Error('five9 payload requires sessionId');
    // The Five9-side AI-suspicion signal rides on the talk-detect events
    // (transcript analytics flag); production plugs a real agent registry +
    // voice-trust vendor behind the same seam.
    const aiSuspected = payload.events.some(e => e.aiSuspected === true);
    const interactionId = `INT-FIVE9-${payload.sessionId}`;
    await api('POST', '/v1/interactions', {
      organizationId: ORG,
      platform: 'five9-intelligent-cloud',
      channel: payload.mediaType === 'CHAT' ? 'chat' : 'voice',
      interactionId,
      metadata: {
        five9SessionId: payload.sessionId,
        ani: payload.ani,
        dialedNumber: payload.dialedNumber,
        customerName: payload.customerName,
        mediaType: payload.mediaType,
        scenario,
      },
    });
    await api('POST', `/v1/interactions/${interactionId}/participant`, {
      participantId: 'customer', interactionId, organizationId: ORG,
      kind: 'CUSTOMER',
      classification: aiSuspected ? 'UNKNOWN_AI' : 'HUMAN_UNKNOWN',
      identityConfidence: 0.3,
      authLevel: 'NONE',
      joinedAtOffsetS: 0,
      riskState: {},
    });
    const va = this.voice.analyze({ ani: payload.ani, aiSuspected });
    await api('POST', `/v1/interactions/${interactionId}/voice`, { participantId: 'customer', ...va }).catch(() => {});
    const state: Five9InteractionState = {
      interactionId, five9SessionId: payload.sessionId, scenario,
      ani: payload.ani, dialedNumber: payload.dialedNumber, customerName: payload.customerName,
      mediaType: payload.mediaType, aiSuspected,
      eventsProcessed: 0, violations: [], startedAt: new Date().toISOString(),
    };
    this.interactions.set(payload.sessionId, state);
    this.interactionsTotal += 1;
    return state;
  }

  /**
   * Pump normalized events into governance: turns append, sensitive customer
   * requests evaluate, CALL_END closes. Returns true when the batch carried
   * an end event (the session was ended and dropped from live state).
   */
  private async pumpEvents(state: Five9InteractionState, payload: Five9InteractionPayload): Promise<boolean> {
    const base = payload.events.length && payload.events[0].timestamp ? Date.parse(payload.events[0].timestamp) : NaN;
    let sawEnd = false;
    for (let i = 0; i < payload.events.length; i++) {
      const ev = payload.events[i];
      const raw = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      const offsetS = Number.isFinite(raw) && Number.isFinite(base) ? Math.max(0, Math.round((raw - base) / 1000)) : i * 2;
      if (ev.eventType === 'CUSTOMER_TALK_DETECT' && typeof ev.transcript === 'string') {
        await api('POST', `/v1/interactions/${state.interactionId}/turns`, { participantId: 'customer', text: ev.transcript, offsetS });
        const action = detectSensitiveAction(ev.transcript);
        if (action) {
          const d = await api('POST', `/v1/interactions/${state.interactionId}/actions`, {
            requestedAction: action, participantId: 'customer', intent: action,
          });
          const decision = (d as { decision?: Record<string, unknown> }).decision;
          if (decision && decision.allowed === false) {
            state.violations.push({ decision });
            this.blocksTotal += 1;
          }
        }
      } else if (ev.eventType === 'CALLCENTER_AGENT_TALK' && typeof ev.transcript === 'string') {
        await api('POST', `/v1/interactions/${state.interactionId}/turns`, { participantId: 'agent', text: ev.transcript, offsetS });
      } else if (ev.eventType === 'CALL_STARTED' || ev.eventType === 'PARTICIPANT_JOIN') {
        // call/join metadata is captured on the interaction record; no turn
      } else if (ev.eventType === 'CALL_END') {
        sawEnd = true;
      }
      state.eventsProcessed += 1;
    }
    return sawEnd;
  }

  /** Full episode: normalize a Five9 payload into create/append/evaluate/end calls. */
  async processInteraction(payload: Five9InteractionPayload, scenario = 'webhook'): Promise<DemoSummary> {
    const state = await this.ensureSession(payload, scenario);
    const sawEnd = await this.pumpEvents(state, payload);
    const snap = await api('GET', `/v1/interactions/${state.interactionId}`).catch(() => ({}) as Record<string, unknown>);
    const customer = (snap as { participants?: { participantId: string; classification: string }[] })
      .participants?.find(p => p.participantId === 'customer');
    const risk = Number((snap as { risk?: { overall?: number } }).risk?.overall ?? 0);
    if (sawEnd) await this.endInteraction(payload.sessionId);
    const first = state.violations[0];
    return {
      scenario: state.scenario,
      interactionId: state.interactionId,
      classification: customer?.classification ?? (state.aiSuspected ? 'UNKNOWN_AI' : 'HUMAN_UNKNOWN'),
      risk,
      blocked: state.violations.length > 0,
      matchedRule: first ? String((first.decision as { matchedRule?: string }).matchedRule ?? '') : null,
    };
  }

  /** Handle one normalized Five9 event payload (single episode batch). */
  async handleEvent(payload: Five9InteractionPayload): Promise<DemoSummary> {
    return this.processInteraction(payload, 'webhook');
  }

  async endInteraction(five9SessionId: string) {
    const state = this.interactions.get(five9SessionId);
    if (!state) return { ignored: true };
    await api('POST', `/v1/interactions/${state.interactionId}/end`).catch(() => {});
    this.interactions.delete(five9SessionId);
    return { ended: true };
  }

  /** Enforcement gate — call before executing a customer-risky action (mirrors nice checkAction). */
  async checkAction(five9SessionId: string, action: { requestedAction: string; amount?: number; intent?: string }): Promise<Record<string, unknown>> {
    const state = this.interactions.get(five9SessionId);
    if (!state) return { allowed: false, reason: 'no governed session for this sessionId' };
    const d = await api('POST', `/v1/interactions/${state.interactionId}/actions`, {
      requestedAction: action.requestedAction, participantId: 'customer',
      amount: action.amount, intent: action.intent ?? action.requestedAction,
    });
    const decision = (d as { decision?: Record<string, unknown> }).decision;
    if (decision && decision.allowed === false) {
      state.violations.push({ decision });
      this.blocksTotal += 1;
    }
    return { decision };
  }

  /** Run the scripted 2-interaction demo against the governance API. */
  async runDemo(): Promise<DemoSummary[]> {
    return runScriptedDemo(this);
  }

  /** HTTP server for webhook + demo + health. */
  listen(port = PORT) {
    const server = http.createServer((req, res) => { void this.httpHandler(req, res); });
    server.listen(port, () => {
      console.log(`five9 connector listening :${port} · api ${API_BASE} · webhook /five9/events · hmac ${process.env.CXTRUST_FIVE9_SECRET ? 'on' : 'OFF (degraded)'}`);
    });
    return server;
  }

  private async httpHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return json(200, this.health());
      }
      // Integration endpoints: the console saves the webhook HMAC secret here.
      // In-memory only (this process) — never logged or persisted.
      if (req.method === 'POST' && url.pathname === '/five9/configure') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { secret?: string; publicHost?: string };
        const result = this.configure({ secret: String(body.secret ?? ''), publicHost: body.publicHost });
        return json(result.ok ? 200 : 400, result);
      }
      if (req.method === 'GET' && url.pathname === '/five9/configure/status') {
        return json(200, this.configureStatus());
      }
      if (req.method === 'POST' && url.pathname === '/five9/events') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks);
        const secret = this.secret;
        if (secret) {
          if (!verifySignature(raw, req.headers['x-five9-signature'] as string | undefined, secret)) {
            return json(401, { error: 'invalid or missing x-five9-signature' });
          }
        } else {
          this.configDegraded = true;
        }
        let body: unknown;
        try {
          body = JSON.parse(raw.toString('utf8') || 'null');
        } catch {
          return json(400, { error: 'invalid JSON body' });
        }
        const list = Array.isArray(body) ? body : [body];
        for (const p of list) {
          if (!p || typeof (p as Five9InteractionPayload).sessionId !== 'string'
            || !Array.isArray((p as Five9InteractionPayload).events)) {
            return json(400, { error: 'expected { sessionId, mediaType, events:[...] } (or array thereof)' });
          }
        }
        const results = [];
        for (const p of list) results.push(await this.handleEvent(p as Five9InteractionPayload));
        return json(200, {
          accepted: true,
          ...(secret ? {} : { config: { degraded: true, reason: 'CXTRUST_FIVE9_SECRET unset — signatures not verified' } }),
          results,
        });
      }
      if (req.method === 'POST' && url.pathname === '/five9/demo') {
        const summaries = await this.runDemo();
        return json(200, {
          adapter: 'five9',
          demo: true,
          apiBase: API_BASE,
          interactions: summaries,
          blocks: this.blocksTotal,
        });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/five9/action/')) {
        const five9SessionId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* keep empty */ }
        const result = await this.checkAction(five9SessionId, {
          requestedAction: String(body.requestedAction ?? ''),
          amount: body.amount !== undefined ? Number(body.amount) : undefined,
          intent: body.intent !== undefined ? String(body.intent) : undefined,
        });
        return json(200, result);
      }
      if (req.method === 'GET' && url.pathname === '/five9/interactions') {
        // `active` mirrors `interactions` so the web connectors page probe
        // (calls ?? streams ?? active) renders live rows like genesys does.
        const live = [...this.interactions.values()];
        return json(200, { interactions: live, active: live });
      }
      return json(404, { error: 'not found' });
    } catch (err) {
      return json(500, { error: String((err as Error).message) });
    }
  }
}

export function main() {
  const connector = new Five9IntelligentCloudConnector();
  connector.listen();
}

if (process.argv[1] && process.argv[1].endsWith('index.ts')) main();
