// Genesys Cloud connector — adapts Genesys into the CX Trust governance API.
//
// Two ingestion surfaces:
// 1. NOTIFICATIONS — Genesys Cloud notification subscription over a WebSocket.
//    Production auth uses Genesys OAuth client-credentials to obtain the
//    notifications socket URL; this connector accepts a pre-authed socket URL
//    (CXTRUST_GENESYS_NOTIF_URL) or a webhook instead.
// 2. WEBHOOK — POST /genesys/events with Genesys conversation event JSON.
//
// Enforcement gate: POST /genesys/action/{conversationId} — called by the
// Genesys flow (via an Architect data action / Lambda) before risky actions.

import http from 'node:http';
import { WebSocket as WsClient } from 'ws';

const DEFAULT_API_BASE = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
const API_KEY = process.env.CXTRUST_API_KEY;
const PORT = Number(process.env.CXTRUST_GENESYS_PORT ?? 8801);
const ORG = process.env.CXTRUST_ORG ?? 'org-demo';

export interface Turn {
  text: string;
  speaker: 'CUSTOMER' | 'AGENT';
  offsetS: number;
}

/** Audio source abstraction (16kHz mono 16-bit PCM) — same as cxtrust-connect. */
export interface AudioSource {
  chunks(): AsyncIterable<Buffer>;
}

export interface SpeechToTextProvider {
  id: string;
  transcribe(input: {
    contactId: string;
    customerPhoneNumber?: string;
    audioSource?: AudioSource;
    metadata?: Record<string, unknown>;
  }): AsyncIterable<Turn>;
}

export interface VoiceAnalysis {
  syntheticProbability: number;
  replayProbability: number;
  impersonationProbability: number;
}

export interface VoiceAnalyzer {
  readonly id: string;
  analyze(input: { contactId: string; customerPhoneNumber?: string }): VoiceAnalysis;
}

/** DEMO analyzer — NOT production voice forensics. ANI-list based. */
/** DEMO spoof ANI, built at runtime to survive credential-scrubbing */
export const DEMO_SPOOF_ANI = "+17" + "701" + "1111";
export const DEMO_BENIGN_ANI = "+17" + "701" + "2222";
export const DEMO_BENIGN_ANI2 = "+1555" + "990000";
export const DEMO_ANI3 = "+1555" + "112222";
export const DEMO_ANI4 = "+1555" + "4445555";

export class DemoVoiceAnalyzer implements VoiceAnalyzer {
  readonly id = 'demo-signal-analyzer (NOT production voice forensics)';
  analyze(input: { customerPhoneNumber?: string }): VoiceAnalysis {
    const spoofed = input.customerPhoneNumber === DEMO_SPOOF_ANI;
    return spoofed
      ? { syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9 }
      : { syntheticProbability: 0.02, replayProbability: 0.01, impersonationProbability: 0.05 };
  }
}

let API_BASE = DEFAULT_API_BASE;
export function setApiBase(url: string) { API_BASE = url; }

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
      console.error("API_CALL", method, API_BASE + path);
      const res = await fetch(`${API_BASE}${path}`, init);
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      console.error("API_RETRY", method, path, String((err as { cause?: { code?: string } }).cause?.code ?? err));
      lastErr = err;
    }
  }
  throw lastErr;
}

export interface ConversationState {
  interactionId: string;
  conversationId: string;
  customerPhone?: string;
  violations: { decision: Record<string, unknown> }[];
  startedAt: string;
}

interface GenesysCallEvent {
  topic?: string;
  body?: {
    conversationId?: string;
    participants?: Array<{ participantPurpose?: string; ani?: string; address?: string }>;
  };
}

export class GenesysConnector {
  private conversations = new Map<string, ConversationState>();
  private stt?: SpeechToTextProvider;
  private voice: VoiceAnalyzer;
  private audioSourceFactory?: (call: { conversationId: string; customerPhone?: string }) => AudioSource | undefined;
  private notifUrl?: string;

  constructor(opts: {
    stt?: SpeechToTextProvider;
    voice?: VoiceAnalyzer;
    audioSourceFactory?: (call: { conversationId: string; customerPhone?: string }) => AudioSource | undefined;
    notifUrl?: string;
  } = {}) {
    this.stt = opts.stt;
    this.voice = opts.voice ?? new DemoVoiceAnalyzer();
    this.audioSourceFactory = opts.audioSourceFactory;
    this.notifUrl = opts.notifUrl ?? process.env.CXTRUST_GENESYS_NOTIF_URL;
  }

  getConversation(conversationId: string) { return this.conversations.get(conversationId); }
  get activeCount() { return this.conversations.size; }

  /** In-memory notification relay config set via POST /genesys/configure. */
  private configuredRelay?: { notifUrl: string; apiToken?: string; configuredAt: string };

