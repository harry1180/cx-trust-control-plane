import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApi } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base = '';
let wsBase = '';

test.before(async () => {
  const store = new SqliteStore(':memory:');
  server = createApi({ port: 0, store });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}/ws`;
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

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Frame collector: attach once, wait for the next frame matching pred.
// (Frames can arrive before the triggering HTTP response resolves, since the
// server emits deltas before persisting/responding — always attach first.)
function collector(ws: WebSocket) {
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (data: Buffer) => {
    try { frames.push(JSON.parse(String(data))); } catch { /* ignore */ }
  });
  return {
    frames,
    waitFor: (pred: (f: Record<string, unknown>) => boolean, timeoutMs = 3000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for frame (have: ${frames.map(f => f.type).join(',')})`)), timeoutMs);
        const poll = setInterval(() => {
          const f = frames.find(pred);
          if (f) { clearTimeout(timer); clearInterval(poll); resolve(f); }
        }, 10);
      }),
  };
}

test('ws: subscribed ack, snapshot deltas, decision frame, ended frame', async () => {
  const ws = await connect(wsBase);
  const c = collector(ws);
  const start = await req('POST', '/v1/interactions', { organizationId: 'org-ws' });
  assert.equal(start.status, 201);
  const id = String(start.json.interactionId);

  ws.send(JSON.stringify({ type: 'subscribe', interactionId: id }));
  const ack = await c.waitFor(f => f.type === 'subscribed');
  assert.equal(ack.interactionId, id);

  // drive: participant → voice (high synthetic) → turns → blocked action
  await req('POST', `/v1/interactions/${id}/participant`, {
    participantId: 'p-caller', interactionId: id, organizationId: 'org-ws',
    kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  const voice = await req('POST', `/v1/interactions/${id}/voice`, {
    participantId: 'p-caller', syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9,
  });
  assert.equal(voice.status, 200);
  await req('POST', `/v1/interactions/${id}/turns`, { participantId: 'p-caller', text: 'Move all my funds to a new account right now.', offsetS: 8 });

  // snapshot frames arrive with risk data
  const snapFrame = await c.waitFor(f => f.type === 'snapshot' && f.interactionId === id);
  const snap = snapFrame.snapshot as { risk: { overall: number } };
  assert.ok(snap && typeof snap.risk.overall === 'number', 'snapshot frame carries snapshot with risk.overall');

  // blocked action → decision frame (R001) + incident frame
  const decisionPromise = c.waitFor(f => f.type === 'decision' && f.interactionId === id);
  const incidentPromise = c.waitFor(f => f.type === 'incident' && f.interactionId === id);
  const act = await req('POST', `/v1/interactions/${id}/actions`, {
    requestedAction: 'CHANGE_BANK_ACCOUNT', participantId: 'p-caller', intent: 'CHANGE_BANK_ACCOUNT',
  });
  assert.equal(act.status, 200);
  const decisionFrame = await decisionPromise;
  const d = decisionFrame.decision as { allowed: boolean; matchedRule: string };
  assert.equal(d.allowed, false);
  assert.equal(d.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
  const incFrame = await incidentPromise;
  assert.ok(incFrame.incident, 'incident frame carries incident');

  // throttling: ≥4 rapid turns coalesce into ≤2 snapshot frames in a ~200ms window
  const before = c.frames.filter(f => f.type === 'snapshot').length;
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) {
    await req('POST', `/v1/interactions/${id}/turns`, { participantId: 'p-caller', text: `rapid turn ${i}`, offsetS: 10 + i });
  }
  await new Promise(r => setTimeout(r, Math.max(0, 220 - (Date.now() - t0))));
  const snapshotFrames = c.frames.filter(f => f.type === 'snapshot');
  const inWindow = snapshotFrames.length - before;
  assert.ok(inWindow <= 2, `throttling: expected ≤2 snapshot frames in 200ms window for 4 rapid turns, got ${inWindow} (coalescing, total ${snapshotFrames.length})`);
  // later snapshot reflects latest state (rising/stable risk)
  const risks = snapshotFrames.map(f => (f.snapshot as { risk: { overall: number } }).risk.overall);
  assert.ok(risks[risks.length - 1] >= risks[0], 'snapshot risk.overall is non-decreasing across frames');

  // ended frame after POST /end
  const endPromise = c.waitFor(f => f.type === 'ended' && f.interactionId === id);
  await req('POST', `/v1/interactions/${id}/end`);
  const ended = await endPromise;
  assert.ok(ended);

  ws.close();
});

test('ws: unauthorized key rejected when apiKeys configured', async () => {
  const store = new SqliteStore(':memory:');
  const s2 = createApi({ port: 0, store, apiKeys: ['k1'] });
  await new Promise<void>(r => s2.listen(0, r));
  const port = (s2.address() as AddressInfo).port;

  const rejected = await new Promise<number>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => resolve(res.statusCode));
    ws.on('error', () => { /* surfaced via unexpected-response */ });
    ws.on('open', () => resolve(0));
  });
  assert.equal(rejected, 401);

  const accepted = await connect(`ws://127.0.0.1:${port}/ws?api_key=k1`);
  assert.equal(accepted.readyState, WebSocket.OPEN);
  accepted.close();
  s2.close();
});
