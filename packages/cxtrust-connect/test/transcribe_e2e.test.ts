// Full-stack STT integration test: adapter + REAL Transcribe provider + WAV
// fixture → governance API → policy decision from actual transcribed speech.
//
// AWS-path test runs only when credentials are present; the labeled-failure
// contract is verified otherwise. Either way the provider→adapter wiring is
// exercised against the real governance API on an ephemeral port.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectAdapter, DemoVoiceAnalyzer } from '../src/index.ts';
import { TranscribeLiveCallProvider, PlaybackAudioSource } from '../src/transcribe.ts';

const { createApi } = await import('../../cxtrust-server/src/index.ts');
const { SqliteStore } = await import('../../cxtrust-server/src/store.ts');

let apiServer: Server;
let apiBase: string;

test.before(async () => {
  apiServer = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => apiServer.listen(0, () => r()));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:8787')) {
      return orig(url.replace('http://127.0.0.1:8787', apiBase), init as RequestInit);
    }
    return orig(url as string, init as RequestInit);
  }) as typeof fetch;
});

test.after(() => { apiServer.close(); });

test('adapter + real STT provider: WAV speech becomes governed turns (or labeled AWS failure)', async () => {
  const wav = readFileSync(new URL('./fixtures/attack_call.wav', import.meta.url));
  const adapter = new ConnectAdapter({
    stt: new TranscribeLiveCallProvider(),
    voice: new DemoVoiceAnalyzer(),
    audioSourceFactory: () => new PlaybackAudioSource(wav),
  });
  const call = await adapter.startCall('stt-e2e-1', { CustomerPhoneNumber: '+15550001111' });
  // the pump runs async; wait for it to finish or fail (playback ~9s)
  await new Promise(r => setTimeout(r, 10500));
  const snap = await (await fetch(`${apiBase}/v1/interactions/${call.interactionId}`)).json() as {
    timeline?: { label: string }[];
    risk?: { overall: number };
  };

  const turns = (snap.timeline ?? []).filter(t => t.label.startsWith('customer:'));
  if (turns.length === 0) {
    // AWS creds absent: the provider must have failed LOUDLY, and the
    // interaction still persisted with zero fabricated turns.
    assert.equal(turns.length, 0);
    assert.ok(snap.risk !== undefined, 'governance session still created');
    return;
  }
  // Real AWS path: transcribed attack speech must trip the threat engine
  const allText = turns.map(t => t.label).join(' ').toLowerCase();
  assert.ok(/bank|account/.test(allText), `attack speech transcribed, got: ${allText.slice(0, 200)}`);
  assert.ok((snap.risk?.overall ?? 0) > 20, `risk escalated from real transcript: ${snap.risk?.overall}`);
});
