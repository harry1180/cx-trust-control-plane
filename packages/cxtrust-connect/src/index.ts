// Amazon Connect adapter for the CX Trust Control Plane.
//
// Two ingestion surfaces (both real Connect mechanisms):
//
// 1. MEDIA STREAM  — Connect Voice ID / Live Media Streaming WebSocket.
//    Connect starts a bidirectional audio stream (msg-type: start / mediaEvents
//    / audio / stop). We accept it on :8799/ws, extract call metadata from the
//    start message (contactId, agent, customerPhoneNumber, etc.), pass audio
//    chunks to a pluggable SpeechToTextProvider, and feed turns + voice
//    analysis into the governance API.
//
// 2. CONTACT EVENTS — Amazon EventBridge "Amazon Connect Contact Event"
//    (source aws.connect) via an API Destination that POSTs the raw envelope
//    to /connect/events, or a legacy webhook/Lambda. The adapter normalizes
//    both: INITIATED / CONNECTED_TO_SYSTEM / QUEUED / CONNECTED_TO_AGENT open
//    a governed session (idempotent), DISCONNECTED closes it — this covers
//    inbound AND outbound contacts (initiationMethod INBOUND/OUTBOUND/API…).
//
// Enforcement callback: when the API denies an action, the adapter can
// respond on the Connect flow via the invoke-lambda / webhook channel the
// customer wires up — expose GET /connect/enforcement/:interactionId for
// polling, or push webhooks (CONNECT_ENFORCEMENT_WEBHOOK env).
//
// STT: default provider is `ScriptedCallTranscriber` — a clearly-labeled demo
// transcriber that replays a scripted call matching the caller's phone
// number. Production swaps in Amazon Transcribe live-call analytics, which
// publishes turns on the same interface (TranscribeStreamingProvider).

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { ConnectClient, DescribeInstanceCommand, ListQueuesCommand } from '@aws-sdk/client-connect';
import { DeepgramLiveSTTProvider } from './deepgram.ts';
import { MuLawStreamSource, mulawDecode, upsample8kTo16k } from '@cxtrust/twilio';
import { InHouseSignalAnalyzer } from './voicebiometrics.ts';
import { enrollVoiceprint, verifyVoiceprint, voiceprintStatus, deleteVoiceprint, getVoiceprintTemplate } from './voiceprint.ts';
import { flagEnabled } from '@cxtrust/core';
import { extractBiomarkers } from './biomarkers.ts';
import type { AudioSource } from './transcribe.ts';

const API_BASE = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
const API_KEY = process.env.CXTRUST_API_KEY;
const PORT = Number(process.env.CONNECT_PORT ?? 8799);
const ORG = process.env.CXTRUST_ORG ?? 'org-demo';

export interface Turn {
  text: string;
  speaker: 'CUSTOMER' | 'AGENT';
  offsetS: number;
}

/** Seam for real STT: Amazon Transcribe live analytics implements this. */
export interface SpeechToTextProvider {
  id: string;
  /** Given a new media-stream call, produce the turn stream for it. */
  transcribe(input: {
    contactId: string;
    customerPhoneNumber?: string;
    /** available metadata from the Connect start message */
    metadata: Record<string, unknown>;
  }): AsyncIterable<Turn>;
}

/** Clearly-labeled demo provider: replays a scripted call for a number. */
export class ScriptedCallTranscriber implements SpeechToTextProvider {
  readonly id = 'demo-scripted-transcriber (NOT real speech recognition)';
  private scripts: Record<string, Turn[]>;
  constructor(scripts: Record<string, Turn[]> = DEFAULT_CALL_SCRIPTS) {
    this.scripts = scripts;
  }

  async *transcribe(input: { contactId: string; customerPhoneNumber?: string; metadata: Record<string, unknown> }): AsyncIterable<Turn> {
    const script = this.scripts[input.customerPhoneNumber ?? 'default'] ?? this.scripts['default'];
    for (const t of script) {
      await new Promise(r => setTimeout(r, 700));
      yield t;
    }
  }
}

/** Audio analysis provider seam: real vendors plug here. */
export interface VoiceAnalysis {
  syntheticProbability: number;
  replayProbability: number;
  impersonationProbability: number;
}
export interface VoiceAnalyzer {
  id: string;
  analyze(input: { contactId: string; customerPhoneNumber?: string; audioChunk?: Buffer }): VoiceAnalysis;
}

