// Conversation intelligence over the API: summary from a stored interaction,
// cross-conversation search.

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

test('summary endpoint: extractive summary over a persisted interaction', async () => {
  const start = await req('POST', '/v1/interactions', { organizationId: 'org-ci' });
  const id = String(start.json.interactionId);
  await req('POST', `/v1/interactions/${id}/participant`, {
    participantId: 'cust', interactionId: id, organizationId: 'org-ci',
    kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.5,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  await req('POST', `/v1/interactions/${id}/turns`, { participantId: 'cust', text: 'I need a refund for the duplicated charge, this is frustrating.', offsetS: 2 });
  await req('POST', `/v1/interactions/${id}/turns`, { participantId: 'agent', text: 'Let me check your purchase history. I will issue the refund now.', offsetS: 12 });
  await req('POST', `/v1/interactions/${id}/end`, {});

  const r = await req('GET', `/v1/interactions/${id}/summary`);
  assert.equal(r.status, 200);
  const summary = r.json.summary as { topics: { topic: string }[]; actionItems: unknown[]; digest: string; turns: number };
  assert.equal(summary.turns, 2);
  assert.ok(summary.topics.some(t => t.topic === 'refund'));
  assert.ok(summary.digest.includes('cust'));
});

test('search endpoint: cross-conversation lexical search', async () => {
  const noQ = await req('GET', '/v1/search');
  assert.equal(noQ.status, 400);
  const r = await req('GET', '/v1/search?q=refund%20duplicated');
  assert.equal(r.status, 200);
  const hits = r.json.hits as { interactionId: string; excerpt: string }[];
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].excerpt.length > 0);
});