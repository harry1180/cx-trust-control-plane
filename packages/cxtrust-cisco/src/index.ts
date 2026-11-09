// Cisco Contact Center connector — adapts Cisco Finesse / UCCX into the CX
// Trust governance API.
//
// Ingestion surface (documented against Cisco's real one, implemented here
// for the standard event shape):
//   Cisco Finesse publishes Interaction / Participant / Queue "webhook"
//   (Cisco Finesse Webhooks, UCCX/CCE event feeds) to an HTTPS endpoint.
//   This adapter receives them at POST /cisco/events and verifies the
//   HMAC-SHA256 signature over the RAW request body (header
//   x-cisco-signature) when CXTRUST_CISCO_SECRET is configured.
//
// Cisco production payload shapes vary by deployment (Finesse webhook vs
// UCCX historical vs CCE extension routing); this adapter validates
// signatures and NORMALIZES the standard shape below into the governance
// event flow. It does not claim to parse every deployment's variant
// natively — a thin translation shim in front of handleEvent() covers
// deployment-specific encodings.
//
// Standard Cisco-style payload:
//   { interactionId, udid, ani, mediaType: 'VOICE'|'CHAT', queue,
//     events: [{ type: 'INTERACTION_STARTED'|'CUSTOMER_DATA'|'AGENT_DATA'
//                  |'PARTICIPANT_CHANGED'|'INTERACTION_END',
//                text?, aiSuspected?, from?, timestamp? }] }
//
// Enforcement: a customer turn (CUSTOMER_DATA) that requests a sensitive
// action (CHANGE_BANK_ACCOUNT / MONEY_TRANSFER / ISSUE_REFUND-style phrases,
// detected like the Genesys/NICE adapters) triggers the session actions
// evaluate endpoint with the customer participant classified UNKNOWN_AI when
// the payload carries an aiSuspected flag or bot metadata (production: real
// voice-trust vendor + agent registry; demo: DemoVoiceAnalyzer maps the flag
// to a synthetic probability).
//
// Routes:
//   GET  /healthz               → { ok, adapter:'cisco', interactions, blocks, ... }
//   POST /cisco/events          → signed webhook receiver (401 on bad signature)
//   POST /cisco/demo            → scripted 2-interaction demo (see src/demo.ts)
//   POST /cisco/action/:id      → pre-action enforcement gate (same pattern as nice/genesys)
//   GET  /cisco/interactions    → live governed interactions

import http from 'node:http';
import crypto from 'node:crypto';
import {
  detectSensitiveAction, runScriptedDemo, DEMO_CISCO_AI_ANI,
  type DemoInteractionProcessor, type DemoSummary,
  type CiscoEvent, type CiscoInteractionPayload,
} from './demo.ts';

const DEFAULT_API_BASE = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
const API_KEY = process.env.CXTRUST_API_KEY;
const PORT = Number(process.env.CXTRUST_CISCO_PORT ?? 8804);
const ORG = process.env.CXTRUST_ORG ?? 'org-demo';

export type { DemoInteractionProcessor, DemoSummary, CiscoEvent, CiscoInteractionPayload };
export { detectSensitiveAction, runScriptedDemo, CISCO_SCRIPTED_INTERACTIONS, DEMO_CISCO_BENIGN_ANI, DEMO_CISCO_AI_ANI } from './demo.ts';

/** Voice analysis provider seam (same shape as the nice/genesys/twilio adapters). */
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
    const suspect = input.aiSuspected === true || input.ani === DEMO_CISCO_AI_ANI;
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
 * Verify the x-cisco-signature header against the RAW body bytes.
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

export interface CiscoInteractionState {
  interactionId: string; // governance id, INT-CISCO-<ciscoInteractionId>
  ciscoInteractionId: string;
  scenario: string;
  udid?: string;
  ani?: string;
  queue?: string;
  mediaType: 'VOICE' | 'CHAT';
  aiSuspected: boolean;
  eventsProcessed: number;
  violations: { decision: Record<string, unknown> }[];
  startedAt: string;
}

export class CiscoFinesseConnector implements DemoInteractionProcessor {
  readonly id = 'cisco-finesse';
  readonly platform = 'cisco-finesse';
  private interactions = new Map<string, CiscoInteractionState>();
  private voice: VoiceAnalyzer;
  /** cumulative counters for /healthz */
  private interactionsTotal = 0;
  private blocksTotal = 0;
  /** true while CXTRUST_CISCO_SECRET is unset and webhooks are being accepted unsigned */
  private configDegraded = false;
  /** In-memory HMAC secret set via POST /cisco/configure (overrides env). */
  private configuredSecret?: string;
  private configuredAt?: string;