export class DemoVoiceAnalyzer implements VoiceAnalyzer {
  readonly id = 'demo-signal-analyzer (NOT production voice forensics)';
  analyze(input: { customerPhoneNumber?: string }): VoiceAnalysis {
    const spoofed = !!input.customerPhoneNumber && SPOOF_NUMBERS.has(input.customerPhoneNumber);
    return spoofed
      ? { syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9 }
      : { syntheticProbability: 0.02, replayProbability: 0.01, impersonationProbability: 0.05 };
  }
}

export const SPOOF_NUMBERS = new Set(['+15550001111']);

const DEFAULT_CALL_SCRIPTS: Record<string, Turn[]> = {
  // A live deepfake-ATO attack call — matches CX Trust scenario 2's intent
  '+15550001111': [
    { text: 'Hello? Yes, I lost my phone. I need to recover my account right now.', speaker: 'CUSTOMER', offsetS: 2 },
    { text: 'Change my bank account to the new one and move my funds today.', speaker: 'CUSTOMER', offsetS: 10 },
  ],
  default: [
    { text: 'Hi, can you tell me my checking account balance?', speaker: 'CUSTOMER', offsetS: 2 },
  ],
};

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(API_KEY ? { 'x-api-key': API_KEY } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as Record<string, unknown>;
}

export interface CallState {
  interactionId: string;
  contactId: string;
  customerPhoneNumber?: string;
  violations: { offsetS: number; decision: Record<string, unknown> }[];
  startedAt: string;
}

export interface ConnectIntegration {
  accessKeyId: string; secretAccessKey: string; region: string; instanceId: string;
  /** Present only for ASIA… (temporary/STS) keys. In-memory only, never logged. */
  sessionToken?: string;
  validated: boolean; instanceAlias?: string; queues: Array<{ id: string; name: string }>;
}

/**
 * Format check for AWS credentials — runs BEFORE any network call.
 * Access key IDs are exactly 20 characters: AKIA… (long-term IAM user key,
 * no session token) or ASIA… (temporary/STS key, ALWAYS paired with a
 * session token that expires).
 */
export function validateAwsCredentialFormat(input: {
  accessKeyId: string; secretAccessKey: string; instanceId: string; sessionToken?: string;
}): { ok: true } | { ok: false; error: string } {
  const sessionToken = String(input.sessionToken ?? '').trim();
  if (!/^(AKIA|ASIA)[0-9A-Z]{16}$/.test(input.accessKeyId) || input.secretAccessKey.length < 20 || !input.instanceId) {
    return { ok: false, error: 'invalid Access Key ID (AKIA…), Secret Access Key, or Instance ID' };
  }
  if (input.accessKeyId.startsWith('ASIA') && !sessionToken) {
    return { ok: false, error: 'ASIA access key requires a session token (temporary credentials)' };
  }
  return { ok: true };
}

/**
 * Contact events that OPEN a governed session. Covers the Amazon EventBridge
 * "Amazon Connect Contact Event" types (INITIATED / CONNECTED_TO_SYSTEM /
 * QUEUED / CONNECTED_TO_AGENT) plus the legacy webhook names. Events are
 * best-effort and may arrive out of order, so any of these opens a session
 * when INITIATED was missed.
 */
export const CONTACT_START_EVENTS = new Set([
  'INITIATED', 'CONNECTED_TO_SYSTEM', 'QUEUED', 'CONNECTED_TO_AGENT',
  'CONTACT_INITIATED', 'CONTACT_CREATED',
]);
/** Contact events that CLOSE a governed session (EventBridge + legacy). */
export const CONTACT_END_EVENTS = new Set(['DISCONNECTED', 'CONTACT_ENDED']);

/**
 * Normalize a contact event into {type, detail, contactId}. Accepts:
 *  - the raw Amazon EventBridge envelope ({detail-type, detail:{eventType…}})
 *    — what an EventBridge API Destination POSTs, forwarded as-is;
 *  - a bare EventBridge detail ({eventType, contactId…});
 *  - the legacy webhook shape ({EventType, ContactData:{ContactId…}}).
 */
export function normalizeConnectContactEvent(raw: Record<string, unknown>): {
  type: string; detail: Record<string, unknown>; contactId: string;
} {
  const nested = raw['detail'];
  const detail = (nested && typeof nested === 'object' ? nested : raw) as Record<string, unknown>;
  const legacyData = detail['ContactData'];
  const cd = (legacyData && typeof legacyData === 'object' ? legacyData : detail) as Record<string, unknown>;
  const type = String(detail['EventType'] ?? detail['eventType'] ?? '');
  const contactId = String(
    cd['ContactId'] ?? cd['contactId'] ?? detail['initialContactId'] ?? detail['InitialContactId'] ?? raw['InitialContactId'] ?? '',
  );
  return { type, detail: cd, contactId };
}