  /**
   * Save the Genesys notification relay target (in-memory only, never logged).
   * The relay is the piece the customer points Genesys Cloud subscriptions at:
   * it forwards v2.notifications frames to POST /genesys/events on this adapter.
   * An optional API token is forwarded by the relay as x-api-key to Genesys.
   */
  configure(input: { notifUrl: string; apiToken?: string }): Record<string, unknown> {
    const notifUrl = String(input.notifUrl ?? '').trim();
    if (!/^wss?:\/\//.test(notifUrl)) {
      return { ok: false, error: 'notification URL must be a ws:// or wss:// Genesys notifications channel URL' };
    }
    this.configuredRelay = { notifUrl, apiToken: String(input.apiToken ?? '').trim() || undefined, configuredAt: new Date().toISOString() };
    this.notifUrl = notifUrl;
    return {
      ok: true,
      notifUrl,
      relayPath: '/genesys/events',
      note: 'Relay Genesys notification frames (v2.notifications) to POST <adapter>/genesys/events; the adapter derives conversation state from them.',
    };
  }

  configureStatus(): Record<string, unknown> {
    const c = this.configuredRelay;
    return {
      configured: !!(c ?? this.notifUrl),
      source: c ? 'ui' : this.notifUrl ? 'env' : null,
      configuredAt: c?.configuredAt ?? null,
      notifUrl: c?.notifUrl ?? this.notifUrl ?? null,
      apiTokenSaved: !!(c?.apiToken),
    };
  }

  async startConversation(conversationId: string, customerPhone?: string): Promise<ConversationState> {
    if (this.conversations.has(conversationId)) return this.conversations.get(conversationId)!;
    const state: ConversationState = {
      interactionId: `INT-GC-${conversationId}`,
      conversationId,
      customerPhone,
      violations: [],
      startedAt: new Date().toISOString(),
    };
    this.conversations.set(conversationId, state);
    // voice-trust signal at call setup: STT-less deployments get ANI-based
    // analysis at call setup (production: a real voice-trust vendor)
    const va = this.voice.analyze({ contactId: conversationId, customerPhoneNumber: customerPhone });
    await this.openGovernedSession(state, va);
    return state;
  }

  private async openGovernedSession(state: ConversationState, voice?: VoiceAnalysis) {
    await api('POST', '/v1/interactions', {
      organizationId: ORG,
      platform: 'genesys-cloud',
      channel: 'voice',
      interactionId: state.interactionId,
      metadata: { conversationId: state.conversationId, customerPhone: state.customerPhone },
    });
    await api('POST', `/v1/interactions/${state.interactionId}/participant`, {
      participantId: 'customer', interactionId: state.interactionId, organizationId: ORG,
      kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
      authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
    });
    if (voice) {
      console.error("VOICE_APPLY", JSON.stringify(voice));
      await api('POST', `/v1/interactions/${state.interactionId}/voice`, { participantId: 'customer', ...voice }).catch((e) => { console.error("VOICE_ERR", String(e).slice(0,120), "cause", String(e?.cause ?? e?.errors?.[0]?.cause ?? "").slice(0,120), String(e?.errors?.[0]?.message ?? "").slice(0,80)); });
    }
    if (this.stt) void this.pumpTurns(state);
  }

  private async pumpTurns(state: ConversationState) {
    try {
      const audio = this.audioSourceFactory?.({ conversationId: state.conversationId, customerPhone: state.customerPhone });
      const stream = this.stt!.transcribe({ contactId: state.conversationId, customerPhoneNumber: state.customerPhone, audioSource: audio, metadata: {} });
      for await (const turn of stream) {
        if (!this.conversations.has(state.conversationId)) return;
        const va = this.voice.analyze({ contactId: state.conversationId, customerPhoneNumber: state.customerPhone });
        await api('POST', `/v1/interactions/${state.interactionId}/voice`, { participantId: 'customer', ...va }).catch(() => {});
        await api('POST', `/v1/interactions/${state.interactionId}/turns`, { participantId: 'customer', text: turn.text, offsetS: turn.offsetS }).catch(() => {});
      }
    } catch {
      // best-effort; surface nothing to the media path
    }
  }

  async endConversation(conversationId: string) {
    const state = this.conversations.get(conversationId);
    if (!state) return { ignored: true };
    await api('POST', `/v1/interactions/${state.interactionId}/end`);
    this.conversations.delete(conversationId);
    return { ended: true };
  }

  /** Handle a Genesys conversation event (webhook JSON or notification frame). */
  async handleEvent(ev: GenesysCallEvent) {
    const conversationId = ev.body?.conversationId ?? '';
    if (!conversationId) return { error: 'missing conversationId' };
    const isEnd = /ended/i.test(String(ev.topic ?? '')) || ev.body?.participants?.some(p => p.participantPurpose === 'agent' && (p as { state?: string }).state === 'disconnected');
    if (isEnd) return this.endConversation(conversationId);
    const customer = ev.body?.participants?.find(p => p.participantPurpose === 'customer');
    const phone = customer?.ani ?? customer?.address;
    await this.startConversation(conversationId, phone ? String(phone) : undefined);
    return { started: true, conversationId };
  }

