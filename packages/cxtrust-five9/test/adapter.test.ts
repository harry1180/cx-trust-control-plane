// Integration tests for the Five9 Intelligent Cloud connector against the
// REAL governance server (nice test template): signed webhook, normalization,
// enforcement.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Five9IntelligentCloudConnector, computeSignature, verifySignature,
  DEMO_FIVE9_BENIGN_ANI, DEMO_FIVE9_AI_ANI,
  type Five9InteractionPayload,
} from '../src/index.ts';

const { createApi } = await import('../../cxtrust-server/src/index.ts');
const { SqliteStore } = await import('../../cxtrust-server/src/store.ts');

const SECRET = '***' + 'five9-webhook-key';
process.env.CXTRUST_FIVE9_SECRET = SECRET;

let apiServer: Server;
let apiBase: string;
let adapterServer: Server;
let adapterBase: string;
let adapter: Five9IntelligentCloudConnector;

const sign = (raw: string) => computeSignature(SECRET, Buffer.from(raw, 'utf8'));

async function postEvents(body: string, sig?: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sig !== null) headers['x-five9-signature'] = sig ?? sign(body);
  return fetch(`${adapterBase}/five9/events`, { method: 'POST', headers, body });
}

function payload(over: Partial<Five9InteractionPayload> & { sessionId: string }): Five9InteractionPayload {
  return { mediaType: 'VOICE', events: [], ...over };
}

test.before(async () => {
  apiServer = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => apiServer.listen(0, () => r()));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  const { setApiBase } = await import('../src/index.ts');
  setApiBase(apiBase); // inject directly — same pattern as the nice tests
  adapter = new Five9IntelligentCloudConnector();
  adapterServer = adapter.listen(0);
  await new Promise<void>(r => adapterServer.on('listening', () => r()));
  adapterBase = `http://127.0.0.1:${(adapterServer.address() as AddressInfo).port}`;
});

test.after(() => { apiServer.close(); adapterServer.close(); });

test('webhook with valid HMAC signature is accepted and normalized', async () => {
  const body = JSON.stringify(payload({
    sessionId: 'five9-hook-1',
    ani: DEMO_FIVE9_BENIGN_ANI,
    customerName: 'A. Whitfield',
    events: [
      { eventType: 'CUSTOMER_TALK_DETECT', transcript: 'Hi, can you tell me my checking account balance?', timestamp: '2026-09-22T14:00:02.000Z' },
      { eventType: 'CALL_END', timestamp: '2026-09-22T14:00:20.000Z' },
    ],
  }));
  const res = await postEvents(body);
  assert.equal(res.status, 200);
  const out = await res.json() as { accepted: boolean; results: { interactionId: string; blocked: boolean }[] };
  assert.ok(out.accepted);
  assert.equal(out.results[0].interactionId, 'INT-FIVE9-five9-hook-1');
  assert.equal(out.results[0].blocked, false);
  const snap = await (await fetch(`${apiBase}/v1/interactions/INT-FIVE9-five9-hook-1`)).json() as { timeline: unknown[] };
  assert.ok(Array.isArray(snap.timeline) && snap.timeline.length > 0, 'governance session recorded the normalized flow');
});

test('missing signature header → 401 (never processed)', async () => {
  const res = await postEvents(JSON.stringify(payload({ sessionId: 'five9-bad-1', events: [] })), null);
  assert.equal(res.status, 401);
  const live = await (await fetch(`${adapterBase}/five9/interactions`)).json() as { interactions: { five9SessionId: string }[] };
  assert.ok(!live.interactions.some(i => i.five9SessionId === 'five9-bad-1'), 'unsigned payload must not create a session');
});

test('signature from wrong secret → 401', async () => {
  const body = JSON.stringify(payload({ sessionId: 'five9-bad-2', events: [] }));
  const res = await postEvents(body, computeSignature('the-wrong-secret', Buffer.from(body, 'utf8')));
  assert.equal(res.status, 401);
});

test('tampered body after signing → 401', async () => {
  const body = JSON.stringify(payload({ sessionId: 'five9-bad-3', events: [] }));
  const sig = sign(body);
  const res = await postEvents(body.replace('five9-bad-3', 'five9-bad-4'), sig);
  assert.equal(res.status, 401);
});

test('no secret configured → accepted but marked config.degraded', async () => {
  delete process.env.CXTRUST_FIVE9_SECRET;
  const degraded = new Five9IntelligentCloudConnector();
  const srv = degraded.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/five9/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload({ sessionId: 'five9-degraded-1', events: [{ eventType: 'CUSTOMER_TALK_DETECT', transcript: 'hello there' }] })),
    });
    assert.equal(res.status, 200);
    const out = await res.json() as { accepted: boolean; config?: { degraded: boolean } };
    assert.ok(out.accepted);
    assert.equal(out.config?.degraded, true, 'acceptance response must mark degraded config');
    const health = await (await fetch(`${base}/healthz`)).json() as { config: { degraded: boolean; signatureVerification: boolean } };
    assert.equal(health.config.degraded, true);
    assert.equal(health.config.signatureVerification, false);
  } finally {
    process.env.CXTRUST_FIVE9_SECRET = SECRET;
    srv.close();
  }
});

