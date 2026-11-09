// Trace endpoint + shadow execution mode over the live API.

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

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

async function startInteraction() {
  const start = await req('POST', '/v1/interactions', { organizationId: 'org-trace' });
  assert.equal(start.status, 201);
  const id = String(start.json.interactionId);
  await req('POST', `/v1/interactions/${id}/participant`, {
    participantId: 'p-c', interactionId: id, organizationId: 'org-trace',
    kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  await req('POST', `/v1/interactions/${id}/voice`, {
    participantId: 'p-c', syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9,
  });
  await req('POST', `/v1/interactions/${id}/turns`, { participantId: 'p-c', text: 'Change my bank account and move my funds today.', offsetS: 8 });
  await req('POST', `/v1/interactions/${id}/actions`, {
    requestedAction: 'CHANGE_BANK_ACCOUNT', participantId: 'p-c', intent: 'CHANGE_BANK_ACCOUNT',
  });
  return id;
}

test('trace waterfall endpoint returns spans + stage latency aggregates', async () => {
  const id = await startInteraction();
  const t = await req('GET', `/v1/interactions/${id}/trace`);
  assert.equal(t.status, 200);
  const traceId = String(t.json.traceId);
  assert.match(traceId, /^[0-9a-f]{32}$/);
  const spans = t.json.spans as { stage: string; durationMs: number; traceId: string }[];
  assert.ok(spans.length >= 3);
  assert.ok(spans.some(s => s.stage === 'DETECT'));
  assert.ok(spans.some(s => s.stage === 'POLICY'));
  for (const s of spans) assert.equal(s.traceId, traceId);
  const latency = t.json.latency as Record<string, { p50: number; p95: number; p99: number; count: number }>;
  assert.ok(latency.DETECT.count >= 1);
  assert.ok(latency.POLICY.p95 >= 0);
});

test('trace endpoint 404s for an interaction with no spans, with a clear reason', async () => {
  const t = await req('GET', '/v1/interactions/INT-NEVER-EXISTED/trace');
  assert.equal(t.status, 404);
  assert.match(String(t.json.error), /no spans recorded/);
});

test('persisted interaction keeps its spans: trace works after session removal', async () => {
  const id = await startInteraction();
  await req('POST', `/v1/interactions/${id}/end`, {}); // closes + persists + evicts from memory
  const t = await req('GET', `/v1/interactions/${id}/trace`);
  assert.equal(t.status, 200);
  assert.equal(t.json.persisted, true);
  const spans = t.json.spans as unknown[];
  assert.ok(spans.length >= 3);
});
