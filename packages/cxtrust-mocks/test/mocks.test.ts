// Mock connectors: LiveKit (8806) + Pipecat (8807) demo entrypoints + server tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveMockAdapter, MockConnectorAdapter } from '../src/index.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const mockOpts = {
  key: 'livekit', port: 0, platform: 'livekit', label: 'LiveKit Mock',
  secretEnv: 'CXTRUST_TEST_MOCK_SECRET',
};

test('MockConnectorAdapter: health reflects degraded mode honestly', () => {
  const a = new MockConnectorAdapter({ key: 'livekit', port: 0, platform: 'livekit', label: 'LiveKit Mock' });
  const h = a.health as { mode: string; degraded: boolean };
  assert.match(h.mode, /MOCK/);
  assert.equal(h.degraded, true); // no secret env set
});

test('mock adapter demo: scripted conversation runs through governance (needs API up)', async () => {
  // Point at the governance API if reachable; otherwise SKIP honestly.
  const base = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
  let reachable = false;
  try { await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) }); reachable = true; } catch { /* offline */ }
  if (!reachable) { console.log('skipping demo test (API offline)'); return; }

  const server: Server = serveMockAdapter({ key: 'livekit', port: 0, platform: 'livekit', label: 'LiveKit Mock' });
  await new Promise<void>(r => server.listen(0, () => r()));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/livekit/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script: 'livekit' }) });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; interactionId: string; platform: string };
  assert.equal(body.ok, true);
  assert.equal(body.platform, 'livekit');
  assert.match(body.interactionId, /^INT-/);
  server.close();
});

test('mock adapter: bad signature rejected when secret configured', async () => {
  process.env.CXTRUST_TEST_MOCK_SECRET = 'test-secret-123456';
  const server: Server = serveMockAdapter({ key: 'pipecat', port: 0, platform: 'pipecat', label: 'Pipecat Mock', secretEnv: 'CXTRUST_TEST_MOCK_SECRET' });
  await new Promise<void>(r => server.listen(0, () => r()));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/pipecat/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef' },
    body: JSON.stringify({ event: 'room_started' }),
  });
  assert.equal(res.status, 401);
  server.close();
  delete process.env.CXTRUST_TEST_MOCK_SECRET;
});

test('mock adapter entrypoints: two servers boot (livekit 8806, pipecat 8807)', async () => {
  const s1 = serveMockAdapter({ key: 'livekit', port: 8806, platform: 'livekit', label: 'LiveKit Mock' });
  const s2 = serveMockAdapter({ key: 'pipecat', port: 8807, platform: 'pipecat', label: 'Pipecat Mock' });
  await Promise.all([
    new Promise<void>(r => s1.listen(8806, () => r())),
    new Promise<void>(r => s2.listen(8807, () => r())),
  ]);
  const h1 = await fetch('http://127.0.0.1:8806/healthz');
  const h2 = await fetch('http://127.0.0.1:8807/healthz');
  const j2 = await h2.json() as { platform: string };
  assert.equal(h1.status, 200);
  assert.equal(j2.platform, 'pipecat');
  s1.close(); s2.close();
});