test('benign human interaction: allowed, HUMAN_UNKNOWN, not blocked', async () => {
  const summary = await adapter.processInteraction(payload({
    sessionId: 'five9-benign-1',
    ani: DEMO_FIVE9_BENIGN_ANI,
    events: [
      { eventType: 'CUSTOMER_TALK_DETECT', transcript: 'Hi, can you tell me my checking account balance?', timestamp: '2026-09-22T14:00:02.000Z' },
      { eventType: 'CALLCENTER_AGENT_TALK', transcript: 'Happy to help.', timestamp: '2026-09-22T14:00:06.000Z' },
      { eventType: 'CALL_END', timestamp: '2026-09-22T14:00:18.000Z' },
    ],
  }), 'benign-balance-voice');
  assert.equal(summary.blocked, false);
  assert.equal(summary.matchedRule, null);
  assert.equal(summary.classification, 'HUMAN_UNKNOWN');
  // ended sessions persist as { interaction, timeline } — classification shows in the join entry
  const snap = await (await fetch(`${apiBase}/v1/interactions/${summary.interactionId}`)).json() as { timeline: { label: string }[] };
  assert.ok(snap.timeline.some(t => t.label.includes('HUMAN_UNKNOWN')), 'customer stayed HUMAN_UNKNOWN');
});

test('unregistered-AI caller money action blocked by R001 (real policy engine)', async () => {
  const summary = await adapter.processInteraction(payload({
    sessionId: 'five9-ai-1',
    ani: DEMO_FIVE9_AI_ANI,
    events: [
      { eventType: 'CUSTOMER_TALK_DETECT', transcript: 'Change my bank account to the new one and move my funds today.', aiSuspected: true, timestamp: '2026-09-22T14:00:10.000Z' },
      { eventType: 'CALL_END', timestamp: '2026-09-22T14:00:18.000Z' },
    ],
  }), 'unregistered-ai-money-action');
  assert.equal(summary.blocked, true);
  assert.equal(summary.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
  assert.equal(summary.classification, 'UNKNOWN_AI');
  assert.ok(summary.risk > 0, `expected elevated risk, got ${summary.risk}`);
  // decision is persisted with DENY actions through the real server
  const decisions = await (await fetch(`${apiBase}/v1/interactions/${summary.interactionId}/decisions`)).json() as { decisions: { allowed: boolean; matchedRule: string }[] };
  const deny = decisions.decisions.find(d => d.matchedRule === 'R001_SYNTHETIC_VOICE_BLOCK');
  assert.ok(deny && deny.allowed === false);
});

test('/five9/demo runs both scripted interactions and surfaces the block', async () => {
  const res = await fetch(`${adapterBase}/five9/demo`, { method: 'POST' });
  assert.equal(res.status, 200);
  const out = await res.json() as {
    demo: boolean;
    interactions: { scenario: string; classification: string; risk: number; blocked: boolean; matchedRule: string | null }[];
    blocks: number;
  };
  assert.ok(out.demo);
  assert.equal(out.interactions.length, 2);
  const [benign, ai] = out.interactions;
  assert.equal(benign.scenario, 'benign-balance-voice');
  assert.equal(benign.blocked, false);
  assert.equal(ai.scenario, 'unregistered-ai-money-action');
  assert.equal(ai.blocked, true);
  assert.equal(ai.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
  assert.equal(ai.classification, 'UNKNOWN_AI');
  assert.ok(out.blocks >= 1);
});

test('healthz reports adapter identity + cumulative interaction/block counts', async () => {
  const h = await (await fetch(`${adapterBase}/healthz`)).json() as {
    ok: boolean; adapter: string; interactions: number; blocks: number;
  };
  assert.equal(h.ok, true);
  assert.equal(h.adapter, 'five9');
  assert.ok(h.interactions >= 3, `expected counted interactions, got ${h.interactions}`);
  assert.ok(h.blocks >= 2, `expected counted blocks (ai test + demo run), got ${h.blocks}`);
});

test('pre-action gate /five9/action/:id denies AI money action for live session', async () => {
  await adapter.processInteraction(payload({
    sessionId: 'five9-gate-1',
    ani: DEMO_FIVE9_AI_ANI,
    events: [{ eventType: 'CUSTOMER_TALK_DETECT', transcript: 'Just saying hello', aiSuspected: true }],
  }));
  const res = await fetch(`${adapterBase}/five9/action/five9-gate-1`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestedAction: 'CHANGE_BANK_ACCOUNT' }),
  });
  const d = await res.json() as { decision?: { allowed: boolean; matchedRule: string } };
  assert.equal(d.decision?.allowed, false);
  assert.equal(d.decision?.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
});

test('verifySignature unit: hex + sha256= prefix, rejects malformed/empty', () => {
  const raw = Buffer.from('{"a":1}');
  const sig = computeSignature(SECRET, raw);
  assert.equal(verifySignature(raw, sig, SECRET), true);
  assert.equal(verifySignature(raw, `sha256=${sig}`, SECRET), true);
  assert.equal(verifySignature(raw, `SHA256=${sig.toUpperCase()}`, SECRET), true);
  assert.equal(verifySignature(raw, 'deadbeef', SECRET), false);
  assert.equal(verifySignature(raw, undefined, SECRET), false);
  assert.equal(verifySignature(Buffer.from('other'), sig, SECRET), false);
  assert.equal(verifySignature(raw, sig, 'other-secret'), false);
});

test('crypto HMAC parity: node sign == verify over the exact raw bytes', () => {
  const raw = 'x-five9-body-with-ünicode-and-newlines\n\n';
  const manual = crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
  assert.equal(computeSignature(SECRET, Buffer.from(raw, 'utf8')), manual);
  assert.equal(verifySignature(Buffer.from(raw, 'utf8'), manual, SECRET), true);
});
