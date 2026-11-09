import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GenesysConnector, DemoVoiceAnalyzer,
  DEMO_SPOOF_ANI, DEMO_BENIGN_ANI, DEMO_BENIGN_ANI2, DEMO_ANI3, DEMO_ANI4,
} from '../src/index.ts';
import { setApiBase } from '../src/index.ts';

const { createApi } = await import('../../cxtrust-server/src/index.ts');
const { SqliteStore } = await import('../../cxtrust-server/src/store.ts');

let apiServer: Server;
let apiBase: string;
let adapterServer: Server;
let adapterBase: string;
let adapter: GenesysConnector;

test.before(async () => {
  apiServer = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => apiServer.listen(0, () => r()));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  setApiBase(apiBase); // inject directly — no global fetch monkeypatching
  adapter = new GenesysConnector({ voice: new DemoVoiceAnalyzer() });
  adapterServer = adapter.listen(0);
  await new Promise<void>(r => adapterServer.on('listening', () => r()));
  adapterBase = `http://127.0.0.1:${(adapterServer.address() as AddressInfo).port}`;
});

test.after(() => { apiServer.close(); adapterServer.close(); });

test('webhook event creates governed interaction + participant', async () => {
  const res = await fetch(`${adapterBase}/genesys/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic: 'v2.conversations.calls',
      body: {
        conversationId: 'gc-conv-1',
        participants: [
          { participantPurpose: 'customer', ani: DEMO_BENIGN_ANI },
          { participantPurpose: 'agent' },
        ],
      },
    }),
  });
  const out = await res.json() as { started: boolean; conversationId: string };
  assert.ok(out.started);
  const snap = await (await fetch(`${apiBase}/v1/interactions/INT-GC-gc-conv-1`)).json();
  assert.ok(snap.timeline, 'governance session exists');
});

test('enforcement gate blocks synthetic caller', async () => {
  const h = await (await fetch(apiBase + '/healthz')).json();
  console.error('API_HEALTH', JSON.stringify(h));
  await fetch(`${adapterBase}/genesys/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'v2.conversations.calls', body: { conversationId: 'gc-conv-2', participants: [{ participantPurpose: 'customer', ani: DEMO_SPOOF_ANI }] } }),
  });
  const snapCheck = await (await fetch(`${apiBase}/v1/interactions/INT-GC-gc-conv-2`)).json();
  console.error('SNAP', JSON.stringify({voice: snapCheck.participants?.[0]?.riskState, cls: snapCheck.participants?.[0]?.classification}));
  const d = await (await fetch(`${adapterBase}/genesys/action/gc-conv-2`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestedAction: 'CHANGE_BANK_ACCOUNT', intent: 'CHANGE_BANK_ACCOUNT' }),
  })).json() as { decision?: { allowed: boolean; matchedRule: string } };
  assert.equal(d.decision?.allowed, false, `decision: ${JSON.stringify(d.decision)}`);
  assert.equal(d.decision?.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
});

test('benign caller action allowed', async () => {
  await fetch(`${adapterBase}/genesys/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'v2.conversations.calls', body: { conversationId: 'gc-conv-3', participants: [{ participantPurpose: 'customer', ani: DEMO_BENIGN_ANI2 }] } }),
  });
  const d = await (await fetch(`${adapterBase}/genesys/action/gc-conv-3`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestedAction: 'READ_BALANCE' }),
  })).json() as { decision?: { allowed: boolean } };
  assert.equal(d.decision?.allowed, true);
});

test('end event persists session', async () => {
  await fetch(`${adapterBase}/genesys/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'v2.conversations.call.ended', body: { conversationId: 'gc-conv-1' } }),
  });
  const stored = await (await fetch(`${apiBase}/v1/interactions/INT-GC-gc-conv-1`)).json();
  assert.ok(stored.interaction || stored.timeline, 'persisted after end');
});

test('active list reflects live conversations', async () => {
  await fetch(`${adapterBase}/genesys/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'v2.conversations.calls', body: { conversationId: 'gc-conv-4', participants: [{ participantPurpose: 'customer', ani: DEMO_ANI3 }] } }),
  });
  const active = await (await fetch(`${adapterBase}/genesys/active`)).json() as { active: { conversationId: string }[] };
  assert.ok(active.active.some(a => a.conversationId === 'gc-conv-4'));
});

test('notification WS path creates interaction', async () => {
  const { WebSocketServer } = await import('ws');
  const relay = new WebSocketServer({ port: 0 });
  const port = await new Promise<number>(r => relay.on('listening', () => r((relay.address() as AddressInfo).port)));
  const connector = new GenesysConnector({ voice: new DemoVoiceAnalyzer() });
  void connector.connectNotifications(`ws://127.0.0.1:${port}`);
  await new Promise(r => setTimeout(r, 250));
  for (const client of (relay as unknown as { clients: Set<{ send(d: string): void }> }).clients) {
    client.send(JSON.stringify({
      topic: 'v2.conversations.calls',
      eventBody: { conversationId: 'gc-ws-1', participants: [{ participantPurpose: 'customer', ani: DEMO_ANI4 }] },
    }));
  }
  await new Promise(r => setTimeout(r, 700));
  const stored = await (await fetch(`${apiBase}/v1/interactions/INT-GC-gc-ws-1`)).json();
  assert.ok(stored.timeline, 'WS notification created governed interaction');
  relay.close();
  connector.notifWs?.close?.();
});