  constructor(opts: { voice?: VoiceAnalyzer } = {}) {
    this.voice = opts.voice ?? new DemoVoiceAnalyzer();
  }

  /** Connector-shaped adapter surface: no handshake — Cisco webhook subscriptions are configured out-of-band in the Finesse/UCCX admin. */
  async register(): Promise<void> { /* webhook receiver is passive; nothing to negotiate */ }

  get activeCount() { return this.interactions.size; }

  /** Effective HMAC secret: UI-configured (in-memory) takes precedence over env. */
  private get secret(): string { return this.configuredSecret ?? process.env.CXTRUST_CISCO_SECRET ?? ''; }

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
      webhookPath: '/cisco/events',
      webhookUrl: publicHost ? `https://${publicHost.replace(/\/$/, '')}/cisco/events` : null,
      signatureHeader: 'x-cisco-signature',
      note: 'Point the Cisco event subscription at this URL; sign deliveries with hex(HMAC-SHA256(secret, rawBody)).',
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
  getInteraction(ciscoInteractionId: string) { return this.interactions.get(ciscoInteractionId); }
  health() {
    return {
      ok: true as const,
      adapter: 'cisco',
      interactions: this.interactionsTotal,
      blocks: this.blocksTotal,
      active: this.interactions.size,
      config: {
        signatureVerification: !!process.env.CXTRUST_CISCO_SECRET,
        degraded: this.configDegraded,
      },
    };
  }

  /** Create (once) the governed interaction + customer participant for a Cisco payload. */
  private async ensureSession(payload: CiscoInteractionPayload, scenario: string): Promise<CiscoInteractionState> {
    const existing = this.interactions.get(payload.interactionId);
    if (existing) return existing;
    if (!payload.interactionId) throw new Error('cisco payload requires interactionId');
    const aiSuspected = payload.events.some(e => e.type === 'CUSTOMER_DATA' && e.aiSuspected === true)
      || payload.metadata?.bot === true
      || typeof payload.metadata?.botId === 'string';
    const interactionId = `INT-CISCO-${payload.interactionId}`;
    await api('POST', '/v1/interactions', {
      organizationId: ORG,
      platform: 'cisco-finesse',
      channel: payload.mediaType === 'CHAT' ? 'chat' : 'voice',
      interactionId,
      metadata: {
        ciscoInteractionId: payload.interactionId,
        udid: payload.udid,
        ani: payload.ani,
        queue: payload.queue,
        mediaType: payload.mediaType,
        scenario,
      },
    });
    // The Cisco-side AI-suspicion signal (payload flag / bot metadata) sets the
    // participant classification up front; production plugs a real agent
    // registry + voice-trust vendor behind the same seam.
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
    const state: CiscoInteractionState = {
      interactionId, ciscoInteractionId: payload.interactionId, scenario,
      udid: payload.udid, ani: payload.ani, queue: payload.queue,
      mediaType: payload.mediaType, aiSuspected,
      eventsProcessed: 0, violations: [], startedAt: new Date().toISOString(),
    };
    this.interactions.set(payload.interactionId, state);
    this.interactionsTotal += 1;
    return state;
  }

  /**
   * Pump normalized events into governance: turns append, sensitive customer
   * requests evaluate, INTERACTION_END closes. Returns true when the batch
   * carried an end event (the session was ended and dropped from live state).
   */
  private async pumpEvents(state: CiscoInteractionState, payload: CiscoInteractionPayload): Promise<boolean> {
    const base = payload.events.length && payload.events[0].timestamp ? Date.parse(payload.events[0].timestamp) : NaN;
    let sawEnd = false;
    for (let i = 0; i < payload.events.length; i++) {
      const ev = payload.events[i];
      const raw = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      const offsetS = Number.isFinite(raw) && Number.isFinite(base) ? Math.max(0, Math.round((raw - base) / 1000)) : i * 2;
      if (ev.type === 'CUSTOMER_DATA' && typeof ev.text === 'string') {
        await api('POST', `/v1/interactions/${state.interactionId}/turns`, { participantId: 'customer', text: ev.text, offsetS });
        const action = detectSensitiveAction(ev.text);
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
      } else if (ev.type === 'AGENT_DATA' && typeof ev.text === 'string') {
        await api('POST', `/v1/interactions/${state.interactionId}/turns`, { participantId: 'agent', text: ev.text, offsetS });
      } else if (ev.type === 'INTERACTION_STARTED' || ev.type === 'PARTICIPANT_CHANGED') {
        // start/participant-state (Finesse bar) metadata is captured on the
        // interaction record; no turn
      } else if (ev.type === 'INTERACTION_END') {
        sawEnd = true;
      }
      state.eventsProcessed += 1;
    }
    return sawEnd;
  }

