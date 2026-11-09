import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectAdapter, ScriptedCallTranscriber, DemoVoiceAnalyzer, SPOOF_NUMBERS, validateAwsCredentialFormat } from '../src/index.ts';
import { WebSocket } from 'ws';

// --- spin up a minimal in-test governance API stub? No — use the REAL server.
// We start the real @cxtrust/server on an ephemeral port.
const { createApi } = await import('../../cxtrust-server/src/index.ts');
const { SqliteStore } = await import('../../cxtrust-server/src/store.ts');

let apiServer: ReturnType<typeof createServer>;
let apiBase = '';
let adapterServer: ReturnType<typeof createServer>;
let adapterBase = '';

test.before(async () => {
  apiServer = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => apiServer.listen(0, r));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

  // point adapter at the test API
  process.env.CXTRUST_API_URL = apiBase;
  // module already captured API_BASE at import; patch via rebuild
  const adapter = new TestableAdapter();
  adapterServer = adapter.listen(0);
  await new Promise<void>(r => adapterServer.on('listening', r));
  adapterBase = `http://127.0.0.1:${(adapterServer.address() as AddressInfo).port}`;
});

test.after(() => { apiServer.close(); adapterServer.close(); });

// wrapper to override API base after import
class TestableAdapter extends ConnectAdapter {
  constructor() {
    super({ stt: new ScriptedCallTranscriber(), voice: new DemoVoiceAnalyzer() });
    // re-wire fetch target: ConnectAdapter reads API base at module import
    // (default :8787), so we monkeypatch global fetch and redirect those
    // calls to the test API instance.
    const orig = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:8787')) {
        return orig(url.replace('http://127.0.0.1:8787', apiBase), init as RequestInit);
      }
      return orig(url as string, init as RequestInit);
    }) as typeof fetch;
  }
}

test('scripted transcriber replays spoofed-number attack call', async () => {
  const t = new ScriptedCallTranscriber();
  const turns: { text: string; speaker: string }[] = [];
  for await (const turn of t.transcribe({ contactId: 'c1', customerPhoneNumber: '+15550001111', metadata: {} })) {
    turns.push(turn);
  }
  assert.ok(turns.length >= 2);
  assert.match(turns[0].text, /recover my account/i);
  assert.ok(SPOOF_NUMBERS.has('+15550001111'));
});

test('demo analyzer flags spoofed number as synthetic', () => {
  const v = new DemoVoiceAnalyzer();
  assert.ok(v.analyze({ customerPhoneNumber: '+15550001111' }).syntheticProbability > 0.9);
  assert.ok(v.analyze({ customerPhoneNumber: '+15551234567' }).syntheticProbability < 0.1);
});

test('media stream ws start → governed call created via API', async () => {
  const ws = new WebSocket(adapterBase.replace('http', 'ws') + '/ws');
  await new Promise(r => ws.on('open', r));
  const reply = await new Promise<Record<string, unknown>>(resolve => {
    ws.on('message', d => resolve(JSON.parse(String(d))));
    ws.send(JSON.stringify({ 'msg-type': 'start', contactId: 'ws-test-1', customerPhoneNumber: '+15550001111' }));
  });
  assert.ok(reply.interactionId, 'adapter returned interactionId');
  // scripted call plays ~2 turns; wait for turns to land
  await new Promise(r => setTimeout(r, 2500));
  const snap = await (await fetch(`${apiBase}/v1/interactions/${reply.interactionId}`)).json();
  assert.ok(snap.timeline, 'governance timeline exists for the ws call');
  ws.close();
});

test('contact events webhook → CONTACT_ENDED ends session', async () => {
  const res = await fetch(`${adapterBase}/connect/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ EventType: 'CONTACT_INITIATED', ContactData: { ContactId: 'evt-1', CustomerPhoneNumber: '+15551234567' } }),
  });
  const call = await res.json() as { interactionId: string };
  assert.ok(call.interactionId);
  await new Promise(r => setTimeout(r, 1500));
  const end = await fetch(`${adapterBase}/connect/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ EventType: 'CONTACT_ENDED', ContactData: { ContactId: 'evt-1' } }),
  });
  assert.equal(end.status, 200);
});