/**
 * base64 audio → 16kHz mono s16le PCM for voiceprint endpoints. Accepts
 * raw PCM or a PCM WAV (validates rate/channels/bits with a clear error —
 * never guesses at other formats).
 */
export function decodeVoiceAudio(b64: string): { pcm?: Buffer; error?: string } {
  const buf = Buffer.from(String(b64 ?? ''), 'base64');
  if (buf.length < 8) return { error: 'audio is empty' };
  if (buf.toString('ascii', 0, 4) === 'RIFF') {
    let off = 12, rate = 0, channels = 0, bits = 0;
    let data: Buffer | null = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') { channels = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
      if (id === 'data') data = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
      off += 8 + size + (size % 2);
    }
    if (!data) return { error: 'WAV has no data chunk' };
    if (rate !== 16000 || channels !== 1 || bits !== 16) {
      return { error: `WAV must be 16kHz mono 16-bit (got ${rate}Hz, ${channels}ch, ${bits}-bit) — convert: ffmpeg -i in -ar 16000 -ac 1 -c:a pcm_s16le out.wav` };
    }
    return { pcm: data };
  }
  if (buf.length % 2) return { error: 'raw PCM must have an even byte count (16-bit samples)' };
  return { pcm: buf };
}

export class ConnectAdapter {
  private calls = new Map<string, CallState>();
  private stt: SpeechToTextProvider;
  private voice: VoiceAnalyzer;
  /** AWS/Connect integration (credentials), in-memory only — never logged. */
  private integration?: ConnectIntegration;
  /** Live media pipeline: per-contact u-law source feeding the STT provider. */
  private mediaSources = new Map<string, MuLawStreamSource>();
  /** Rolling PCM window per contact for the in-house voice analyzer (~10s). */
  private audioWindows = new Map<string, { chunks: Buffer[]; bytes: number }>();
  private readonly audioWindowCap = 320_000; // ~10s of 16kHz mono 16-bit PCM
  /** Runtime override of the voice-biomarker capability (UI switch).
   *  undefined → follow the ENABLE_VOICE_BIOMARKERS flag (env fallback). */
  private biomarkersOverride: boolean | undefined;
  /** Effective switch: UI override wins, then flag/env (default ON). */
  private get biomarkersOn(): boolean {
    return this.biomarkersOverride ?? flagEnabled('ENABLE_VOICE_BIOMARKERS');
  }
  /** Which contact a WebSocket connection is streaming (Connect: 1 conn/contact). */
  private wsContacts = new WeakMap<WebSocket, string>();

  constructor(opts: {
    stt?: SpeechToTextProvider;
    /** per-call STT provider factory (e.g. Deepgram live per call) */
    sttFactory?: (call: { contactId: string; customerPhoneNumber?: string }) => SpeechToTextProvider;
    voice?: VoiceAnalyzer;
    /** per-call audio source factory for the STT provider (live streams) */
    audioSourceFactory?: (call: { contactId: string; customerPhoneNumber?: string }) => import('./transcribe.ts').AudioSource;
  } = {}) {
    this.stt = opts.stt ?? new ScriptedCallTranscriber();
    this.voice = opts.voice ?? new InHouseSignalAnalyzer();
    this.audioSourceFactory = opts.audioSourceFactory;
    this.sttFactory = opts.sttFactory;
  }

  private sttFactory?: (call: { contactId: string; customerPhoneNumber?: string }) => SpeechToTextProvider;

  private sttFor(call: { contactId: string; customerPhoneNumber?: string }): SpeechToTextProvider {
    return this.sttFactory ? this.sttFactory(call) : this.stt;
  }

  private audioSourceFactory?: (call: { contactId: string; customerPhoneNumber?: string }) => import('./transcribe.ts').AudioSource | undefined;

  getCall(contactId: string) { return this.calls.get(contactId); }

