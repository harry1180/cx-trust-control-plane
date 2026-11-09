// Twilio Media Streams adapter for the CX Trust Control Plane.
//
// Twilio <Connect><Stream> opens a bidirectional WebSocket to this server
// (path /twilio). Twilio sends JSON frames:
//   {event:'start', start:{streamSid, callSid, customParameters, ...}}
//   {event:'media', media:{payload: base64 mulaw 8kHz audio}}
//   {event:'stop',  stop:{streamSid, callSid}}
// and accepts outbound frames of the same media shape to inject audio into
// the call (step-up prompts, warnings, disclosure injection).
//
// Pipeline: base64 mulaw 8k → 16kHz mono 16-bit PCM chunks (MuLawStreamSource,
// real-time paced) → pluggable SpeechToTextProvider (audioSourceFactory seam,
// e.g. Amazon Transcribe live analytics) → governance API turns + voice
// analysis → enforcement gate POST /twilio/action/:callSid.
//
// Zero-dep style: only `ws` (same as @cxtrust/connect). STT provider itself is
// injected; the heavy SDK lives in the provider package, not here.

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { DeepgramLiveSTTProvider } from '@cxtrust/connect/src/deepgram.ts';

const DEEPGRAM_KEY_ENV = 'CXTRUST_DEEPGRAM_KEY';

const API_BASE = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
const API_KEY = process.env.CXTRUST_API_KEY;
const PORT = Number(process.env.CXTRUST_TWILIO_PORT ?? 8800);
const ORG = process.env.CXTRUST_ORG ?? 'org-demo';

export interface Turn {
  text: string;
  speaker: 'CUSTOMER' | 'AGENT';
  offsetS: number;
}

/** Audio source seam (identical shape to @cxtrust/connect transcribe.ts). */
export interface AudioSource {
  /** 16kHz mono 16-bit PCM chunks */
  chunks(): AsyncIterable<Buffer>;
}

/** Seam for real STT: Amazon Transcribe live analytics implements this. */
export interface SpeechToTextProvider {
  id: string;
  transcribe(input: {
    callSid: string;
    streamSid: string;
    customerPhoneNumber?: string;
    metadata: Record<string, unknown>;
    audioSource?: AudioSource;
  }): AsyncIterable<Turn>;
}

/** Audio analysis provider seam: real vendors plug here. */
export interface VoiceAnalysis {
  syntheticProbability: number;
  replayProbability: number;
  impersonationProbability: number;
}
export interface VoiceAnalyzer {
  id: string;
  analyze(input: { callSid: string; customerPhoneNumber?: string; audioChunk?: Buffer }): VoiceAnalysis;
}

// ---------------------------------------------------------------------------
// MuLaw codec (standard ITU G.711 µ-law decode/encode tables)
// ---------------------------------------------------------------------------

export const MulawCodec = (() => {
  // decode table: ulaw byte → linear 16-bit PCM (classic Sun g711.c algorithm)
  const DECODE = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    DECODE[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
  }
  // encode table: 16-bit linear → ulaw byte (built by search over segments)
  const ENCODE = new Uint8Array(65536);
  for (let n = 0; n < 65536; n++) {
    ENCODE[n] = encodeSample(n - 32768);
  }
  function encodeSample(pcm0: number): number {
    let pcm = pcm0;
    if (pcm > 32635) pcm = 32635;
    if (pcm < -32635) pcm = -32635;
    let sign = 0;
    if (pcm < 0) {
      sign = 0x80;
      pcm = -pcm;
    }
    pcm += 0x84; // bias
    let exponent = 7;
    let mask = 0x4000;
    while (exponent > 0 && (pcm & mask) === 0) {
      exponent--;
      mask >>= 1;
    }
    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
  }
  return {
    /** mulaw byte → linear 16-bit PCM sample */
    decodeSample(u: number): number {
      return DECODE[u & 0xff];
    },
    /** linear 16-bit PCM sample → mulaw byte */
    encodeSample(pcm: number): number {
      return ENCODE[(pcm < -32768 ? -32768 : pcm > 32767 ? 32767 : pcm) + 32768];
    },
    /** decode a buffer of mulaw bytes into 16-bit LE PCM */
    decode(mulaw: Buffer): Buffer {
      const out = Buffer.alloc(mulaw.length * 2);
      for (let i = 0; i < mulaw.length; i++) out.writeInt16LE(DECODE[mulaw[i]], i * 2);
      return out;
    },
    /** encode 16-bit LE PCM into mulaw bytes */
    encode(pcm: Buffer): Buffer {
      const n = Math.floor(pcm.length / 2);
      const out = Buffer.alloc(n);
      for (let i = 0; i < n; i++) out[i] = ENCODE[pcm.readInt16LE(i * 2) + 32768];
      return out;
    },
  };
})();

