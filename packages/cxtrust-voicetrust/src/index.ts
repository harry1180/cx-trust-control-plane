// Voice-trust vendor integration providers for the CX Trust Control Plane.
//
// Real vendors (Pindrop, Reality Defender) plug in behind the
// VoiceTrustProvider seam. Every provider:
//   - reads credentials from process.env AT REQUEST TIME (never hardcoded);
//   - degrades EXPLICITLY (degraded: true + a labeled reason) instead of
//     throwing or fabricating scores, so the governance loop stays alive;
//   - NEVER returns a number it did not receive from the vendor API.
//
// Local machine has no vendor keys: without CXTRUST_PINDROP_URL /
// CXTRUST_PINDROP_KEY etc. providers return
// { degraded: true, degradedReason: 'credentials not configured', ...zeros }.

export interface VoiceTrustEvidence {
  kind: 'audio_signal' | 'metadata';
  text: string;
  locator?: string;
}

export interface VoiceTrustResult {
  /** 0..1 — likelihood the caller audio is synthetic / deepfake */
  syntheticProbability: number;
  /** 0..1 — likelihood the caller audio is a replayed recording */
  replayProbability: number;
  /** 0..1 — likelihood of caller impersonation (e.g. enrollment mismatch) */
  impersonationProbability: number;
  evidence: VoiceTrustEvidence[];
  providerId: string;
  degraded?: boolean;
  degradedReason?: string;
}

export interface VoiceTrustInput {
  contactId: string;
  customerPhoneNumber?: string;
  /** streaming audio; vendors that take raw audio consume this */
  audioChunks?: AsyncIterable<Buffer>;
}

export interface VoiceTrustProvider {
  id: string;
  analyze(input: VoiceTrustInput): Promise<VoiceTrustResult>;
}

const TIMEOUT_MS = 5_000;
export const CREDENTIALS_MISSING = 'credentials not configured';

function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(1, Math.max(0, n));
}

/** fetch with a hard 5s timeout via AbortController. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface HttpOutcome {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

async function postJson(url: string, headers: Record<string, string>, payload: unknown): Promise<HttpOutcome> {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* non-JSON body stays null */ }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function httpFailure(providerId: string, out: HttpOutcome): VoiceTrustResult {
  const reason = out.error
    ? `${providerId} request failed: ${out.error}`
    : `${providerId} request failed: HTTP ${out.status}`;
  return {
    syntheticProbability: 0,
    replayProbability: 0,
    impersonationProbability: 0,
    evidence: [{ kind: 'metadata', text: reason, locator: 'vendor-http' }],
    providerId,
    degraded: true,
    degradedReason: reason,
  };
}

/**
 * Pindrop-style provider.
 *
 * ASSUMED VENDOR SHAPE (documented, not verified against a live API):
 *   POST {url}/v1/calls  (or whatever CXTRUST_PINDROP_URL points at — the URL
 *   is used verbatim) with JSON body { callId, callerPhoneNumber, features }.
 *   Response JSON (Pindrop's documented fields):
 *     { "risk_band": "HIGH", "score": 812,
 *       "liveness": { "synthetic": 0.03, "replay": 0.02 },
 *       "impersonation": { "probability": 0.04 },
 *       "signals": [ { "name": "carrier_mismatch", "value": "..." } ] }
 * The synthetic/replay/impersonation numbers are taken verbatim from the
 * response when present (score is normalized score/1000 only if the liveness
 * sub-object is absent — still vendor-supplied data, no fabrication).
 */
export class PindropStyleProvider implements VoiceTrustProvider {
  readonly id: string;
  constructor(id = 'pindrop') {
    this.id = id;
  }

  async analyze(input: VoiceTrustInput): Promise<VoiceTrustResult> {
    const url = process.env.CXTRUST_PINDROP_URL; // read at REQUEST time
    const key = process.env.CXTRUST_PINDROP_KEY;
    if (!url || !key) {
      return {
        syntheticProbability: 0,
        replayProbability: 0,
        impersonationProbability: 0,
        evidence: [{ kind: 'metadata', text: `${this.id}: credentials not configured`, locator: 'env:CXTRUST_PINDROP_URL,CXTRUST_PINDROP_KEY' }],
        providerId: this.id,
        degraded: true,
        degradedReason: CREDENTIALS_MISSING,
      };
    }
    const out = await postJson(url, { authorization: `Bearer ${key}` }, {
      callId: input.contactId,
      callerPhoneNumber: input.customerPhoneNumber,
      features: { hasAudioStream: input.audioChunks !== undefined },
    });
    if (!out.ok) return httpFailure(this.id, out);
    const body = (out.body ?? {}) as Record<string, unknown>;
    const liveness = (body.liveness ?? {}) as Record<string, unknown>;
    const impersonation = (body.impersonation ?? {}) as Record<string, unknown>;
    let synthetic = liveness.synthetic;
    if (typeof synthetic !== 'number' && typeof body.score === 'number') synthetic = body.score / 1000;
    const evidence: VoiceTrustEvidence[] = [];
    if (typeof body.risk_band === 'string') {
      evidence.push({ kind: 'metadata', text: `risk_band=${body.risk_band}`, locator: 'pindrop:response.risk_band' });
    }
    if (Array.isArray(body.signals)) {
      for (const s of body.signals as Record<string, unknown>[]) {
        if (typeof s?.name === 'string') {
          evidence.push({ kind: 'audio_signal', text: `${s.name}=${String(s.value ?? '')}`, locator: 'pindrop:response.signals' });
        }
      }
    }
    return {
      syntheticProbability: clamp01(synthetic),
      replayProbability: clamp01(liveness.replay),
      impersonationProbability: clamp01(impersonation.probability),
      evidence,
      providerId: this.id,
    };
  }
}

