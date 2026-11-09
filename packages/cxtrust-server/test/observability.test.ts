// /v1/observability: cross-session latency aggregation + flags + mode.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base = '';

test.before(async () => {
  server = createApi({ port: 0, store: new SqliteStore(':memory:') });
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

test('observability aggregates stage latency after governed activity', async () => {
  const start = await req('POST', '/v1/interactions', { organizationId: 'org-obs' });
  const id = String(start.json.interactionId);
  await req('POST', `/v1/interactions/${id}/participant`, {
    participantId: 'p', interactionId: id, organizationId: 'org-obs',
    kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.5,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  await req('POST', `/v1/interactions/${id}/turns`, {
    participantId: 'p', text: 'what is my balance', offsetS: 1,
  });
  const obs = await req('GET', '/v1/observability');
  assert.equal(obs.status, 200);
  assert.ok(Number(obs.json.liveSessions) >= 1);
  assert.ok(Number(obs.json.spanCount) >= 2);
  const latency = obs.json.latency as Record<string, { p50: number; count: number }>;
  assert.ok(latency.DETECT?.count >= 1);
  assert.ok(latency.POLICY?.count >= 1);
  const flags = obs.json.flags as { name: string; enabled: boolean; source: string }[];
  assert.ok(flags.length >= 10);
  assert.ok(['shadow', 'enforce'].includes(String(obs.json.governanceMode)));
});