/**
 * Standard µ-law decode table: silence (0xFF) decodes to 0, and the
 * segment ladder expands into ±(8..8031) linear amplitudes.
 */
export function mulawDecode(mulaw: Buffer): Buffer {
  return MulawCodec.decode(mulaw);
}
export function mulawEncode(pcm: Buffer): Buffer {
  return MulawCodec.encode(pcm);
}

/** Upsample 8kHz mono PCM → 16kHz mono PCM by sample duplication. */
export function upsample8kTo16k(pcm8k: Buffer): Buffer {
  const n = Math.floor(pcm8k.length / 2);
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s = pcm8k.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

// ---------------------------------------------------------------------------
// MuLawStreamSource: live Twilio media → paced 16k PCM AudioSource
// ---------------------------------------------------------------------------

/**
 * Collects base64 mulaw frames from a Twilio media stream and yields
 * ~100ms (3200-byte) chunks of 16kHz mono 16-bit PCM with real-time pacing.
 */
export class MuLawStreamSource implements AudioSource {
  private pending: Buffer[] = []; // decoded+upsampled PCM, awaiting flush
  private pendingBytes = 0;
  private done = false;
  private waiters: (() => void)[] = [];

  /** Feed one Twilio media payload (base64 mulaw 8kHz). */
  push(base64Mulaw: string): void {
    if (this.done) return;
    let mulaw: Buffer;
    try {
      mulaw = Buffer.from(base64Mulaw, 'base64');
    } catch {
      return;
    }
    if (!mulaw.length) return;
    const pcm16k = upsample8kTo16k(MulawCodec.decode(mulaw));
    this.pending.push(pcm16k);
    this.pendingBytes += pcm16k.length;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  /** Twilio sent the stop event — no more audio. */
  end(): void {
    this.done = true;
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  get hasData(): boolean {
    return this.pendingBytes > 0;
  }

  async *chunks(): AsyncIterable<Buffer> {
    const chunkBytes = 3200; // ~100ms of 16kHz mono 16-bit PCM
    for (;;) {
      while (this.pendingBytes >= chunkBytes) {
        // flush exactly chunkBytes
        let need = chunkBytes;
        const parts: Buffer[] = [];
        while (need > 0) {
          const head = this.pending[0]!;
          if (head.length <= need) {
            parts.push(head);
            need -= head.length;
            this.pending.shift();
            this.pendingBytes -= head.length;
          } else {
            parts.push(head.subarray(0, need));
            this.pending[0] = head.subarray(need);
            this.pendingBytes -= need;
            need = 0;
          }
        }
        yield Buffer.concat(parts);
        await new Promise(r => setTimeout(r, 100)); // real-time pacing
      }
      if (this.done && this.pendingBytes === 0) return;
      // tail flush when the stream ended but a partial chunk remains
      if (this.done && this.pendingBytes > 0) {
        const rest = Buffer.concat(this.pending);
        this.pending = [];
        this.pendingBytes = 0;
        yield rest;
        return;
      }
      await new Promise<void>(r => this.waiters.push(r));
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface CallState {
  interactionId: string;
  callSid: string;
  streamSid?: string;
  customerPhoneNumber?: string;
  violations: { offsetS: number; decision: Record<string, unknown> }[];
  startedAt: string;
}

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(API_KEY ? { 'x-api-key': API_KEY } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as Record<string, unknown>;
}

export class TwilioStreamAdapter {
  private calls = new Map<string, CallState>(); // keyed by callSid
  private streams = new Map<string, { callSid: string; source: MuLawStreamSource }>(); // streamSid → stream
  private stt: SpeechToTextProvider;
  private voice: VoiceAnalyzer;
  private audioSourceFactory?: (call: { callSid: string; customerPhoneNumber?: string }) => AudioSource;
  /** Twilio integration (credentials + public host), in-memory only. */
  private integration?: {
    accountSid: string; authToken: string; publicHost: string;
    validated: boolean; numbers: Array<{ phoneNumber: string; sid: string; configured: boolean }>;
  };
  private twimlCustomerPhone?: string;
  get lastCustomerPhone() { return this.twimlCustomerPhone; }

  /**
   * Validate credentials against Twilio's REST API and (optionally) set the
   * voice webhook on every owned number to this adapter's /twiml endpoint.
   * Credentials live in memory for this process only; never logged.
   */
  async configure(body: {
    accountSid: string; authToken: string; publicHost?: string;
    configureNumbers?: boolean;
  }): Promise<Record<string, unknown>> {
    const accountSid = String(body.accountSid ?? '').trim();
    const authToken = String(body.authToken ?? '').trim();
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || authToken.length < 8) {
      return { ok: false, error: 'invalid Account SID or Auth Token format' };
    }
    // Validate against Twilio's public API by listing the account
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    let numbers: Array<{ phoneNumber: string; sid: string; configured: boolean }> = [];
    let validated = false;
    try {
      const acct = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
        headers: { authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!acct.ok) {
        return { ok: false, error: `Twilio rejected the credentials (HTTP ${acct.status})` };
      }
      validated = true;
      const list = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`, {
        headers: { authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(8000),
      });
      if (list.ok) {
        const j = await list.json() as { incoming_phone_numbers?: Array<{ phone_number: string; sid: string }> };
        numbers = (j.incoming_phone_numbers ?? []).map(n => ({ phoneNumber: n.phone_number, sid: n.sid, configured: false }));
      }
    } catch (err) {
      return { ok: false, error: `cannot reach Twilio API: ${String((err as Error).message).slice(0, 120)}` };
    }
    // Auto-configure the voice webhook when the public host is reachable info
    const publicHost = String(body.publicHost ?? '').trim();
    let configuredNumbers = 0;
    if (publicHost && body.configureNumbers !== false) {
      const webhook = publicHost.startsWith('http')
        ? `${publicHost.replace(/\/$/, '')}/twiml`
        : `https://${publicHost}/twiml`;
      for (const n of numbers) {
        try {
          const post = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${n.sid}.json`, {
            method: 'POST',
            headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ VoiceUrl: webhook, VoiceMethod: 'POST' }),
            signal: AbortSignal.timeout(8000),
          });
          n.configured = post.ok;
          if (post.ok) configuredNumbers += 1;
        } catch { /* leave unconfigured, reported per-number */ }
      }
    }
    this.integration = { accountSid, authToken, publicHost, validated, numbers };
    return {
      ok: true,
      validated,
      numbers,
      configuredNumbers,
      webhookUrl: publicHost ? `/twiml on ${publicHost}` : null,
      note: validated && numbers.length === 0
        ? 'Credentials valid but no phone numbers on this account yet — buy one in the Twilio console.'
        : undefined,
    };
  }

  constructor(opts: {
    stt?: SpeechToTextProvider;
    /** per-call STT provider factory (e.g. Deepgram live per call) */
    sttFactory?: (call: { callSid: string; customerPhoneNumber?: string }) => SpeechToTextProvider;
    voice?: VoiceAnalyzer;
    /** per-call audio source factory for the STT provider (live streams) */
    audioSourceFactory?: (call: { callSid: string; customerPhoneNumber?: string }) => AudioSource;
  } = {}) {
    this.stt = opts.stt ?? new ScriptedCallTranscriber();
    this.voice = opts.voice ?? new DemoVoiceAnalyzer();
    this.audioSourceFactory = opts.audioSourceFactory;
    this.sttFactory = opts.sttFactory;
  }

  private sttFactory?: (call: { callSid: string; customerPhoneNumber?: string }) => SpeechToTextProvider;

  private sttFor(call: { callSid: string; customerPhoneNumber?: string }): SpeechToTextProvider {
    return this.sttFactory ? this.sttFactory(call) : this.stt;
  }

  getCall(callSid: string) {
    return this.calls.get(callSid);
  }

  /** POST {API}/v1/interactions + CUSTOMER participant, then pump STT turns. */
  async startCall(callSid: string, meta: { streamSid?: string; customerPhoneNumber?: string; customParameters?: Record<string, unknown> }) {
    const customerPhoneNumber = meta.customerPhoneNumber;
    const res = await api('POST', '/v1/interactions', {
      organizationId: ORG,
      platform: 'twilio',
      channel: 'voice',
      interactionId: `INT-TW-${callSid}`,
      metadata: {
        callSid,
        streamSid: meta.streamSid,
        customerPhoneNumber: customerPhoneNumber ?? undefined,
        customParameters: meta.customParameters,
      },
    });
    const interactionId = String(res.interactionId ?? '');
    const call: CallState = {
      interactionId,
      callSid,
      streamSid: meta.streamSid,
      customerPhoneNumber,
      violations: [],
      startedAt: new Date().toISOString(),
    };
    this.calls.set(callSid, call);

    await api('POST', `/v1/interactions/${interactionId}/participant`, {
      participantId: 'customer',
      interactionId,
      organizationId: ORG,
      kind: 'CUSTOMER',
      classification: 'HUMAN_UNKNOWN',
      identityConfidence: 0.3,
      authLevel: 'NONE',
      joinedAtOffsetS: 0,
      riskState: {},
    }).catch(() => {});

    // live audio source (when wired) so real STT consumes the stream
    let audioSource: AudioSource | undefined;
    if (meta.streamSid) {
      const src = this.streams.get(meta.streamSid);
      if (src) audioSource = src.source;
    }
    if (!audioSource && this.audioSourceFactory) {
      audioSource = this.audioSourceFactory({ callSid, customerPhoneNumber });
    }

    void this.pumpTurns(call, audioSource);
    return call;
  }

  private async pumpTurns(call: CallState, audioSource?: AudioSource) {
    try {
      const stream = this.sttFor(call).transcribe({
        callSid: call.callSid,
        streamSid: call.streamSid ?? '',
        customerPhoneNumber: call.customerPhoneNumber,
        metadata: {},
        audioSource,
      });
      for await (const turn of stream) {
        if (!this.calls.has(call.callSid)) return; // call ended
        const va = this.voice.analyze({ callSid: call.callSid, customerPhoneNumber: call.customerPhoneNumber });
        await api('POST', `/v1/interactions/${call.interactionId}/voice`, { participantId: 'customer', ...va }).catch(() => {});
        await api('POST', `/v1/interactions/${call.interactionId}/turns`, { participantId: 'customer', text: turn.text, offsetS: turn.offsetS }).catch(() => {});
      }
    } catch {
      // call ended / API unavailable — pump is best-effort
    }
  }

  /** Enforcement gate: evaluate a customer-risky action against governance. */
  async checkAction(callSid: string, action: { requestedAction: string; amount?: number; intent?: string }): Promise<Record<string, unknown>> {
    const call = this.calls.get(callSid);
    if (!call) return { allowed: false, reason: 'no governed session for this callSid' };
    const d = await api('POST', `/v1/interactions/${call.interactionId}/actions`, {
      requestedAction: action.requestedAction,
      participantId: 'customer',
      amount: action.amount,
      intent: action.intent,
    });
    const decision = d as { decision?: Record<string, unknown> };
    if (decision.decision && !(decision.decision as { allowed: boolean }).allowed) {
      call.violations.push({ offsetS: 0, decision: decision.decision });
    }
    return decision;
  }

  /**
   * Outbound audio injection seam: 16kHz mono PCM → 8kHz (decimate by 2) →
   * mulaw → base64 media frames written to the live WebSocket for the call.
   * Usable for step-up auth prompts, warnings, disclosure injection.
   */
  sendAudioToStream(callSid: string, pcm16k: Buffer, opts: { chunkMs?: number } = {}): number {
    const call = this.calls.get(callSid);
    const ws = this.sockets.get(callSid);
    if (!call || !call.streamSid || !ws) return 0;
    // decimate 16k → 8k (take every other sample)
    const n16 = Math.floor(pcm16k.length / 2);
    const pcm8k = Buffer.alloc(Math.floor(n16 / 2) * 2);
    for (let i = 0; i < Math.floor(n16 / 2); i++) pcm8k.writeInt16LE(pcm16k.readInt16LE(i * 4), i * 2);
    const mulaw = MulawCodec.encode(pcm8k);
    // Twilio media frames carry 20ms of mulaw audio (160 bytes)
    const frameBytes = 160;
    let frames = 0;
    for (let i = 0; i < mulaw.length; i += frameBytes) {
      const payload = mulaw.subarray(i, Math.min(i + frameBytes, mulaw.length)).toString('base64');
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ event: 'media', streamSid: call.streamSid, media: { payload } }));
        frames++;
      }
    }
    return frames;
  }

  private sockets = new Map<string, WebSocket>(); // callSid → ws

  /** HTTP + WebSocket server for Twilio media streams and the enforcement API. */
  listen(port = PORT) {
    const server = http.createServer((req, res) => {
      void this.httpHandler(req, res);
    });
    const wss = new WebSocketServer({ server, path: '/twilio' });
    wss.on('connection', (ws: WebSocket) => {
      let boundCallSid: string | null = null;
      ws.on('message', (data: Buffer) => {
        void this.mediaMessage(ws, data);
      });
      ws.on('close', () => {
        if (boundCallSid) {
          // treat socket loss as stop
          void this.stopCall(boundCallSid, '');
          this.sockets.delete(boundCallSid);
        }
      });
      // remember which call this socket serves once start arrives
      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
          if (msg['event'] === 'start') {
            const sid = String((msg.start as Record<string, unknown>)?.streamSid ?? '');
            const st = sid ? this.streams.get(sid) : undefined;
            if (st) {
              boundCallSid = st.callSid;
              this.sockets.set(st.callSid, ws);
            }
          }
        } catch { /* ignore */ }
      });
    });
    server.listen(port, () => console.log(`twilio adapter listening :${port} · ws /twilio · api ${API_BASE} · stt ${this.stt.id}`));
    return server;
  }

  private async httpHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'POST' && url.pathname?.startsWith('/twilio/action/')) {
        const callSid = url.pathname.split('/').pop() ?? '';
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const result = await this.checkAction(callSid, body);
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(result));
      }
      if (req.method === 'GET' && url.pathname === '/twilio/streams') {
        const live = [...this.streams.entries()].map(([streamSid, s]) => {
          const call = this.calls.get(s.callSid);
          return {
            streamSid,
            callSid: s.callSid,
            interactionId: call?.interactionId,
            customerPhoneNumber: call?.customerPhoneNumber,
            bufferedPcmBytes: s.source.hasData,
            violations: call?.violations.length ?? 0,
          };
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ streams: live }));
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ ok: true, activeStreams: this.streams.size, activeCalls: this.calls.size }));
      }
      // TwiML response for the voice webhook — Twilio POSTs call setup here
      // (configurable number) and we return a Connect<Stream> dialing back to
      // this same host's /twilio WebSocket.
      if (req.method === 'POST' && url.pathname === '/twiml') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const host = req.headers.host ?? url.host;
        const wsUrl = `wss://${host}/twilio`;
        const customerPhone = params.get('From') ?? params.get('Caller') ?? '';
        this.twimlCustomerPhone = customerPhone;
        res.writeHead(200, { 'content-type': 'text/xml' });
        return void res.end(
          `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n    <Stream url="${wsUrl}">\n      <Parameter name="customer_phone" value="${customerPhone}"/>\n    </Stream>\n  </Connect>\n  <Pause length="120"/>\n</Response>`);
      }
      // Integration endpoint: the console saves Twilio credentials + the
      // public host here; the adapter validates them against Twilio's REST
      // API and can auto-configure the number's voice webhook. Credentials
      // are held in memory only (this process) and never logged.
      if (req.method === 'POST' && url.pathname === '/twilio/configure') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const result = await this.configure(body);
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(result));
      }
      if (req.method === 'GET' && url.pathname === '/twilio/configure/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({
          configured: !!this.integration,
          publicHost: this.integration?.publicHost ?? null,
          twilioValidated: this.integration?.validated ?? false,
          numbers: this.integration?.numbers ?? [],
          accountSidMasked: this.integration?.accountSid ? `${this.integration.accountSid.slice(0, 6)}…` : null,
        }));
      }
      res.writeHead(404);
      res.end('{"error":"not found"}');
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String((err as Error).message) }));
    }
  }

  /** One Twilio media-stream frame: start / media / stop. */
  private async mediaMessage(ws: WebSocket, data: Buffer) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const ev = String(msg['event'] ?? '');

    if (ev === 'start') {
      const s = (msg.start ?? msg) as Record<string, unknown>;
      const streamSid = String(s.streamSid ?? `ST-${Date.now()}`);
      const callSid = String(s.callSid ?? streamSid);
      const cp = (s.customParameters ?? {}) as Record<string, unknown>;
      const customerPhone = String(cp.customer_phone ?? s.From ?? cp.From ?? s.customerPhoneNumber ?? '') || undefined;
      const source = new MuLawStreamSource();
      this.streams.set(streamSid, { callSid, source });
      const call = await this.startCall(callSid, {
        streamSid,
        customerPhoneNumber: customerPhone,
        customParameters: cp,
      });
      // hand the same live source to an injected factory too (wired STT)
      if (this.audioSourceFactory) {
        // factory-provided source takes precedence only if none attached
        void this.audioSourceFactory({ callSid, customerPhoneNumber: customerPhone });
      }
      ws.send(JSON.stringify({ ok: true, interactionId: call.interactionId, governed: true }));
      return;
    }

    if (ev === 'media') {
      const m = (msg.media ?? {}) as Record<string, unknown>;
      const streamSid = String((msg.streamSid as string) ?? '');
      const st = this.streams.get(streamSid);
      if (st) st.source.push(String(m.payload ?? ''));
      return;
    }

    if (ev === 'stop') {
      const s = (msg.stop ?? msg) as Record<string, unknown>;
      const streamSid = String(s.streamSid ?? '');
      const callSid = String(s.callSid ?? '');
      if (streamSid) this.streams.get(streamSid)?.source.end();
      await this.stopCall(callSid, streamSid);
      ws.send(JSON.stringify({ ok: true, ended: true }));
    }
  }

  private async stopCall(callSid: string, streamSid: string) {
    const call = this.calls.get(callSid);
    if (!call) return;
    await api('POST', `/v1/interactions/${call.interactionId}/end`).catch(() => {});
    this.calls.delete(callSid);
    if (streamSid) this.streams.delete(streamSid);
    this.sockets.delete(callSid);
  }
}

