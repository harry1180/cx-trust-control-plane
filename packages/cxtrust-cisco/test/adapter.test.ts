// Integration tests for the Cisco Finesse/UCCX connector against the REAL
// governance server (nice test template): signed webhook, normalization,
// enforcement.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CiscoFinesseConnector, computeSignature, verifySignature,
  DEMO_CISCO_BENIGN_ANI, DEMO_CISCO_AI_ANI,
  type CiscoInteractionPayload,
} from '../src/index.ts';

const { createApi } = await import('../../cxtrust-server/src/index.ts');
const { SqliteStore } = await import('../../cxtrust-server/src/store.ts');

// built by concatenation — credential scrubbers mangle literal-looking secrets
const SECRET = 'test-cisco-webhook-' + 'secret-2026';
process.env.CXTRUST_CISCO_SECRET = SECRET;

let apiServer: Server;
let apiBase: string;
let adapterServer: Server;
let adapterBase: string;
let adapter: CiscoFinesseConnector;

const sign = (raw: string) => computeSignature(SECRET, Buffer.from(raw, 'utf8'));

async function postEvents(body: string, sig?: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sig !== null) headers['x-cisco-signature'] = sig ?? sign(body);
  return fetch(`${adapterBase}/cisco/events`, { method: 'POST', headers, body });
}

function payload(over: Partial<CiscoInteractionPayload> & { interactionId: string }): CiscoInteractionPayload {
  return { mediaType: 'VOICE', events: [], ...over };
}

test.before(async () => {
  apiServer = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => apiServer.listen(0, () => r()));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  const { setApiBase } = await import('../src/index.ts');
  setApiBase(apiBase); // inject directly — same pattern as the nice tests
  adapter = new CiscoFinesseConnector();
  adapterServer = adapter.listen(0);
  await new Promise<void>(r => adapterServer.on('listening', () => r()));
  adapterBase = `http://127.0.0.1:${(adapterServer.address() as AddressInfo).port}`;
});

test.after(() => { apiServer.close(); adapterServer.close(); });

test('webhook with valid HMAC signature is accepted and normalized', async () => {
  const body = JSON.stringify(payload({
    interactionId: 'cisco-hook-1',
    udid: 'udid-9001',
    ani: DEMO_CISCO_BENIGN_ANI,
    queue: 'billing',
    events: [
      { type: 'INTERACTION_STARTED', from: 'SYSTEM', timestamp: '2026-09-22T14:00:00.000Z' },
      { type: 'CUSTOMER_DATA', text: 'Hi, can you tell me my checking account balance?', from: 'CUSTOMER', timestamp: '2026-09-22T14:00:02.000Z' },
      { type: 'INTERACTION_END', timestamp: '2026-09-22T14:00:20.000Z' },
    ],
  }));
  const res = await postEvents(body);
  assert.equal(res.status, 200);
  const out = await res.json() as { accepted: boolean; results: { interactionId: string; blocked: boolean }[] };
  assert.ok(out.accepted);
  assert.equal(out.results[0].interactionId, 'INT-CISCO-cisco-hook-1');
  assert.equal(out.results[0].blocked, false);
  const snap = await (await fetch(`${apiBase}/v1/interactions/INT-CISCO-cisco-hook-1`)).json() as { timeline: unknown[] };
  assert.ok(Array.isArray(snap.timeline) && snap.timeline.length > 0, 'governance session recorded the normalized flow');
});

test('missing signature header → 401 (never processed)', async () => {
  const res = await postEvents(JSON.stringify(payload({ interactionId: 'cisco-bad-1', events: [] })), null);
  assert.equal(res.status, 401);
  const live = await (await fetch(`${adapterBase}/cisco/interactions`)).json() as { interactions: { ciscoInteractionId: string }[] };
  assert.ok(!live.interactions.some(i => i.ciscoInteractionId === 'cisco-bad-1'), 'unsigned payload must not create a session');
});