test('checkAction blocks account change on spoofed call', async () => {
  // start a spoofed call
  const res = await fetch(`${adapterBase}/connect/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ EventType: 'CONTACT_INITIATED', ContactData: { ContactId: 'evt-2', CustomerPhoneNumber: '+15550001111' } }),
  });
  const call = await res.json() as { interactionId: string };
  // wait for first synthetic turn (voice analysis applied)
  await new Promise(r => setTimeout(r, 1200));
  const d = await (await fetch(`${adapterBase}/connect/action/evt-2`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestedAction: 'CHANGE_BANK_ACCOUNT', intent: 'CHANGE_BANK_ACCOUNT' }),
  })).json() as { decision?: { allowed: boolean; matchedRule: string } };
  assert.equal(d.decision?.allowed, false, 'spoofed synthetic caller blocked');
  assert.equal(d.decision?.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
  void call;
});

test('configure rejects malformed AWS credentials before calling AWS', async () => {
  const res = await fetch(`${adapterBase}/connect/configure`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessKeyId: 'WRONG', secretAccessKey: 'short', instanceId: '' }),
  });
  assert.equal(res.status, 400);
  const j = await res.json() as { ok?: boolean; error?: string };
  assert.equal(j.ok, false);
  assert.match(j.error ?? '', /invalid Access Key ID/);
});

test('configure status starts unconfigured', async () => {
  const res = await fetch(`${adapterBase}/connect/configure/status`);
  const j = await res.json() as { configured?: boolean };
  assert.equal(j.configured, false);
});

test('credential format: AKIA ok without token, ASIA ok with token, ASIA without token rejected', () => {
  const base = { secretAccessKey: 's'.repeat(40), instanceId: 'a1b2c3d4-0000-1111-2222-333344445555' };
  // real access key IDs are exactly 20 chars: AKIA/ASIA + 16
  assert.deepEqual(validateAwsCredentialFormat({ ...base, accessKeyId: 'AKIA' + 'A1B2C3D4E5F6G7H8' }), { ok: true });
  assert.deepEqual(
    validateAwsCredentialFormat({ ...base, accessKeyId: 'ASIA' + 'A1B2C3D4E5F6G7H8', sessionToken: 'FwoGZXIvYXdzEJrExampleSessionTokenExample' }),
    { ok: true },
  );
  // 19-char legacy shape (the old AKI + 16 regex) must NOT pass
  assert.equal(validateAwsCredentialFormat({ ...base, accessKeyId: 'AKI' + 'A1B2C3D4E5F6G7H8' }).ok, false);
  // temporary key with no session token → explicit error
  assert.deepEqual(
    validateAwsCredentialFormat({ ...base, accessKeyId: 'ASIA' + 'A1B2C3D4E5F6G7H8' }),
    { ok: false, error: 'ASIA access key requires a session token (temporary credentials)' },
  );
});

test('configure rejects ASIA key without session token before calling AWS', async () => {
  const res = await fetch(`${adapterBase}/connect/configure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessKeyId: 'ASIA' + 'ABCDEFGHIJKLMNOP', secretAccessKey: 's'.repeat(40), instanceId: 'i-0123456789abcdef0' }),
  });
  assert.equal(res.status, 400);
  const j = await res.json() as { ok?: boolean; error?: string };
  assert.equal(j.ok, false);
  assert.match(j.error ?? '', /session token/);
  assert.doesNotMatch(j.error ?? '', /AWS rejected/); // format check ran before any AWS call
});

// Raw Amazon EventBridge envelope, exactly as an API Destination POSTs it
// (source aws.connect, detail-type "Amazon Connect Contact Event").
function connectEventEnvelope(eventType: string, detail: Record<string, unknown> = {}) {
  return {
    version: '0',
    id: '35af9eb2-5dda-fafc-48f7-8a1b2c3d4e5f',
    'detail-type': 'Amazon Connect Contact Event',
    source: 'aws.connect',
    account: '111122223333',
    time: '2026-09-29T17:00:00Z',
    region: 'us-east-1',
    resources: ['arn:aws:connect:us-east-1:111122223333:instance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    detail: {
      eventType,
      channel: 'VOICE',
      instanceArn: 'arn:aws:connect:us-east-1:111122223333:instance/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      initiationTimestamp: '2026-09-29T16:59:58.000Z',
      ...detail,
    },
  };
}