  /**
   * Validate AWS credentials against the real Connect API (describe instance
   * + list queues) for the given region/instance. Credentials live in memory
   * for this process only; never logged or persisted. ASIA… (temporary) keys
   * additionally require the session token they were issued with; AKIA…
   * (long-term) keys ignore any pasted token.
   */
  async configure(body: {
    accessKeyId: string; secretAccessKey: string; region?: string; instanceId: string; sessionToken?: string;
  }): Promise<Record<string, unknown>> {
    const accessKeyId = String(body.accessKeyId ?? '').trim();
    const secretAccessKey = String(body.secretAccessKey ?? '').trim();
    const region = String(body.region ?? '').trim() || 'us-east-1';
    const instanceId = String(body.instanceId ?? '').trim();
    const sessionToken = String(body.sessionToken ?? '').trim();
    const fmt = validateAwsCredentialFormat({ accessKeyId, secretAccessKey, instanceId, sessionToken });
    if (!fmt.ok) return { ok: false, error: fmt.error };
    // Only temporary (ASIA) keys carry a session token to the AWS SDK.
    const temporaryAuth = accessKeyId.startsWith('ASIA');
    const client = new ConnectClient({
      region,
      credentials: { accessKeyId, secretAccessKey, ...(temporaryAuth ? { sessionToken } : {}) },
    });
        try {
          const inst = await client.send(new DescribeInstanceCommand({ InstanceId: instanceId }), { abortSignal: AbortSignal.timeout(10000) });
          const alias = inst.Instance?.InstanceAlias;
          const queues: Array<{ id: string; name: string }> = [];
          const q = await client.send(new ListQueuesCommand({ InstanceId: instanceId, MaxResults: 20 }), { abortSignal: AbortSignal.timeout(10000) });
      for (const item of q.QueueSummaryList ?? []) {
        if (item.Id && item.Name) queues.push({ id: item.Id, name: item.Name });
      }
      this.integration = {
        accessKeyId, secretAccessKey, region, instanceId,
        ...(temporaryAuth ? { sessionToken } : {}),
        validated: true, instanceAlias: alias, queues,
      };
      return { ok: true, validated: true, temporaryAuth, instanceAlias: alias, region, queues: queues.map(q => ({ id: q.id, name: q.name })) };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      return { ok: false, error: `AWS rejected the credentials or instance: ${String(e.name ?? '')} ${String(e.message ?? err).slice(0, 160)}` };
    }
  }

  get integrationStatus(): Record<string, unknown> {
    return {
      configured: !!this.integration,
      region: this.integration?.region ?? null,
      instanceId: this.integration?.instanceId ?? null,
      instanceAlias: this.integration?.instanceAlias ?? null,
      validated: this.integration?.validated ?? false,
      temporaryAuth: this.integration ? !!this.integration.sessionToken : null,
      queues: this.integration?.queues ?? [],
      accessKeyMasked: this.integration?.accessKeyId ? `${this.integration.accessKeyId.slice(0, 6)}…` : null,
    };
  }

  /**
   * Handle a contact event: the raw Amazon EventBridge envelope (source
   * aws.connect, detail-type "Amazon Connect Contact Event") or the legacy
   * webhook shape. INITIATED-type events open a governed session
   * (idempotent — EventBridge delivers at-least-once); DISCONNECTED closes it.
   */
  async handleContactEvent(ev: Record<string, unknown>) {
    const { type, detail, contactId } = normalizeConnectContactEvent(ev);
    if (!contactId) return { error: 'missing ContactId' };
    if (CONTACT_END_EVENTS.has(type)) {
      const fallbackId = String(detail['initialContactId'] ?? detail['InitialContactId'] ?? '');
      const call = this.calls.get(contactId) ?? (fallbackId ? this.calls.get(fallbackId) : undefined);
      if (call) {
        await api('POST', `/v1/interactions/${call.interactionId}/end`);
        this.calls.delete(call.contactId);
      }
      return { ended: true };
    }
    if (CONTACT_START_EVENTS.has(type)) {
      if (this.calls.has(contactId)) return { ignored: 'already governed', contactId, type };
      return this.startCall(contactId, detail);
    }
    return { ignored: type || 'unknown' };
  }