// ---------------------------------------------------------------------------
// Demo STT + voice analyzer (mirror of @cxtrust/connect's, kept local so this
// package stays self-contained; production swaps in TranscribeLiveCallProvider)
// ---------------------------------------------------------------------------

/** Clearly-labeled demo provider: replays a scripted call for a number. */
export class ScriptedCallTranscriber implements SpeechToTextProvider {
  readonly id = 'demo-scripted-transcriber (NOT real speech recognition)';
  private scripts: Record<string, Turn[]>;
  constructor(scripts: Record<string, Turn[]> = DEFAULT_CALL_SCRIPTS) {
    this.scripts = scripts;
  }

  async *transcribe(input: { callSid: string; customerPhoneNumber?: string; audioSource?: AudioSource }): AsyncIterable<Turn> {
    const script = this.scripts[input.customerPhoneNumber ?? 'default'] ?? this.scripts['default']!;
    for (const t of script) {
      await new Promise(r => setTimeout(r, 700));
      yield t;
    }
  }
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

export const SPOOF_NUMBERS = new Set(['+155****1111']);

const DEFAULT_CALL_SCRIPTS: Record<string, Turn[]> = {
  '+155****1111': [
    { text: 'Hello? Yes, I lost my phone. I need to recover my account right now.', speaker: 'CUSTOMER', offsetS: 2 },
    { text: 'Change my bank account to the new one and move my funds today.', speaker: 'CUSTOMER', offsetS: 10 },
  ],
  default: [
    { text: 'Hi, can you tell me my checking account balance?', speaker: 'CUSTOMER', offsetS: 2 },
  ],
};

export function main() {
  const adapter = new TwilioStreamAdapter(createDeepgramWiring() as never);
  adapter.listen();
}

/**
 * Deployment helper: when CXTRUST_STT=deepgram and CXTRUST_DEEPGRAM_KEY is
 * set, returns { sttFactory } building a DeepgramLiveSTTProvider per call
 * (from @cxtrust/connect; key/model/URL read from env at request time).
 * Unset/other value → {} so demo scripted stays default.
 */
export function createDeepgramWiring(): {
  sttFactory?: (call: { callSid: string; customerPhoneNumber?: string }) => SpeechToTextProvider;
} {
  if (process.env.CXTRUST_STT !== 'deepgram' || !process.env[DEEPGRAM_KEY_ENV]) return {};
  return { sttFactory: () => new DeepgramLiveSTTProvider() };
}

if (process.argv[1] && process.argv[1].endsWith('index.ts')) main();