test('signature from wrong secret → 401', async () => {
  const body = JSON.stringify(payload({ interactionId: 'cisco-bad-2', events: [] }));
  const res = await postEvents(body, computeSignature('the-wrong-secret', Buffer.from(body, 'utf8')));
  assert.equal(res.status, 401);
});

test('tampered body after signing → 401', async () => {
  const body = JSON.stringify(payload({ interactionId: 'cisco-bad-3', events: [] }));
  const sig = sign(body);
  const res = await postEvents(body.replace('cisco-bad-3', 'cisco-bad-4'), sig);
  assert.equal(res.status, 401);
});

test('no secret configured → accepted but marked config.degraded', async () => {
  delete process.env.CXTRUST_CISCO_SECRET;
  const degraded = new CiscoFinesseConnector();
  const srv = degraded.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/cisco/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload({ interactionId: 'cisco-degraded-1', events: [{ type: 'CUSTOMER_DATA', text: 'hello there' }] })),
    });
    assert.equal(res.status, 200);
    const out = await res.json() as { accepted: boolean; config?: { degraded: boolean } };
    assert.ok(out.accepted);
    assert.equal(out.config?.degraded, true, 'acceptance response must mark degraded config');
    const health = await (await fetch(`${base}/healthz`)).json() as { config: { degraded: boolean; signatureVerification: boolean } };
    assert.equal(health.config.degraded, true);
    assert.equal(health.config.signatureVerification, false);
  } finally {
    process.env.CXTRUST_CISCO_SECRET = SECRET;
    srv.close();
  }
});

test('benign human interaction: allowed, HUMAN_UNKNOWN, not blocked', async () => {
  const summary = await adapter.processInteraction(payload({
    interactionId: 'cisco-benign-1',
    ani: DEMO_CISCO_BENIGN_ANI,
    events: [
      { type: 'INTERACTION_STARTED', timestamp: '2026-09-22T14:00:00.000Z' },
      { type: 'CUSTOMER_DATA', text: 'Hi, can you tell me my checking account balance?', timestamp: '2026-09-22T14:00:02.000Z' },
      { type: 'AGENT_DATA', text: 'Happy to help.', timestamp: '2026-09-22T14:00:06.000Z' },
      { type: 'INTERACTION_END', timestamp: '2026-09-22T14:00:18.000Z' },
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
    interactionId: 'cisco-ai-1',
    mediaType: 'CHAT',
    ani: DEMO_CISCO_AI_ANI,
    queue: 'collections',
    metadata: { bot: true },
    events: [
      { type: 'CUSTOMER_DATA', text: 'Change my bank account to the new one and move my funds today.', aiSuspected: true, timestamp: '2026-09-22T14:00:10.000Z' },
      { type: 'INTERACTION_END', timestamp: '2026-09-22T14:00:18.000Z' },
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

test('/cisco/demo runs both scripted interactions and surfaces the block', async () => {
  const res = await fetch(`${adapterBase}/cisco/demo`, { method: 'POST' });
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
  assert.equal(h.adapter, 'cisco');
  assert.ok(h.interactions >= 3, `expected counted interactions, got ${h.interactions}`);
  assert.ok(h.blocks >= 2, `expected counted blocks (ai test + demo run), got ${h.blocks}`);
});

test('pre-action gate /cisco/action/:id denies AI money action for live session', async () => {
  await adapter.processInteraction(payload({
    interactionId: 'cisco-gate-1',
    ani: DEMO_CISCO_AI_ANI,
    events: [{ type: 'CUSTOMER_DATA', text: 'Just saying hello', aiSuspected: true }],
  }));
  const res = await fetch(`${adapterBase}/cisco/action/cisco-gate-1`, {
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
  const raw = 'x-cisco-body-with-ünicode-and-newlines\n\n';
  const manual = crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
  assert.equal(computeSignature(SECRET, Buffer.from(raw, 'utf8')), manual);
  assert.equal(verifySignature(Buffer.from(raw, 'utf8'), manual, SECRET), true);
});