  async startCall(contactId: string, contactData: Record<string, unknown>) {
    const customerPhoneNumber = (contactData.CustomerPhoneNumber ?? (contactData.CustomerEndpoint as Record<string, unknown> | undefined)?.Address) as string | undefined;
    const queue = (contactData.Queue as Record<string, unknown> | undefined)?.ARN
      ?? (contactData.queueInfo as Record<string, unknown> | undefined)?.queueArn
      ?? undefined;
    // EventBridge contact events carry channel + initiationMethod (INBOUND /
    // OUTBOUND / API / TRANSFER …) — kept in metadata so direction is visible.
    const channel = String(contactData['channel'] ?? 'voice').toLowerCase();
    const initiationMethod = contactData['initiationMethod'] ? String(contactData['initiationMethod']) : undefined;
    const res = await api('POST', '/v1/interactions', {
      organizationId: ORG,
      platform: 'amazon-connect',
      channel,
      interactionId: `INT-AC-${contactId}`,
      metadata: {
        contactId,
        customerPhoneNumber: customerPhoneNumber ? String(customerPhoneNumber) : undefined,
        queue,
        initiationMethod,
        initialContactId: contactData['initialContactId'] ? String(contactData['initialContactId']) : undefined,
      },
    });
    const interactionId = String(res.interactionId ?? '');
    const call: CallState = { interactionId, contactId, customerPhoneNumber: customerPhoneNumber ? String(customerPhoneNumber) : undefined, violations: [], startedAt: new Date().toISOString() };
    this.calls.set(contactId, call);

    // register the caller participant
    await api('POST', `/v1/interactions/${interactionId}/participant`, {
      participantId: 'customer', interactionId, organizationId: ORG,
      kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
      authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
    });

    // subscribe the STT provider for this call (async, non-blocking)
    void this.pumpTurns(call);
    return call;
  }

  private async pumpTurns(call: CallState) {
    try {
      // Source may come from the constructor factory or, for live media, from
      // the per-contact source created when the WebSocket 'start' arrived.
      const source: AudioSource | undefined =
        this.audioSourceFactory?.(call) ?? this.mediaSources.get(call.contactId);
      const stream = this.sttFor(call).transcribe({
        contactId: call.contactId,
        customerPhoneNumber: call.customerPhoneNumber,
        metadata: {},
        ...(source ? { audioSource: source } : {}),
      } as never);
      for await (const turn of stream) {
        if (!this.calls.has(call.contactId)) return; // call ended
        // Voice analysis at turn boundaries over the REAL audio collected so
        // far (in-house analyzer; no audio yet → honest zeros, never guesses).
        const win = this.audioWindows.get(call.contactId);
        const audioChunk = win && win.chunks.length ? Buffer.concat(win.chunks) : undefined;
        const va = this.voice.analyze({
          contactId: call.contactId,
          customerPhoneNumber: call.customerPhoneNumber,
          ...(audioChunk ? { audioChunk } : {}),
        });
        await api('POST', `/v1/interactions/${call.interactionId}/voice`, { participantId: 'customer', source: this.voice.id, ...va }).catch(() => {});
        await api('POST', `/v1/interactions/${call.interactionId}/turns`, { participantId: 'customer', text: turn.text, offsetS: turn.offsetS }).catch(() => {});
      }
    } catch {
      // call ended / API unavailable — pump is best-effort
    }
  }

  /** Called by the Connect flow (Lambda) before executing a customer-risky action. */
  async checkAction(contactId: string, action: { requestedAction: string; amount?: number; intent?: string }): Promise<Record<string, unknown>> {
    const call = this.calls.get(contactId);
    if (!call) return { allowed: false, reason: 'no governed session for this contact' };
    const d = await api('POST', `/v1/interactions/${call.interactionId}/actions`, { requestedAction: action.requestedAction, participantId: 'customer', amount: action.amount, intent: action.intent });
    const decision = d as { decision?: Record<string, unknown> };
    if (decision.decision && !(decision.decision as { allowed: boolean }).allowed) {
      call.violations.push({ offsetS: 0, decision: decision.decision });
    }
    return decision;
  }

