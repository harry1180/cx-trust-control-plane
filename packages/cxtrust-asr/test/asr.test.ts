// ASR router tests — routing policy + sidecar integration (sidecar must be
// running on :8810; cases SKIP honestly when it is not).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsrRouter, WhisperSidecarProvider, type AsrProvider, type AsrResult } from '../src/index.ts';

function fakeProvider(id: string, realtime: boolean, ok = true): AsrProvider {
  return {
    id, supportsRealtime: realtime,
    available: async () => ok,
    transcribeWav: async () => ({ provider: id, segments: [], latencyMs: 1 }),
  };
}

test('router: realtime route prefers realtime-capable providers', async () => {
  const r = new AsrRouter();
  r.register(new WhisperSidecarProvider('http://127.0.0.1:59999')); // unreachable
  r.register(fakeProvider('cloud-stt', true));
  const p = await r.pick('realtime');
  assert.equal(p.id, 'cloud-stt');
});

test('router: offline route prefers the sidecar when healthy', async () => {
  const r = new AsrRouter();
  r.register(fakeProvider('cloud-stt', true));
  r.register(fakeProvider('faster-whisper-sidecar', false));
  const p = await r.pick('offline');
  assert.equal(p.id, 'faster-whisper-sidecar');
});

test('router: unavailable preferred provider fails LOUDLY (no silent fallback)', async () => {
  const r = new AsrRouter();
  r.register(fakeProvider('down', true, false));
  await assert.rejects(() => r.pick('realtime', { preferredProvider: 'down' }), /unavailable/);
});

test('router: no provider for a route fails with the registered list', async () => {
  const r = new AsrRouter();
  r.register(fakeProvider('sidecar-only', false));
  await assert.rejects(() => r.pick('realtime'), /no available provider for route 'realtime'.*sidecar-only/);
});

test('sidecar: transcribes a real WAV when the worker is running', async () => {
  const p = new WhisperSidecarProvider();
  if (!(await p.available())) { console.log('skipping (asr-worker not running)'); return; }
  // 16kHz mono sine WAV
  const rate = 16000, dur = 1;
  const n = rate * dur;
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 2, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  const result: AsrResult = await p.transcribeWav(data);
  assert.equal(result.provider, 'faster-whisper-sidecar');
  assert.ok(result.latencyMs > 0);
  // A pure tone transcribes to (near) nothing — the pipeline works, content is empty.
  assert.ok(Array.isArray(result.segments));
});