/**
 * Reality Defender-style provider.
 *
 * ASSUMED VENDOR SHAPE (documented, not verified against a live API):
 *   POST CXTRUST_RD_URL (verbatim) as multipart/form-data when audio chunks
 *   are supplied (fields: audio = concatenated chunk bytes, metadata JSON
 *   string with contactId/customerPhoneNumber) else JSON
 *   { contactId, customerPhoneNumber }.
 *   Response JSON:
 *     { "results": [
 *         { "modelName": "audio-spoof", "score": 0.11 },
 *         { "modelName": "voice-replay", "score": 0.02 },
 *         { "modelName": "impersonation", "score": 0.06 } ] }
 *   Each model score is mapped by modelName to the matching probability.
 */
export class RealityDefenderStyleProvider implements VoiceTrustProvider {
  readonly id: string;
  constructor(id = 'reality-defender') {
    this.id = id;
  }

  private async collectAudio(chunks?: AsyncIterable<Buffer>): Promise<Buffer | undefined> {
    if (!chunks) return undefined;
    const parts: Buffer[] = [];
    for await (const c of chunks) parts.push(Buffer.from(c));
    return Buffer.concat(parts);
  }

  async analyze(input: VoiceTrustInput): Promise<VoiceTrustResult> {
    const url = process.env.CXTRUST_RD_URL; // read at REQUEST time
    const key = process.env.CXTRUST_RD_KEY;
    if (!url || !key) {
      return {
        syntheticProbability: 0,
        replayProbability: 0,
        impersonationProbability: 0,
        evidence: [{ kind: 'metadata', text: `${this.id}: credentials not configured`, locator: 'env:CXTRUST_RD_URL,CXTRUST_RD_KEY' }],
        providerId: this.id,
        degraded: true,
        degradedReason: CREDENTIALS_MISSING,
      };
    }
    let out: HttpOutcome;
    try {
      const audio = await this.collectAudio(input.audioChunks);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}` },
          signal: ac.signal,
          ...(audio === undefined
            ? { headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ contactId: input.contactId, customerPhoneNumber: input.customerPhoneNumber }) }
            : (() => { const fd = new FormData(); fd.append('audio', new Blob([new Uint8Array(audio)]), 'call.pcm'); fd.append('metadata', JSON.stringify({ contactId: input.contactId, customerPhoneNumber: input.customerPhoneNumber })); return { body: fd as unknown as BodyInit }; })()),
        });
        let body: unknown = null;
        try { body = await res.json(); } catch { /* keep null */ }
        out = { ok: res.ok, status: res.status, body };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      out = { ok: false, status: 0, body: null, error: e instanceof Error ? e.message : String(e) };
    }
    if (!out.ok) return httpFailure(this.id, out);
    const results = ((out.body ?? {}) as { results?: Array<{ modelName?: string; score?: number }> }).results ?? [];
    const byModel = new Map<string, number>();
    for (const r of results) if (typeof r.modelName === 'string' && typeof r.score === 'number') byModel.set(r.modelName, r.score);
    const evidence: VoiceTrustEvidence[] = results
      .filter((r): r is { modelName: string; score: number } => typeof r.modelName === 'string' && typeof r.score === 'number')
      .map((r) => ({ kind: 'audio_signal' as const, text: `${r.modelName} score=${r.score}`, locator: 'rd:response.results[].score' }));
    return {
      syntheticProbability: clamp01(byModel.get('audio-spoof') ?? byModel.get('synthetic')),
      replayProbability: clamp01(byModel.get('voice-replay') ?? byModel.get('replay')),
      impersonationProbability: clamp01(byModel.get('impersonation')),
      evidence,
      providerId: this.id,
    };
  }
}

/**
 * Fusion of N providers by configurable confidence weights (default equal).
 * A provider result is "failed" when it is degraded or was rejected
 * (non-finite scores); failed providers are EXCLUDED from the weighted mean
 * (a 0 from a degraded provider is NOT a real score) and flagged.
 * degraded is true when ANY provider failed; degradedReason lists them.
 */
export class EnsembleVoiceTrustProvider implements VoiceTrustProvider {
  readonly id: string;
  private providers: VoiceTrustProvider[];
  private weights: Map<string, number>;

  constructor(providers: VoiceTrustProvider[], weights?: Record<string, number>, id = 'voicetrust-ensemble') {
    this.providers = providers;
    this.id = id;
    const ws = weights ?? {};
    this.weights = new Map(providers.map((p) => [p.id, ws[p.id] ?? 1]));
  }

  async analyze(input: VoiceTrustInput): Promise<VoiceTrustResult> {
    if (this.providers.length === 0) {
      return {
        syntheticProbability: 0, replayProbability: 0, impersonationProbability: 0,
        evidence: [{ kind: 'metadata', text: `${this.id}: no providers configured`, locator: 'ensemble:providers' }],
        providerId: this.id, degraded: true, degradedReason: 'no providers configured',
      };
    }
    const settled = await Promise.all(this.providers.map(async (p) => {
      try {
        const r = await p.analyze(input);
        return { provider: p, result: r, error: undefined as string | undefined };
      } catch (e) {
        return { provider: p, result: undefined as VoiceTrustResult | undefined, error: e instanceof Error ? e.message : String(e) };
      }
    }));

    const healthy: { weight: number; result: VoiceTrustResult }[] = [];
    const failures: string[] = [];
    for (const s of settled) {
      const r = s.result;
      const ok = r && !r.degraded &&
        Number.isFinite(r.syntheticProbability) && Number.isFinite(r.replayProbability) && Number.isFinite(r.impersonationProbability);
      if (ok && r) healthy.push({ weight: this.weights.get(s.provider.id) ?? 1, result: r });
      else failures.push(`${s.provider.id}: ${s.error ?? r?.degradedReason ?? 'invalid result'}`);
    }

    const totalW = healthy.reduce((a, h) => a + h.weight, 0);
    let evidence: VoiceTrustEvidence[] = [];
    if (totalW > 0) {
      evidence = healthy.flatMap((h) =>
        h.result.evidence.map((e) => ({ ...e, text: `[${h.result.providerId}] ${e.text}` })));
    } else {
      // keep whatever evidence healthy-but-degraded providers produced
      evidence = settled
        .filter((s) => s.result)
        .flatMap((s) => (s.result as VoiceTrustResult).evidence
          .map((e) => ({ ...e, text: `[${s.provider.id}] ${e.text}` })));
    }

    const wavg = (pick: (r: VoiceTrustResult) => number) =>
      totalW > 0 ? healthy.reduce((a, h) => a + pick(h.result) * h.weight, 0) / totalW : 0;

    return {
      syntheticProbability: wavg((r) => r.syntheticProbability),
      replayProbability: wavg((r) => r.replayProbability),
      impersonationProbability: wavg((r) => r.impersonationProbability),
      evidence,
      providerId: this.id,
      ...(failures.length > 0 ? { degraded: true, degradedReason: `providers failed: ${failures.join('; ')}` } : {}),
    };
  }
}

/**
 * Adapter from async VoiceTrustProvider to the sync VoiceAnalyzer seam the
 * ConnectAdapter consumes (cxtrust-connect: analyze(input) => VoiceAnalysis).
 *
// LATENCY TRADEOFF: real vendor analysis takes seconds; ConnectAdapter wants a
// synchronous result per audio event. WrappedVoiceTrustAnalyzer therefore
// returns the LAST CACHED result per contactId immediately and refreshes the
// cache in the background (fire-and-forget promise). First call for a contact
// returns zeros until the first vendor response lands. Callers that can wait
// should use provider.analyze() directly instead.
 */
export class WrappedVoiceTrustAnalyzer {
  readonly id: string;
  private provider: VoiceTrustProvider;
  private cache = new Map<string, VoiceTrustResult>();

  constructor(provider: VoiceTrustProvider) {
    this.provider = provider;
    this.id = `wrapped:${provider.id}`;
  }

  analyze(input: { contactId: string; customerPhoneNumber?: string; audioChunk?: Buffer }): {
    syntheticProbability: number;
    replayProbability: number;
    impersonationProbability: number;
  } {
    const cached = this.cache.get(input.contactId);
    // fire-and-forget refresh; sync signature forbids awaiting here
    void this.provider
      .analyze({
        contactId: input.contactId,
        customerPhoneNumber: input.customerPhoneNumber,
        ...(input.audioChunk !== undefined
          ? { audioChunks: (async function* () { yield input.audioChunk as Buffer; })() }
          : {}),
      })
      .then((r) => { this.cache.set(input.contactId, r); })
      .catch(() => { /* keep last known cache; failures surface via next analyze */ });
    if (!cached) return { syntheticProbability: 0, replayProbability: 0, impersonationProbability: 0 };
    return {
      syntheticProbability: cached.syntheticProbability,
      replayProbability: cached.replayProbability,
      impersonationProbability: cached.impersonationProbability,
    };
  }
}

/** Back-compat helper: wrap into the analyzer (same class the adapter uses). */
export function toVoiceAnalyzer(p: VoiceTrustProvider): WrappedVoiceTrustAnalyzer {
  return new WrappedVoiceTrustAnalyzer(p);
}