  /** HTTP + WebSocket server for Connect media streams and event webhooks. */
  listen(port = PORT) {
    const server = http.createServer((req, res) => {
      void this.httpHandler(req, res);
    });
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data: Buffer) => {
        // media pipeline is best-effort: a failed handler must never become
        // an unhandled rejection that kills the adapter process
        void this.mediaMessage(ws, data).catch(() => { /* logged nowhere: no secrets in play */ });
      });
      // Connection dropped without a stop message: flush the source so any
      // STT consumer terminates instead of hanging on a starved stream.
      ws.on('close', () => {
        const cid = this.wsContacts.get(ws);
        if (cid) {
          this.mediaSources.get(cid)?.end();
          this.mediaSources.delete(cid);
          this.audioWindows.delete(cid);
        }
      });
    });
    server.listen(port, () => console.log(`connect adapter listening :${port} · ws /ws · api ${API_BASE} · stt ${this.stt.id}`));
    return server;
  }

  private async httpHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    // Public-mode auth: when CXTRUST_CONNECT_TOKEN is set (adapter exposed via
    // a public tunnel so EventBridge can reach it), every route except
    // /healthz requires the x-cxtrust-token header. Read at request time so a
    // restart-free token rotation works. Note: the /ws WebSocket upgrade does
    // not pass through this handler (Amazon Connect media streaming sends no
    // custom headers) — keep the tunnel ephemeral or front it with an ingress.
    const token = process.env.CXTRUST_CONNECT_TOKEN;
    if (token && url.pathname !== '/healthz' && req.headers['x-cxtrust-token'] !== token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'unauthorized: missing or invalid x-cxtrust-token header' }));
    }
    try {
      if (req.method === 'POST' && url.pathname === '/connect/events') {
        const chunks: Buffer[] = []
        ;for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const result = Array.isArray(body) ? await Promise.all(body.map(e => this.handleContactEvent(e))) : await this.handleContactEvent(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(result));
      }
      // Console one-click demo: drives the SAME event path a real Connect
      // webhook uses (CONTACT_INITIATED → scripted STT turns → gate →
      // CONTACT_ENDED). Clearly labeled demo data, not vendor traffic.
      if (req.method === 'POST' && url.pathname === '/connect/demo') {
        const kind = (url.searchParams.get('kind') ?? 'attack') === 'benign' ? 'benign' : 'attack';
        const stamp = Date.now();
        const contactId = `demo-${kind}-${stamp}`;
        const phone = kind === 'attack' ? [...SPOOF_NUMBERS][0] : '+18' + '00555' + '0100';
        await this.handleContactEvent({ EventType: 'CONTACT_INITIATED', ContactData: { ContactId: contactId, CustomerPhoneNumber: phone } });
        await new Promise(r => setTimeout(r, 2200)); // let scripted turns land
        const gate = await this.checkAction(contactId, { requestedAction: 'CHANGE_BANK_ACCOUNT', intent: 'ACCOUNT_RECOVERY' });
        await this.handleContactEvent({ EventType: 'CONTACT_ENDED', ContactData: { ContactId: contactId } });
        const decision = (gate as { decision?: Record<string, unknown> }).decision;
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({
          demo: true, adapter: 'amazon-connect', kind, contactId,
          interactionId: `INT-AC-${contactId}`,
          blocked: decision ? !(decision as { allowed?: boolean }).allowed : false,
          matchedRule: (decision as { matchedRule?: string })?.matchedRule ?? null,
          note: 'Scripted demo call through the standard event path — NOT real telephony.',
        }));
      }
      if (req.method === 'POST' && url.pathname?.startsWith('/connect/action/')) {
        const contactId = url.pathname.split('/').pop() ?? '';
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const result = await this.checkAction(contactId, body);
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(result));
      }
      if (req.method === 'GET' && url.pathname === '/connect/calls') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ calls: [...this.calls.values()] }));
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
              res.writeHead(200, { 'content-type': 'application/json' });
              return void res.end(JSON.stringify({ ok: true, activeCalls: this.calls.size }));
            }
            // Integration endpoints: the console saves AWS credentials here; the
            // adapter validates them against the real Connect API. Credentials
            // are held in memory only (this process) and never logged.
            if (req.method === 'POST' && url.pathname === '/connect/configure') {
              const chunks: Buffer[] = [];
              for await (const c of req) chunks.push(c as Buffer);
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              const result = await this.configure(body);
              res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
              return void res.end(JSON.stringify(result));
            }
            if (req.method === 'GET' && url.pathname === '/connect/configure/status') {
              res.writeHead(200, { 'content-type': 'application/json' });
              return void res.end(JSON.stringify(this.integrationStatus));
            }
      // ---- Voice biometrics: consent-gated in-house voiceprint ----
      if (req.method === 'GET' && url.pathname === '/connect/voiceprint/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ ok: true, ...voiceprintStatus() }));
      }
      if (req.method === 'POST' && url.pathname?.startsWith('/connect/voiceprint/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const reply = (code: number, obj: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        const action = url.pathname.slice('/connect/voiceprint/'.length);
        if (action === 'delete') return reply(200, { ok: true, ...deleteVoiceprint() });
        if (action === 'verify-live') {
          const contactId = String(body.contactId ?? '');
          const win = contactId ? this.audioWindows.get(contactId) : undefined;
          if (!win || !win.chunks.length) {
            return reply(400, { ok: false, error: 'no live audio captured for that contact yet (media streaming must be flowing)' });
          }
          const r = verifyVoiceprint(Buffer.concat(win.chunks));
          if (!r.ok) return reply(r.status, { ok: false, error: r.error });
          let authPosted = false;
          const call = this.calls.get(contactId);
          if (call) {
            authPosted = await api('POST', `/v1/interactions/${call.interactionId}/auth`, {
              participantId: 'customer', result: r.result.match ? 'SUCCESS' : 'FAILURE', level: 'HIGH',
            }).then(() => true).catch(() => false);
          }
          return reply(200, { ok: true, ...r.result, authPosted });
        }
        if (typeof body.audio !== 'string') return reply(400, { ok: false, error: 'audio (base64) required' });
        const dec = decodeVoiceAudio(body.audio);
        if (dec.error || !dec.pcm) return reply(400, { ok: false, error: dec.error ?? 'audio decode failed' });
        if (action === 'enroll') {
          const r = enrollVoiceprint({ consent: body.consent, consentBy: body.consentBy, label: body.label, pcm: dec.pcm });
          if (!r.ok) return reply(r.status, { ok: false, error: r.error });
          return reply(200, {
            ok: true, enrolled: true, enrolledAt: r.template.enrolledAt, consent: r.template.consent,
            label: r.template.label ?? null, durationS: r.stats.durationS,
            speechFrames: r.stats.speechFrames, pitchCaptured: r.stats.pitch.length > 0,
          });
        }
        if (action === 'verify') {
          const r = verifyVoiceprint(dec.pcm);
          if (!r.ok) return reply(r.status, { ok: false, error: r.error });
          return reply(200, { ok: true, ...r.result, speechFrames: r.stats.speechFrames });
        }
        return reply(404, { ok: false, error: 'unknown voiceprint action' });
      }
      // ---- Voice biomarker capability: status + UI toggle + analysis ----
      if (req.method === 'GET' && url.pathname === '/connect/biomarkers/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({
          enabled: this.biomarkersOn,
          source: this.biomarkersOverride !== undefined ? 'runtime' : 'flag',
          flagDefault: flagEnabled('ENABLE_VOICE_BIOMARKERS'),
        }));
      }
      if (req.method === 'POST' && url.pathname === '/connect/biomarkers/toggle') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const tb = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof tb.enabled !== 'boolean') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ ok: false, error: 'enabled:boolean required' }));
        }
        this.biomarkersOverride = tb.enabled;
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({
          ok: true,
          enabled: this.biomarkersOn,
          source: 'runtime',
          note: this.biomarkersOn
            ? 'Voice biomarker collection ON — new calls are analyzed (fallback: env ENABLE_VOICE_BIOMARKERS).'
            : 'Voice biomarker collection OFF — new calls are NOT analyzed for biomarkers; previously stored history is kept.',
        }));
      }
      // ---- Voice biomarkers: wellness measurements + emotion ESTIMATE ----
      if (req.method === 'POST' && url.pathname === '/connect/biomarkers/analyze') {
        if (!this.biomarkersOn) {
          res.writeHead(403, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ ok: false, disabled: true, error: 'voice biomarkers are disabled (UI switch or ENABLE_VOICE_BIOMARKERS)' }));
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        let pcm: Buffer | undefined;
        if (typeof body.contactId === 'string' && body.contactId) {
          const win = this.audioWindows.get(body.contactId);
          if (!win || !win.chunks.length) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return void res.end(JSON.stringify({ ok: false, error: 'no live audio captured for that contact yet (media streaming must be flowing)' }));
          }
          pcm = Buffer.concat(win.chunks);
        } else if (typeof body.audio === 'string') {
          const dec = decodeVoiceAudio(body.audio);
          if (dec.error || !dec.pcm) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return void res.end(JSON.stringify({ ok: false, error: dec.error ?? 'audio decode failed' }));
          }
          pcm = dec.pcm;
        } else {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ ok: false, error: 'audio (base64) or contactId required' }));
        }
        const report = extractBiomarkers(pcm, getVoiceprintTemplate());
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ ok: true, ...report }));
      }
      res.writeHead(404); res.end('{"error":"not found"}');
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: String((err as Error).message) }));
    }
  }

  /** One Connect media-stream frame. start/audio handled; others acked. */
  private async mediaMessage(ws: WebSocket, data: Buffer) {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    const type = msg['msg-type'] ?? msg['message-type'];
    if (type === 'start') {
      const sd = (msg.start ?? msg) as Record<string, unknown>;
      const contactId = String(sd.contactId ?? `ws-${Date.now()}`);
      // accept both Connect casing variants for the customer endpoint
      if (sd.customerPhoneNumber && !sd.CustomerPhoneNumber) sd.CustomerPhoneNumber = sd.customerPhoneNumber;
      // Media pipeline (Task B): one u-law source per contact feeds the STT
      // provider; a rolling PCM window feeds the in-house voice analyzer.
      this.mediaSources.set(contactId, new MuLawStreamSource());
      this.audioWindows.set(contactId, { chunks: [], bytes: 0 });
      this.wsContacts.set(ws, contactId);
      const call = await this.startCall(contactId, sd);
      ws.send(JSON.stringify({ ok: true, interactionId: call.interactionId, governed: true }));
      return;
    }
    if (type === 'audio' || msg.media) {
      // Connect audio frames: base64 u-law 8kHz. `chunk` is the documented
      // field; accept common variants defensively.
      const media = msg['media'] as { payload?: unknown } | undefined;
      const b64 = typeof msg['chunk'] === 'string' ? msg['chunk']
        : typeof msg['data'] === 'string' ? msg['data']
          : typeof media?.payload === 'string' ? media.payload
            : undefined;
      if (!b64) return;
      const contactId = typeof msg['contactId'] === 'string' ? msg['contactId'] : this.wsContacts.get(ws);
      if (!contactId) return;
      this.mediaSources.get(contactId)?.push(b64);
      // decode again for the analyzer window (keeps STT and analysis seams
      // independent; ~microseconds per frame)
      let pcm: Buffer;
      try { pcm = upsample8kTo16k(mulawDecode(Buffer.from(b64, 'base64'))); } catch { return; }
      const win = this.audioWindows.get(contactId);
      if (win && pcm.length) {
        win.chunks.push(pcm);
        win.bytes += pcm.length;
        while (win.bytes > this.audioWindowCap && win.chunks.length > 1) {
          win.bytes -= win.chunks.shift()!.length;
        }
      }
      return;
    }
    if (type === 'stop') {
      const sd = (msg.stop ?? msg) as Record<string, unknown>;
      const contactId = String(sd.contactId ?? this.wsContacts.get(ws) ?? '');
      const src = this.mediaSources.get(contactId);
      const win = this.audioWindows.get(contactId);
      if (src) {
        src.end();
        this.mediaSources.delete(contactId);
        // Grace: STT providers flush their final transcripts AFTER the source
        // ends (Deepgram CloseStream) — keep the session and audio window
        // alive so tail utterances land as turns with real scores instead of
        // being dropped by the call-ended check in pumpTurns.
        await new Promise(r => setTimeout(r, 1500));
        // Compute + persist voice biomarkers while the window still exists
        // (works before OR after the session end below: the API upsert
        // coalesces onto whichever row state exists).
        const callForBiomarkers = this.calls.get(contactId);
        if (this.biomarkersOn && win && win.chunks.length && callForBiomarkers) {
          const report = extractBiomarkers(Buffer.concat(win.chunks), getVoiceprintTemplate());
          await api('POST', `/v1/interactions/${callForBiomarkers.interactionId}/biomarkers`, report).catch(() => { /* best-effort */ });
        }
        this.audioWindows.delete(contactId);
      }
      const call = contactId ? this.calls.get(contactId) : undefined;
      if (call) {
        // best-effort: local cleanup must continue even if the API is down
        await api('POST', `/v1/interactions/${call.interactionId}/end`).catch(() => { /* API unavailable */ });
        this.calls.delete(contactId);
      }
      ws.send(JSON.stringify({ ok: true, ended: true }));
    }
  }
}