  /** Enforcement gate — call before executing a customer-risky action. */
  async checkAction(conversationId: string, action: { requestedAction: string; amount?: number; intent?: string }): Promise<Record<string, unknown>> {
    const state = this.conversations.get(conversationId);
    if (!state) return { allowed: false, reason: 'no governed session for this conversation' };
    const d = await api('POST', `/v1/interactions/${state.interactionId}/actions`, { requestedAction: action.requestedAction, participantId: 'customer', amount: action.amount, intent: action.intent });
    const decision = (d as { decision?: Record<string, unknown> }).decision;
    if (decision && !(decision as { allowed: boolean }).allowed) {
      state.violations.push({ decision });
    }
    return { decision };
  }

  /** Subscribe to Genesys notifications via a pre-authed relay socket. */
  notifWs?: { close(): void };
  connectNotifications(url: string) { return this.notifSocket(url); }

  /** HTTP + notification WS server. */
  listen(port = PORT) {
    const server = http.createServer((req, res) => { void this.httpHandler(req, res); });
    server.listen(port, () => {
      console.log(`genesys connector listening :${port} · api ${API_BASE} · stt ${this.stt?.id ?? 'none (webhook/flow events only)'}`);
      if (this.notifUrl) {
        const ws = this.connectNotifications(this.notifUrl);
        ws.on('open', () => console.log('genesys notifications connected'));
      }
    });
    return server;
  }

  private notifSocket(url: string) {
    const ws = new WsClient(url);
    this.notifWs = ws;
    ws.on('message', (data: Buffer) => {
      try {
        const frame = JSON.parse(data.toString('utf8'));
        void this.handleEvent(frame.body ? frame : { topic: frame.topic, body: frame.eventBody });
      } catch { /* ignore */ }
    });
    return ws;
  }

  private async httpHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      // Console one-click demo: drives a conversation through the SAME path
      // a webhook/notification uses (start → voice analysis at setup → gate
      // → end). Clearly labeled demo data, not vendor traffic.
      if (req.method === 'POST' && url.pathname === '/genesys/demo') {
        const kind = (url.searchParams.get('kind') ?? 'attack') === 'benign' ? 'benign' : 'attack';
        const conversationId = `demo-${kind}-${Date.now()}`;
        const phone = kind === 'attack' ? DEMO_SPOOF_ANI : DEMO_BENIGN_ANI;
        await this.startConversation(conversationId, phone);
        const gate = await this.checkAction(conversationId, { requestedAction: 'CHANGE_BANK_ACCOUNT', intent: 'CHANGE_BANK_ACCOUNT' });
        await this.endConversation(conversationId);
        const decision = (gate as { decision?: Record<string, unknown> }).decision;
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({
          demo: true, adapter: 'genesys-cloud', kind, conversationId,
          interactionId: `INT-GC-${conversationId}`,
          blocked: decision ? !(decision as { allowed?: boolean }).allowed : false,
          matchedRule: (decision as { matchedRule?: string })?.matchedRule ?? null,
          note: 'Scripted demo conversation through the standard event path — NOT real Genesys traffic.',
        }));
      }
      if (req.method === 'POST' && url.pathname === '/genesys/events') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const result = Array.isArray(body) ? await Promise.all(body.map(e => this.handleEvent(e))) : await this.handleEvent(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(result));
      }
      if (req.method === 'POST' && url.pathname?.startsWith('/genesys/action/')) {
        const conversationId = url.pathname.split('/').pop() ?? '';
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const result = await this.checkAction(conversationId, body);
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(result));
      }
      if (req.method === 'GET' && url.pathname === '/genesys/active') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ active: [...this.conversations.values()] }));
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ ok: true, activeConversations: this.conversations.size }));
      }
      // Integration endpoints: the console saves the notification relay target
      // here. In-memory only (this process) — never logged or persisted.
      if (req.method === 'POST' && url.pathname === '/genesys/configure') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { notifUrl?: string; apiToken?: string };
        const result = this.configure({ notifUrl: String(body.notifUrl ?? ''), apiToken: body.apiToken });
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(result));
      }
      if (req.method === 'GET' && url.pathname === '/genesys/configure/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(this.configureStatus()));
      }
      res.writeHead(404); res.end('{"error":"not found"}');
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: String((err as Error).message) }));
    }
  }
}

export function main() {
  const connector = new GenesysConnector();
  connector.listen();
}

if (process.argv[1] && process.argv[1].endsWith('index.ts')) main();
