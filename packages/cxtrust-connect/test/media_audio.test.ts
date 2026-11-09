// Task B wiring proof: REAL media frames through the REAL /ws endpoint reach
// BOTH seams — an audio-consuming STT provider (turns from live frames) and
// the default in-house voice analyzer (scores from live audio, different for
// different audio). No scripted transcriber, no hardcoded phone list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectAdapter, type SpeechToTextProvider, type Turn } from '../src/index.ts';
import { WebSocket } from 'ws';
import { mulawEncode } from '@cxtrust/twilio';

const { createApi } = await import('../../cxtrust-server/src/index.ts');
const { SqliteStore } = await import('../../cxtrust-server/src/store.ts');

let apiServer: ReturnType<typeof createServer>;
let apiBase = '';
let adapterServer: ReturnType<typeof createServer>;
let adapterBase = '';

/** STT provider that REQUIRES the audio source and only yields once real
 *  audio bytes have flowed through it (proves the media pipeline is live). */
class AudioConsumingSTT implements SpeechToTextProvider {
  readonly id = 'test-audio-consuming-stt';
  async *transcribe(input: {
    contactId?: string; customerPhoneNumber?: string;
    audioSource?: { chunks(): AsyncIterable<Buffer> };
    metadata?: Record<string, unknown>;
  }): AsyncIterable<Turn> {
    const src = input.audioSource;
    if (!src) return;
    let bytes = 0;
    for await (const c of src.chunks()) {
      bytes += c.length;
      if (bytes >= 16000) { // ~0.5s of real audio
        yield { text: 'live audio reached the STT seam', speaker: 'CUSTOMER', offsetS: 0.5 };
        return;
      }
    }
  }
}

class MediaTestAdapter extends ConnectAdapter {
  constructor() {
    // default voice analyzer = InHouseSignalAnalyzer (the real Task B path)
    super({ stt: new AudioConsumingSTT() });
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

test.before(async () => {
  apiServer = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => apiServer.listen(0, r));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  process.env.CXTRUST_API_URL = apiBase;
  const adapter = new MediaTestAdapter();
  adapterServer = adapter.listen(0);
  await new Promise<void>(r => adapterServer.on('listening', r));
  adapterBase = `http://127.0.0.1:${(adapterServer.address() as AddressInfo).port}`;
});

test.after(() => { apiServer.close(); adapterServer.close(); });

/** 1s of audio as base64 mulaw frames (20ms each), Connect message shape. */
function mulawFrames(kind: 'sine' | 'noise'): string[] {
  const frames: string[] = [];
  const total = 8000; // 1s @8kHz
  const raw = Buffer.alloc(total * 2); // int16 samples
  for (let i = 0; i < total; i++) {
    const v = kind === 'sine'
      ? Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 8000))
      : Math.floor((Math.random() * 2 - 1) * 6000);
    raw.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  const enc = mulawEncode(raw);
  for (let i = 0; i < enc.length; i += 160) frames.push(enc.subarray(i, i + 160).toString('base64'));
  return frames;
}

async function runCall(contactId: string, kind: 'sine' | 'noise'): Promise<{ voice: { syntheticVoiceProbability: number }; transcriptHeard: boolean }> {
  const ws = new WebSocket(adapterBase.replace('http', 'ws') + '/ws');
  try {
    await new Promise(r => ws.on('open', r));
    const started = await new Promise<Record<string, unknown>>(res => {
      ws.on('message', d => res(JSON.parse(String(d))));
      ws.send(JSON.stringify({ 'msg-type': 'start', contactId }));
    });
    assert.ok(started.interactionId, 'media start creates a governed session');
    for (const chunk of mulawFrames(kind)) {
      ws.send(JSON.stringify({ 'msg-type': 'audio', chunk }));
    }
    // wait for the STT seam to yield a turn fed by real frames
    let timeline: { label?: string; kind?: string }[] = [];
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      const snap = await (await fetch(`${apiBase}/v1/interactions/${started.interactionId}`)).json() as { timeline?: { label?: string; kind?: string }[] };
      timeline = snap.timeline ?? [];
      if (timeline.some(t => (t.label ?? '').includes('live audio reached the STT seam'))) break;
    }
    const transcriptHeard = timeline.some(t => (t.label ?? '').includes('live audio reached the STT seam'));
    const snap = await (await fetch(`${apiBase}/v1/interactions/${started.interactionId}`)).json() as {
      participants?: { participantId: string; riskState?: { syntheticVoiceProbability?: number } }[];
    };
    const customer = (snap.participants ?? []).find(p => p.participantId === 'customer');
    return { voice: { syntheticVoiceProbability: customer?.riskState?.syntheticVoiceProbability ?? -1 }, transcriptHeard };
  } finally {
    // always tear down: a leaked socket keeps the test process alive
    try { ws.send(JSON.stringify({ 'msg-type': 'stop', contactId })); } catch { /* already closed */ }
    ws.close();
  }
}

test('live media frames feed STT turns AND the in-house analyzer (scores differ by audio)', async () => {
  const sineRun = await runCall('media-sine-1', 'sine');
  assert.ok(sineRun.transcriptHeard, 'turn came from live audio frames, not the scripted provider');
  assert.ok(sineRun.voice.syntheticVoiceProbability >= 0.5,
    `periodic live audio scores synthetic >= 0.5, got ${sineRun.voice.syntheticVoiceProbability}`);

  const noiseRun = await runCall('media-noise-2', 'noise');
  assert.ok(noiseRun.transcriptHeard, 'noise call also produced a live-audio turn');
  assert.ok(noiseRun.voice.syntheticVoiceProbability <= 0.15,
    `unvoiced live audio scores <= 0.15, got ${noiseRun.voice.syntheticVoiceProbability}`);
  assert.ok(sineRun.voice.syntheticVoiceProbability - noiseRun.voice.syntheticVoiceProbability >= 0.4,
    'scores are driven by the audio content, not constants');
});