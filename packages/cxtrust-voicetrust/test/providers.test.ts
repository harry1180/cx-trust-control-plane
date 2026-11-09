// Contract tests for the voice-trust vendor providers.
// EVERY HTTP endpoint here is a MOCK (label: MOCK) local node:http server —
// no real vendor APIs or keys are used on this machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  PindropStyleProvider,
  RealityDefenderStyleProvider,
  EnsembleVoiceTrustProvider,
  WrappedVoiceTrustAnalyzer,
  toVoiceAnalyzer,
  CREDENTIALS_MISSING,
  type VoiceTrustResult,
  type VoiceTrustProvider,
} from '../src/index.ts';

interface MockServer {
  url: string;
  requests: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  close(): Promise<void>;
}

/** MOCK: local HTTP server returning canned vendor JSON. */
async function startMock(handler: (req: http.IncomingMessage, body: string) => { status?: number; body: unknown }): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const h = handler(req, body);
      res.writeHead(h.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(h.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('MOCK PindropStyleProvider maps a realistic vendor response to VoiceTrustResult', async () => {
  const pindropJson = {
    risk_band: 'MEDIUM',
    score: 250,
    liveness: { synthetic: 0.42, replay: 0.31 },
    impersonation: { probability: 0.18 },
    signals: [{ name: 'carrier_mismatch', value: 'true' }, { name: 'device_spoof', value: 'suspected' }],
  };
  const mock = await startMock(() => ({ body: pindropJson }));
  await withEnv({ CXTRUST_PINDROP_URL: mock.url, CXTRUST_PINDROP_KEY: 'test-key' }, async () => {
    const res = await new PindropStyleProvider().analyze({ contactId: 'c-1', customerPhoneNumber: '+1555' });
    assert.equal(res.providerId, 'pindrop');
    assert.equal(res.syntheticProbability, 0.42);
    assert.equal(res.replayProbability, 0.31);
    assert.equal(res.impersonationProbability, 0.18);
    assert.equal(res.degraded, undefined);
    assert.ok(res.evidence.some((e) => e.text.includes('risk_band=MEDIUM')));
    assert.ok(res.evidence.some((e) => e.text.includes('carrier_mismatch')));
    // key was sent, never hardcoded
    assert.equal(mock.requests[0].headers.authorization, 'Bearer test-key');
    assert.equal(JSON.parse(mock.requests[0].body).callId, 'c-1');
  });
  await mock.close();
});

test('MOCK PindropStyleProvider falls back to normalized score when liveness absent', async () => {
  const mock = await startMock(() => ({ body: { score: 900, risk_band: 'HIGH' } }));
  await withEnv({ CXTRUST_PINDROP_URL: mock.url, CXTRUST_PINDROP_KEY: 'k' }, async () => {
    const res = await new PindropStyleProvider().analyze({ contactId: 'c-2' });
    assert.equal(res.syntheticProbability, 0.9);
    assert.equal(res.replayProbability, 0);
  });
  await mock.close();
});

test('missing Pindrop env returns degraded result with labeled reason (no fabricated scores)', async () => {
  await withEnv({ CXTRUST_PINDROP_URL: undefined, CXTRUST_PINDROP_KEY: undefined }, async () => {
    const res = await new PindropStyleProvider().analyze({ contactId: 'c-3' });
    assert.equal(res.degraded, true);
    assert.equal(res.degradedReason, CREDENTIALS_MISSING);
    assert.equal(res.syntheticProbability, 0);
    assert.equal(res.replayProbability, 0);
    assert.equal(res.impersonationProbability, 0);
  });
});

test('MOCK RealityDefenderStyleProvider happy path maps model scores', async () => {
  const rdJson = {
    results: [
      { modelName: 'audio-spoof', score: 0.72 },
      { modelName: 'voice-replay', score: 0.55 },
      { modelName: 'impersonation', score: 0.21 },
    ],
  };
  const mock = await startMock(() => ({ body: rdJson }));
  await withEnv({ CXTRUST_RD_URL: mock.url, CXTRUST_RD_KEY: 'rd-key' }, async () => {
    const res = await new RealityDefenderStyleProvider().analyze({ contactId: 'c-4' });
    assert.equal(res.providerId, 'reality-defender');
    assert.equal(res.syntheticProbability, 0.72);
    assert.equal(res.replayProbability, 0.55);
    assert.equal(res.impersonationProbability, 0.21);
    assert.equal(res.evidence.length, 3);
    assert.equal(mock.requests[0].headers.authorization, 'Bearer rd-key');
  });
  await mock.close();
});

test('MOCK RealityDefenderStyleProvider: vendor error -> degraded labeled result', async () => {
  const mock = await startMock(() => ({ status: 500, body: { error: 'boom' } }));
  await withEnv({ CXTRUST_RD_URL: mock.url, CXTRUST_RD_KEY: 'rd-key' }, async () => {
    const res = await new RealityDefenderStyleProvider().analyze({ contactId: 'c-5' });
    assert.equal(res.degraded, true);
    assert.ok((res.degradedReason ?? '').includes('HTTP 500'));
    assert.equal(res.syntheticProbability, 0);
  });
  await mock.close();
});

test('missing Reality Defender env returns degraded with credentials reason', async () => {
  await withEnv({ CXTRUST_RD_URL: undefined, CXTRUST_RD_KEY: undefined }, async () => {
    const res = await new RealityDefenderStyleProvider().analyze({ contactId: 'c-6' });
    assert.equal(res.degraded, true);
    assert.equal(res.degradedReason, CREDENTIALS_MISSING);
  });
});

class StaticProvider implements VoiceTrustProvider {
  id: string;
  private result: VoiceTrustResult;
  constructor(id: string, result: VoiceTrustResult) {
    this.id = id;
    this.result = result;
  }
  async analyze(): Promise<VoiceTrustResult> { return this.result; }
}

test('EnsembleVoiceTrustProvider: healthy + degraded -> fused score with degraded flag', async () => {
  const healthy = new StaticProvider('p-good', {
    syntheticProbability: 0.8, replayProbability: 0.2, impersonationProbability: 0.1,
    evidence: [{ kind: 'audio_signal', text: 'spectral cue', locator: 'l' }], providerId: 'p-good',
  });
  const degraded = new StaticProvider('p-bad', {
    syntheticProbability: 0, replayProbability: 0, impersonationProbability: 0,
    evidence: [], providerId: 'p-bad', degraded: true, degradedReason: CREDENTIALS_MISSING,
  });
  const res = await new EnsembleVoiceTrustProvider([healthy, degraded]).analyze({ contactId: 'c-7' });
  // degraded provider (all zeros) must NOT drag the mean: equal weights on 1 healthy
  assert.equal(res.syntheticProbability, 0.8);
  assert.equal(res.replayProbability, 0.2);
  assert.equal(res.impersonationProbability, 0.1);
  assert.equal(res.degraded, true);
  assert.ok((res.degradedReason ?? '').includes('p-bad'));
  assert.ok((res.degradedReason ?? '').includes(CREDENTIALS_MISSING));
  assert.ok(res.evidence[0].text.startsWith('[p-good]'));
});

test('EnsembleVoiceTrustProvider: all degraded -> degraded, zeros, no fabricated mean', async () => {
  const a = new StaticProvider('a', {
    syntheticProbability: 0, replayProbability: 0, impersonationProbability: 0,
    evidence: [], providerId: 'a', degraded: true, degradedReason: 'down',
  });
  const b = new StaticProvider('b', {
    syntheticProbability: 0, replayProbability: 0, impersonationProbability: 0,
    evidence: [], providerId: 'b', degraded: true, degradedReason: 'down too',
  });
  const res = await new EnsembleVoiceTrustProvider([a, b]).analyze({ contactId: 'c-8' });
  assert.equal(res.degraded, true);
  assert.ok((res.degradedReason ?? '').includes('a: down'));
  assert.ok((res.degradedReason ?? '').includes('b: down too'));
  assert.equal(res.syntheticProbability, 0);
});

test('EnsembleVoiceTrustProvider: weights respected', async () => {
  const a = new StaticProvider('a', {
    syntheticProbability: 0.2, replayProbability: 0.4, impersonationProbability: 0.6,
    evidence: [], providerId: 'a',
  });
  const b = new StaticProvider('b', {
    syntheticProbability: 1.0, replayProbability: 0.0, impersonationProbability: 0.0,
    evidence: [], providerId: 'b',
  });
  const res = await new EnsembleVoiceTrustProvider([a, b], { a: 1, b: 3 }).analyze({ contactId: 'c-9' });
  assert.ok(Math.abs(res.syntheticProbability - (0.2 * 1 + 1.0 * 3) / 4) < 1e-12);
  assert.ok(Math.abs(res.replayProbability - (0.4 * 1 + 0.0 * 3) / 4) < 1e-12);
  assert.ok(Math.abs(res.impersonationProbability - (0.6 * 1 + 0.0 * 3) / 4) < 1e-12);
  assert.equal(res.degraded, undefined);
});

test('WrappedVoiceTrustAnalyzer caches last result per contactId (first call zeros until refresh)', async () => {
  const provider = new StaticProvider('cache-prov', {
    syntheticProbability: 0.66, replayProbability: 0.33, impersonationProbability: 0.11,
    evidence: [], providerId: 'cache-prov',
  });
  const analyzer = new WrappedVoiceTrustAnalyzer(provider);
  const first = analyzer.analyze({ contactId: 'contact-A', customerPhoneNumber: '+1' });
  assert.equal(first.syntheticProbability, 0); // cache miss: zeros served immediately
  await new Promise((r) => setTimeout(r, 50)); // background refresh lands
  const second = analyzer.analyze({ contactId: 'contact-A' });
  assert.equal(second.syntheticProbability, 0.66);
  assert.equal(second.replayProbability, 0.33);
  assert.equal(second.impersonationProbability, 0.11);
  // per-contact isolation
  const other = analyzer.analyze({ contactId: 'contact-B' });
  assert.equal(other.syntheticProbability, 0);
  await new Promise((r) => setTimeout(r, 50));
  const other2 = analyzer.analyze({ contactId: 'contact-B', customerPhoneNumber: '+2' });
  assert.equal(other2.impersonationProbability, 0.11);
});

test('toVoiceAnalyzer returns a WrappedVoiceTrustAnalyzer for the provider', async () => {
  const provider = new StaticProvider('tv-prov', {
    syntheticProbability: 0.5, replayProbability: 0.5, impersonationProbability: 0.5,
    evidence: [], providerId: 'tv-prov',
  });
  const a = toVoiceAnalyzer(provider);
  assert.ok(a instanceof WrappedVoiceTrustAnalyzer);
  assert.equal(a.id, 'wrapped:tv-prov');
  assert.equal(a.analyze({ contactId: 'x' }).syntheticProbability, 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.analyze({ contactId: 'x' }).syntheticProbability, 0.5);
});
