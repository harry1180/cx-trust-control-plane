import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TrustNetworkNode, validateSignal, validateSignals, sanitizeOutbound, lookupFingerprint, type TrustSignal } from '../src/index.ts';
import { createApi } from '@cxtrust/server';
import { SqliteStore } from '@cxtrust/server/src/store.ts';
function sig(overrides: Partial<TrustSignal> = {}): TrustSignal {
  return {
    signalId: `sig-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'MALICIOUS_AGENT',
    organizationId: 'org-a',
    createdAt: new Date().toISOString(),
    severity: 0.9,
    fingerprint: 'sha256:abc123',
    description: 'test signal',
    confidence: 0.8,
    ...overrides,
  };
}

// ---------- privacy validator ----------

test('privacy validator rejects raw phone in fingerprint', () => {
  const r = validateSignal(sig({ fingerprint: '+15551234567' }));
  assert.equal(r.ok, false);
  const r2 = validateSignal(sig({ fingerprint: '555-123-4567' }));
  assert.equal(r2.ok, false);
});

test('privacy validator rejects raw email in fingerprint', () => {
  const r = validateSignal(sig({ fingerprint: 'victim@example.com' }));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /email/i);
});

test('privacy validator rejects >64-char free text in fingerprint', () => {
  const long = 'x'.repeat(65);
  const r = validateSignal(sig({ fingerprint: long }));
  assert.equal(r.ok, false);
  const r3 = validateSignal(sig({ fingerprint: 'a b c: free text transcript of the call' }));
  assert.equal(r3.ok, false);
});

test('privacy validator accepts hash-like fingerprints', () => {
  assert.equal(validateSignal(sig()).ok, true);
  assert.equal(validateSignal(sig({ fingerprint: 'a1b2c3d4e5f6' })).ok, true);
});

test('validateSignals splits accepted/rejected', () => {
  const { accepted, rejected } = validateSignals([sig(), sig({ fingerprint: 'jane@corp.io' })]);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
});

// ---------- in-test mock partner servers ----------

function mockPartnerServer(orgId: string, partnerSignals: TrustSignal[]) {
  const received: unknown[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      received.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ signals: partnerSignals }));
    });
  });
  return { server, received };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

// ---------- two-org sync + dedupe ----------

test('two org nodes sync and dedupe by signalId', async () => {
  const shared: TrustSignal = sig({ organizationId: 'org-a', fingerprint: 'fp-shared-1' });
  const a = new TrustNetworkNode('org-a', [shared]);
  const partnerB = sig({ organizationId: 'org-b', signalId: 'sig-b-1', fingerprint: 'fp-b-1' });

  const { server, received } = mockPartnerServer('org-b', [shared, partnerB]);
  const url = await listen(server);
  process.env.TRUSTNET_TEST_TOKEN = 'tok-b';
  const res = await a.exchange([{ organizationId: 'org-b', endpoint: url, apiTokenEnv: 'TRUSTNET_TEST_TOKEN', trustScore: 0.9 }]);
  server.close();

  assert.equal(res.outcomes[0]!.ok, true);
  assert.ok((received[0] as { signals: TrustSignal[] }).signals.some(s => s.signalId === shared.signalId));
  // dedupe: shared signal counted once, partner's new signal pulled
  const ids = res.signals.map(s => s.signalId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(res.signals.some(s => s.signalId === 'sig-b-1'));
});

test('outbound sync strips signals failing the privacy validator', async () => {
  const node = new TrustNetworkNode('org-a');
  node.ingest([sig({ signalId: 'good', fingerprint: 'fp-ok' })]);
  const { clean, stripped } = sanitizeOutbound([
    ...node.listSignals(),
    sig({ signalId: 'bad', fingerprint: ' leaked transcript '.repeat(5) }),
  ] as TrustSignal[]);
  assert.equal(stripped, 1);
  assert.equal(clean.length, 1);
});

test('sync failures are recorded, never thrown (loop stays alive)', async () => {
  const a = new TrustNetworkNode('org-a', [sig({ fingerprint: 'fp-x' })]);
  process.env.TRUSTNET_TEST_TOKEN2 = 'tok';
  const res = await a.exchange([
    { organizationId: 'org-down', endpoint: 'http://127.0.0.1:1', apiTokenEnv: 'TRUSTNET_TEST_TOKEN2' },
    { organizationId: 'org-noenv', endpoint: 'http://127.0.0.1:1', apiTokenEnv: 'TRUSTNET_MISSING_ENV' },
  ]);
  assert.equal(res.outcomes.length, 2);
  assert.equal(res.outcomes.every(o => !o.ok && o.error), true);
  assert.equal(a.syncLog.length, 2);
  assert.equal(res.signals.length, 1); // local signal intact
});

// ---------- federation / reputation ----------

test('reputation score decays with age and weights by partner trust', () => {
  const now = Date.now();
  const freshHighTrust = sig({
    signalId: 's1', organizationId: 'trusted-org', fingerprint: 'fp-r',
    createdAt: new Date(now).toISOString(), severity: 0.9, confidence: 1.0,
  });
  const oldLowTrust = sig({
    signalId: 's2', organizationId: 'unknown-org', fingerprint: 'fp-r',
    createdAt: new Date(now - 100 * 86_400_000).toISOString(), severity: 0.9, confidence: 1.0,
  });
  const withTrusted = lookupFingerprint('fp-r', [freshHighTrust], [{ organizationId: 'trusted-org', trustScore: 1 }]);
  const withDistrusted = lookupFingerprint('fp-r', [freshHighTrust], [{ organizationId: 'trusted-org', trustScore: 0.1 }]);
  assert.ok(withTrusted.score > withDistrusted.score);
  assert.ok(withTrusted.score > 0.8);

  const decayed = lookupFingerprint('fp-r', [oldLowTrust], [{ organizationId: 'unknown-org', trustScore: 1 }]);
  assert.ok(decayed.score < 0.35); // 0.9^100 ≈ tiny
  assert.equal(decayed.firstSeen, oldLowTrust.createdAt);
  assert.deepEqual(decayed.sources, ['unknown-org']);
});

test('malicious fingerprint from partner org surfaces in local lookup', async () => {
  const malicious: TrustSignal = sig({
    signalId: 'sig-evil', organizationId: 'org-evil', fingerprint: 'fp-evil-123',
    kind: 'MALICIOUS_AGENT', severity: 1, confidence: 1,
  });
  const { server } = mockPartnerServer('org-evil', [malicious]);
  const url = await listen(server);
  process.env.TRUSTNET_TEST_TOKEN3 = 'tok';
  const local = new TrustNetworkNode('org-local');
  const res = await local.exchange([{ organizationId: 'org-evil', endpoint: url, apiTokenEnv: 'TRUSTNET_TEST_TOKEN3', trustScore: 0.9 }]);
  server.close();
  const rep = lookupFingerprint('fp-evil-123', res.signals, [{ organizationId: 'org-evil', trustScore: 0.9 }]);
  assert.ok(rep.score > 0.5);
  assert.deepEqual(rep.sources, ['org-evil']);
});

// ---------- e2e via server ----------

let srv: Server;
let base = '';
let envSave: Record<string, string | undefined>;

test.before(async () => {
  envSave = { ...process.env };
  process.env.CXTRUST_TRUSTNET = 'on';
  process.env.CXTRUST_ADMIN_TOKENS = 'admin-tok';
  process.env.CXTRUST_ORG_TOKENS = 'org-a-tok:org-a:SERVICE,org-b-tok:org-b:SERVICE,org-analyst:org-a:SECURITY_ANALYST';
  srv = createApi({ port: 0, store: new SqliteStore(':memory:'), rbac: { adminTokens: ['admin-tok'], orgTokens: ['org-a-tok:org-a:SERVICE', 'org-b-tok:org-b:SERVICE', 'org-analyst:org-a:SECURITY_ANALYST'] } });
  await new Promise<void>(resolve => srv.listen(0, () => resolve()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

test.after(() => {
  srv.close();
  srv.closeAllConnections();
  for (const k of Object.keys(process.env)) {
    if (k in envSave) process.env[k] = envSave[k];
  }
});

async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-api-key': token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('e2e: POST /v1/trustnet/sync with token → reputation lookup works', async () => {
  const r = await req('POST', '/v1/trustnet/sync', {
    organizationId: 'org-a',
    signals: [
      sig({ signalId: 'srv-sig-1', organizationId: 'org-a', fingerprint: 'fp-server-1', severity: 1, confidence: 1 }),
      sig({ signalId: 'srv-sig-2', organizationId: 'org-a', fingerprint: 'fp-server-1', severity: 1, confidence: 1 }),
    ],
  }, 'org-a-tok');
  assert.equal(r.status, 200);
  assert.equal(r.json.accepted, 2);
  const rep = await req('GET', '/v1/trustnet/reputation/fp-server-1', undefined, 'admin-tok');
  assert.equal(rep.status, 200);
  assert.ok(Number(rep.json.score) > 0.5);
  assert.ok((rep.json.sources as string[]).includes('org-a'));
});

test('e2e: org-forced sync — SERVICE token cannot sync as another org', async () => {
  const r = await req('POST', '/v1/trustnet/sync', {
    organizationId: 'org-b',
    signals: [sig({ fingerprint: 'fp-forced' })],
  }, 'org-a-tok');
  assert.equal(r.status, 403);
});

test('auth: cross-org sync rejected for wrong role', async () => {
  const r = await req('POST', '/v1/trustnet/sync', {
    organizationId: 'org-a',
    signals: [sig({ fingerprint: 'fp-role' })],
  }, 'org-analyst');
  assert.equal(r.status, 403);
});

test('trustnet routes are 404 when CXTRUST_TRUSTNET is off (auth-off mode unchanged)', async () => {
  // Module-level node is resolved once; spawn a child test server with the env off.
  process.env.CXTRUST_TRUSTNET = 'off';
  const s2 = createApi({ port: 0, store: new SqliteStore(':memory:'), rbac: { adminTokens: [], orgTokens: [] } });
  await new Promise<void>(resolve => s2.listen(0, () => resolve()));
  const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
  const res = await fetch(`${b2}/v1/trustnet/reputation/x`);
  assert.equal(res.status, 404);
  // Existing routes still work with auth off.
  const h = await fetch(`${b2}/healthz`);
  assert.equal(h.status, 200);
  s2.close();
  s2.closeAllConnections();
});
