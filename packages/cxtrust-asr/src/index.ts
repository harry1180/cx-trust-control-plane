// ASR router — pluggable ASR providers with routing policy.
// providers: cloud (existing cxtrust-connect SpeechToTextProvider shapes —
// Transcribe/Deepgram stay the realtime default) + the local faster-whisper
// sidecar (asr-worker, :8810) for offline/batch and cost-sensitive paths.
//
// Routing factors (charter): realtime vs offline, latency, availability,
// tenant preference. The router NEVER silently falls back — a provider error
// surfaces with its label (honest degradation, same as the connect adapter).

export interface AsrSegment {
  start: number;
  end: number;
  text: string;
  words?: { start: number; end: number; word: string }[];
}

export interface AsrResult {
  provider: string;
  language?: string;
  segments: AsrSegment[];
  durationS?: number;
  latencyMs: number;
}

export type AsrRoute = 'realtime' | 'offline' | 'cost';

export interface AsrProvider {
  readonly id: string;
  readonly supportsRealtime: boolean;
  available(): Promise<boolean>;
  transcribeWav(wavBytes: Buffer, language?: string): Promise<AsrResult>;
}

// ---------- Local sidecar provider (faster-whisper via asr-worker) ----------

export class WhisperSidecarProvider implements AsrProvider {
  readonly id = 'faster-whisper-sidecar';
  readonly supportsRealtime = false;
  private baseUrl: string;
  constructor(baseUrl = process.env.ASR_SIDECAR_URL ?? 'http://127.0.0.1:8810') { this.baseUrl = baseUrl; }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch { return false; }
  }

  async transcribeWav(wavBytes: Buffer, language?: string): Promise<AsrResult> {
    const t0 = performance.now();
    const res = await fetch(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio_base64: wavBytes.toString('base64'), ...(language ? { language } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`[asr-sidecar] ${res.status}: ${await res.text()}`);
    const body = await res.json() as { language?: string; segments: AsrSegment[]; durationS?: number };
    return {
      provider: this.id,
      language: body.language ?? language,
      segments: body.segments,
      durationS: body.durationS,
      latencyMs: Math.round(performance.now() - t0),
    };
  }
}

// ---------- Router ----------

export interface AsrRouterOptions {
  /** explicit tenant/system preference overrides routing heuristics */
  preferredProvider?: string;
  realtimeProviderId?: string;
}

export class AsrRouter {
  private providers = new Map<string, AsrProvider>();

  register(p: AsrProvider): void { this.providers.set(p.id, p); }
  list(): string[] { return Array.from(this.providers.keys()); }

  /** Pick a provider for the route. Realtime → cloud; offline/cost → local sidecar when available. */
  async pick(route: AsrRoute, opts: AsrRouterOptions = {}): Promise<AsrProvider> {
    if (opts.preferredProvider) {
      const p = this.providers.get(opts.preferredProvider);
      if (!p) throw new Error(`[asr-router] preferred provider '${opts.preferredProvider}' not registered`);
      if (!(await p.available())) throw new Error(`[asr-router] preferred provider '${opts.preferredProvider}' unavailable`);
      return p;
    }
    const candidates = Array.from(this.providers.values()).filter(p => route === 'realtime' ? p.supportsRealtime : true);
    // prefer the sidecar for offline/cost when healthy
    const sorted = candidates.sort((a, b) => (a.id.includes('sidecar') ? -1 : 0) - (b.id.includes('sidecar') ? -1 : 0));
    for (const p of sorted) {
      if (await p.available()) return p;
    }
    throw new Error(`[asr-router] no available provider for route '${route}' (registered: ${this.list().join(',')})`);
  }

  async transcribe(wavBytes: Buffer, route: AsrRoute = 'offline', language?: string, opts: AsrRouterOptions = {}): Promise<AsrResult> {
    const p = await this.pick(route, opts);
    return p.transcribeWav(wavBytes, language);
  }
}