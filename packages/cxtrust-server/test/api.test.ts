import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base = '';

test.before(async () => {
  const store = new SqliteStore(':memory:');
  server = createApi({ port: 0, store });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => { server.close(); });

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('health and 404', async () => {
  const h = await req('GET', '/healthz');
  assert.equal(h.status, 200);
  const nf = await req('GET', '/v1/nope');
  assert.equal(nf.status, 404);
});

test('full governed interaction over the API, persisted', async () => {
  const start = await req('POST', '/v1/interactions', { organizationId: 'org-test' });
  assert.equal(start.status, 201);
  const id = String(start.json.interactionId);

  const p = await req('POST', `/v1/interactions/${id}/participant`, {
    participantId: 'p-caller', interactionId: id, organizationId: 'org-test',
    kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  assert.equal(p.status, 200);

  const v = await req('POST', `/v1/interactions/${id}/voice`, {
    participantId: 'p-caller', syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9,
  });
  assert.equal(v.status, 200);

  await req('POST', `/v1/interactions/${id}/turns`, { participantId: 'p-caller', text: 'Change my bank account and move my funds today.', offsetS: 8 });

  const act = await req('POST', `/v1/interactions/${id}/actions`, {
    requestedAction: 'CHANGE_BANK_ACCOUNT', participantId: 'p-caller', intent: 'CHANGE_BANK_ACCOUNT',
  });
  assert.equal(act.status, 200);
  const decision = act.json.decision as { allowed: boolean; matchedRule: string };
  assert.equal(decision.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
  assert.equal(decision.allowed, false);

  const ev = await req('GET', `/v1/interactions/${id}/evidence`);
  assert.equal(ev.json.chainValid, true);
  assert.ok((ev.json.evidence as unknown[]).length > 3);

  const tl = await req('GET', `/v1/interactions/${id}/timeline`);
  assert.ok((tl.json.timeline as unknown[]).length > 0);

  const inc = await req('GET', '/v1/incidents');
  assert.ok((inc.json.incidents as unknown[]).some(i => (i as { interactionId: string }).interactionId === id));

  const usage = await req('GET', '/v1/usage/org-test');
  assert.ok(Number(usage.json.governed) >= 1);
  assert.ok(Number(usage.json.blockedDecisions) >= 1);

  await req('POST', `/v1/interactions/${id}/end`);

  // persisted after session removal
  const again = await req('GET', `/v1/interactions/${id}`);
  assert.equal(again.status, 200);
  assert.ok(again.json.interaction);
});

test('scenario endpoint runs full demo through API', async () => {
  const r = await req('POST', '/v1/scenarios/prompt-injection', {});
  assert.equal(r.status, 200);
  const dets = r.json.detections as { code: string }[];
  assert.ok(dets.some(d => d.code === 'prompt_injection'));
});

test('api key enforcement', async () => {
  const store = new SqliteStore(':memory:');
  const s2 = createApi({ port: 0, store, apiKeys: ['k-test-123'] });
  await new Promise<void>(r => s2.listen(0, r));
  const port = (s2.address() as AddressInfo).port;
  const b2 = `http://127.0.0.1:${port}`;
  const no = await fetch(`${b2}/healthz`);
  assert.equal(no.status, 401);
  const yes = await fetch(`${b2}/healthz`, { headers: { 'x-api-key': 'k-test-123' } });
  assert.equal(yes.status, 200);
  s2.close();
});

test('evidence chain verifies from persisted records', async () => {
  const r = await req('POST', '/v1/scenarios/deepfake-ato', {});
  const id = (r.json.interaction as { interactionId: string }).interactionId;
  const ev = await req('GET', `/v1/interactions/${id}/evidence`);
  assert.equal(ev.json.chainValid, true);
});