async function postContactEvent(body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${adapterBase}/connect/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json() as Record<string, unknown>;
}

test('EventBridge envelope: INITIATED opens a session idempotently, DISCONNECTED closes it', async () => {
  const started = await postContactEvent(connectEventEnvelope('INITIATED', {
    contactId: 'eb-contact-1', initiationMethod: 'INBOUND',
  }));
  assert.equal(started.interactionId, 'INT-AC-eb-contact-1', 'INITIATED envelope creates a governed session');
  // at-least-once redelivery (EventBridge retries) must NOT open a second session
  const dup = await postContactEvent(connectEventEnvelope('INITIATED', {
    contactId: 'eb-contact-1', initiationMethod: 'INBOUND',
  }));
  assert.equal(dup.ignored, 'already governed');
  // outbound contact (agent/API dial) is governed the same way
  const outbound = await postContactEvent(connectEventEnvelope('CONNECTED_TO_SYSTEM', {
    contactId: 'eb-out-2', initiationMethod: 'OUTBOUND', connectedToSystemTimestamp: '2026-09-29T17:00:02.000Z',
  }));
  assert.equal(outbound.interactionId, 'INT-AC-eb-out-2', 'outbound contact opens a governed session too');
  const open = await (await fetch(`${adapterBase}/connect/calls`)).json() as { calls: { contactId: string }[] };
  assert.equal(open.calls.filter(c => c.contactId === 'eb-contact-1').length, 1);
  assert.equal(open.calls.filter(c => c.contactId === 'eb-out-2').length, 1);
  const ended = await postContactEvent(connectEventEnvelope('DISCONNECTED', {
    contactId: 'eb-contact-1', initiationMethod: 'INBOUND', disconnectTimestamp: '2026-09-29T17:01:00.000Z',
  }));
  assert.equal(ended.ended, true);
  await postContactEvent(connectEventEnvelope('DISCONNECTED', { contactId: 'eb-out-2', initiationMethod: 'OUTBOUND' }));
  const after = await (await fetch(`${adapterBase}/connect/calls`)).json() as { calls: { contactId: string }[] };
  assert.equal(after.calls.filter(c => c.contactId === 'eb-contact-1').length, 0, 'DISCONNECTED closes the session');
  assert.equal(after.calls.filter(c => c.contactId === 'eb-out-2').length, 0);
});

test('token auth: with CXTRUST_CONNECT_TOKEN set, every route except /healthz needs x-cxtrust-token', async () => {
  process.env.CXTRUST_CONNECT_TOKEN = 'test-token-abc';
  try {
    const health = await fetch(`${adapterBase}/healthz`);
    assert.equal(health.status, 200, 'healthz stays open for probes');
    const noTokenEvents = await fetch(`${adapterBase}/connect/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(noTokenEvents.status, 401, 'events rejected without token');
    const noTokenCalls = await fetch(`${adapterBase}/connect/calls`);
    assert.equal(noTokenCalls.status, 401, 'call data not readable without token');
    const badToken = await fetch(`${adapterBase}/connect/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cxtrust-token': 'wrong' }, body: '{}',
    });
    assert.equal(badToken.status, 401, 'wrong token rejected');
    const goodToken = await fetch(`${adapterBase}/connect/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cxtrust-token': 'test-token-abc' }, body: '{}',
    });
    assert.equal(goodToken.status, 200, 'correct token passes auth (then fails validation: no ContactId)');
    const j = await goodToken.json() as { error?: string };
    assert.match(j.error ?? '', /missing ContactId/);
  } finally {
    delete process.env.CXTRUST_CONNECT_TOKEN;
  }
});