  /** Full episode: normalize a Cisco payload into create/append/evaluate/end calls. */
  async processInteraction(payload: CiscoInteractionPayload, scenario = 'webhook'): Promise<DemoSummary> {
    const state = await this.ensureSession(payload, scenario);
    const sawEnd = await this.pumpEvents(state, payload);
    const snap = await api('GET', `/v1/interactions/${state.interactionId}`).catch(() => ({}) as Record<string, unknown>);
    const customer = (snap as { participants?: { participantId: string; classification: string }[] })
      .participants?.find(p => p.participantId === 'customer');
    const risk = Number((snap as { risk?: { overall?: number } }).risk?.overall ?? 0);
    if (sawEnd) await this.endInteraction(payload.interactionId);
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

  /** Handle one normalized Cisco event payload (single episode batch). */
  async handleEvent(payload: CiscoInteractionPayload): Promise<DemoSummary> {
    return this.processInteraction(payload, 'webhook');
  }

  async endInteraction(ciscoInteractionId: string) {
    const state = this.interactions.get(ciscoInteractionId);
    if (!state) return { ignored: true };
    await api('POST', `/v1/interactions/${state.interactionId}/end`).catch(() => {});
    this.interactions.delete(ciscoInteractionId);
    return { ended: true };
  }

  /** Enforcement gate — call before executing a customer-risky action (mirrors nice/genesys checkAction). */
  async checkAction(ciscoInteractionId: string, action: { requestedAction: string; amount?: number; intent?: string }): Promise<Record<string, unknown>> {
    const state = this.interactions.get(ciscoInteractionId);
    if (!state) return { allowed: false, reason: 'no governed session for this interactionId' };
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
      console.log(`cisco-finesse connector listening :${port} · api ${API_BASE} · webhook /cisco/events · hmac ${process.env.CXTRUST_CISCO_SECRET ? 'on' : 'OFF (degraded)'}`);
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
      if (req.method === 'POST' && url.pathname === '/cisco/configure') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { secret?: string; publicHost?: string };
        const result = this.configure({ secret: String(body.secret ?? ''), publicHost: body.publicHost });
        return json(result.ok ? 200 : 400, result);
      }
      if (req.method === 'GET' && url.pathname === '/cisco/configure/status') {
        return json(200, this.configureStatus());
      }
      if (req.method === 'POST' && url.pathname === '/cisco/events') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks);
        const secret = this.secret;
        if (secret) {
          if (!verifySignature(raw, req.headers['x-cisco-signature'] as string | undefined, secret)) {
            return json(401, { error: 'invalid or missing x-cisco-signature' });
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
          if (!p || typeof (p as CiscoInteractionPayload).interactionId !== 'string'
            || !Array.isArray((p as CiscoInteractionPayload).events)) {
            return json(400, { error: 'expected { interactionId, mediaType, events:[...] } (or array thereof)' });
          }
        }
        const results = [];
        for (const p of list) results.push(await this.handleEvent(p as CiscoInteractionPayload));
        return json(200, {
          accepted: true,
          ...(secret ? {} : { config: { degraded: true, reason: 'CXTRUST_CISCO_SECRET unset — signatures not verified' } }),
          results,
        });
      }
      if (req.method === 'POST' && url.pathname === '/cisco/demo') {
        const summaries = await this.runDemo();
        return json(200, {
          adapter: 'cisco',
          demo: true,
          apiBase: API_BASE,
          interactions: summaries,
          blocks: this.blocksTotal,
        });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/cisco/action/')) {
        const ciscoInteractionId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* keep empty */ }
        const result = await this.checkAction(ciscoInteractionId, {
          requestedAction: String(body.requestedAction ?? ''),
          amount: body.amount !== undefined ? Number(body.amount) : undefined,
          intent: body.intent !== undefined ? String(body.intent) : undefined,
        });
        return json(200, result);
      }
      if (req.method === 'GET' && url.pathname === '/cisco/interactions') {
        // `active` mirrors `interactions` so the web connectors page probe
        // (calls ?? streams ?? active) renders live rows like nice does.
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
  const connector = new CiscoFinesseConnector();
  connector.listen();
}

if (process.argv[1] && process.argv[1].endsWith('index.ts')) main();
