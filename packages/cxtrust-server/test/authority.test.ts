// Tool governance + authority verification over the live API:
// record tool calls, speak agent completion claims, see mismatches fuse into
// risk and produce an authority incident path.

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

async function newInteraction() {
  const s = await req('POST', '/v1/interactions', { organizationId: 'org-tools' });
  return String(s.json.interactionId);
}

test('tool governance gate: unauthenticated FINANCIAL tool is flagged', async () => {
  const id = await newInteraction();
  const r = await req('POST', `/v1/interactions/${id}/tools`, {
    tool: 'PAYMENT', authLevel: 'LOW', policyAllowed: true, status: 'NOT_EXECUTED', offsetS: 5,
  });
  assert.equal(r.status, 201);
  const call = r.json.toolCall as { riskCategory: string; toolCallId: string };
  assert.equal(call.riskCategory, 'FINANCIAL');
  assert.equal((r.json.gate as { ok: boolean }).ok, false); // auth floor violated
  const list = await req('GET', `/v1/interactions/${id}/tools`);
  assert.equal((list.json.toolCalls as unknown[]).length, 1);
});

test('authority mismatch: agent claims payment processed but tool failed → detection + risk', async () => {
  const id = await newInteraction();
  // 1) agent registers + speaks (agent turn with a completion claim)
  await req('POST', `/v1/interactions/${id}/participant`, {
    participantId: 'agent-1', interactionId: id, organizationId: 'org-tools',
    kind: 'AGENT', classification: 'HUMAN_VERIFIED', identityConfidence: 0.9,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  // 2) tool executed but FAILED (policy allowed, auth fine)
  await req('POST', `/v1/interactions/${id}/tools`, {
    tool: 'PAYMENT', authLevel: 'HIGH', policyAllowed: true, status: 'FAILURE',
    error: 'backend 502', offsetS: 8,
  });
  // 3) agent turn claims success
  const before = await req('GET', `/v1/interactions/${id}`);
  const riskBefore = ((before.json.risk as { overall: number })).overall;
  const turn = await req('POST', `/v1/interactions/${id}/turns`, {
    participantId: 'agent-1', kind: 'agent', text: 'Your payment has been processed.', offsetS: 10,
  });
  assert.equal(turn.status, 200);
  const authority = turn.json.authority as { claims: number; mismatches: number; verdicts: string[] };
  assert.equal(authority.claims, 1);
  assert.equal(authority.mismatches, 1);
  assert.ok(authority.verdicts[0].startsWith('PAYMENT:CLAIM_MISMATCH'));
  // risk fused upward from the mismatch detection
  const after = await req('GET', `/v1/interactions/${id}`);
  const riskAfter = ((after.json.risk as { overall: number })).overall;
  assert.ok(riskAfter > riskBefore, `risk should rise (before ${riskBefore}, after ${riskAfter})`);
});

test('authority match: tool succeeded → no mismatch detection, claim verified', async () => {
  const id = await newInteraction();
  await req('POST', `/v1/interactions/${id}/participant`, {
    participantId: 'agent-1', interactionId: id, organizationId: 'org-tools',
    kind: 'AGENT', classification: 'HUMAN_VERIFIED', identityConfidence: 0.9,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  await req('POST', `/v1/interactions/${id}/tools`, {
    tool: 'PAYMENT', authLevel: 'HIGH', policyAllowed: true, status: 'SUCCESS', offsetS: 8,
  });
  const turn = await req('POST', `/v1/interactions/${id}/turns`, {
    participantId: 'agent-1', kind: 'agent', text: 'Your payment has been processed.', offsetS: 10,
  });
  const authority = turn.json.authority as { mismatches: number; verdicts: string[] };
  assert.equal(authority.mismatches, 0);
  assert.ok(authority.verdicts[0].endsWith('CLAIM_MATCH'));
});

test('authority check off-switch: ENABLE_AUTHORITY_CHECK=false skips verification', async () => {
  process.env.ENABLE_AUTHORITY_CHECK = 'false';
  try {
    const id = await newInteraction();
    const turn = await req('POST', `/v1/interactions/${id}/turns`, {
      participantId: 'a', kind: 'agent', text: 'Your payment has been processed.', offsetS: 1,
    });
    assert.equal(turn.status, 200);
    assert.equal(turn.json.authority, undefined);
  } finally {
    delete process.env.ENABLE_AUTHORITY_CHECK;
  }
});