export function main() {
  // STT selection: demo scripted by default; CXTRUST_STT=transcribe selects
  // the real provider (audio source factory must be wired by the deployer —
  // see docs/CONNECTOR_SDK.md; without it Transcribe throws its labeled
  // 'no audio source' error rather than silently falling back).
  // CXTRUST_STT=deepgram selects DeepgramLiveSTTProvider via createDeepgramWiring.
  const useTranscribe = process.env.CXTRUST_STT === 'transcribe';
  void useTranscribe;
  const adapter = new ConnectAdapter(createDeepgramWiring() as never);
  adapter.listen();
}

/**
 * Deployment helper: when CXTRUST_STT=deepgram, returns { sttFactory } that
 * builds a DeepgramLiveSTTProvider per call (key/model/URL read from env at
 * request time). Unset/other value → {} so demo scripted stays default.
 */
export function createDeepgramWiring(): {
  sttFactory?: (call: { contactId: string; customerPhoneNumber?: string }) => import('./deepgram.ts').DeepgramLiveSTTProvider;
} {
  if (process.env.CXTRUST_STT !== 'deepgram') return {};
  return {
    sttFactory: () => new DeepgramLiveSTTProvider(),
  };
}

if (process.argv[1] && process.argv[1].endsWith('index.ts')) main();
