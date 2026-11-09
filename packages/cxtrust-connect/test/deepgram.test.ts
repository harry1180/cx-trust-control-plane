// MOCK Deepgram live STT tests — NO real Deepgram API is contacted.
// Every test here runs against a local mock WS server that mimics the
// Deepgram streaming Results message shape (labeled MOCK below).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  DeepgramLiveSTTProvider, parseDeepgramResults,
  PlaybackAudioSource,
} from '../src/deepgram.ts';
import { TwilioStreamAdapter } from '@cxtrust/twilio/src/index.ts';

// ---------------------------------------------------------------- mock server

/** Mock Deepgram streaming endpoint: records binary audio, emits scripted finals. */
async function startMockDeepgram(opts: {
  /** scripted final Results messages, sent every ~500ms of received audio */
  transcripts: { text: string; startS: number }[];
  /** abort mid-stream after N audio frames received (for the abrupt-close test) */
  closeAfterFrames?: number;
}): Promise<{ url: string; frames: Buffer[]; close: () => void }> {
  const wss = new WebSocketServer({ port: 0 });
  const frames: Buffer[] = [];
  await new Promise<void>(r => wss.on('listening', r));
  const port = (wss.address() as AddressInfo).port;

  wss.on('connection', (ws: WebSocket) => {
    let sent = 0;
    let frameCount = 0;
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        frames.push(data as Buffer);
        frameCount++;
        if (opts.closeAfterFrames && frameCount >= opts.closeAfterFrames) {
          ws.close(); // abrupt remote close mid-stream
          return;
        }
      }
      // emit one scripted final per ~500ms of received audio
      // (500ms of 16kHz mono 16-bit PCM = 16000 bytes)
      const receivedBytes = frames.reduce((s, f) => s + f.length, 0);
      while (sent < opts.transcripts.length && receivedBytes >= (sent + 1) * 16000) {
        const t = opts.transcripts[sent]!;
        ws.send(JSON.stringify({
          type: 'Results',
          is_final: true,
          start: t.startS,
          end: t.startS + 2.4,
          channel: { alternatives: [{ transcript: t.text, confidence: 0.95 }] },
        }));
        sent++;
      }
    });
  });

  const url = `ws://127.0.0.1:${port}/v1/listen`;
  return { url, frames, close: () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  } };
}

function attackWav(): Buffer {
  return readFileSync(new URL('./fixtures/attack_call.wav', import.meta.url));
}

// ------------------------------------------------- (a) happy path over mock WS

test('MOCK deepgram live STT: streams WAV PCM and yields scripted final Turns', async () => {
  process.env.CXTRUST_DEEPGRAM_KEY = 'test-mock-key';
  const mock = await startMockDeepgram({
    transcripts: [
      { text: 'Hello? Yes, I lost my phone.', startS: 1.2 },
      { text: 'Change my bank account to the new one.', startS: 4.5 },
    ],
  });
  try {
    const provider = new DeepgramLiveSTTProvider({ baseUrl: mock.url });
    assert.equal(provider.id, 'deepgram-live-stt');
    const src = new PlaybackAudioSource(attackWav());
    const turns = [];
    for await (const turn of provider.transcribe({
      contactId: 'CT-mock-1',
      audioSource: src,
      metadata: {},
    })) {
      turns.push(turn);
      if (turns.length >= 2) break;
    }
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0], { text: 'Hello? Yes, I lost my phone.', speaker: 'CUSTOMER', offsetS: 1.2 });
    assert.deepEqual(turns[1], { text: 'Change my bank account to the new one.', speaker: 'CUSTOMER', offsetS: 4.5 });
    // provider actually streamed binary PCM to the mock endpoint
    assert.ok(mock.frames.length >= 2, `binary PCM frames received: ${mock.frames.length}`);
    assert.ok(mock.frames[0]!.length > 0);
  } finally {
    delete process.env.CXTRUST_DEEPGRAM_KEY;
    mock.close();
  }
});

// ------------------------------------------------- (b) missing key labeled error

test('MOCK deepgram live STT: missing key throws labeled error before connect', async () => {
  delete process.env.CXTRUST_DEEPGRAM_KEY;
  const mock = await startMockDeepgram({ transcripts: [] });
  try {
    const provider = new DeepgramLiveSTTProvider({ baseUrl: mock.url, ignoreKeyFile: true });
    await assert.rejects(
      () => (async () => { for await (const _t of provider.transcribe({ contactId: 'CT-x', audioSource: new PlaybackAudioSource(attackWav()) })) { /* unreachable */ } })(),
      (err: Error) => err.message.includes('[deepgram-stt] CXTRUST_DEEPGRAM_KEY not set'),
    );
    assert.equal(mock.frames.length, 0, 'no connection made without a key');
  } finally {
    mock.close();
  }
});

// --------------------------------------- (c) abrupt close surfaces labeled error

test('MOCK deepgram live STT: abrupt server close mid-stream surfaces labeled error', async () => {
  process.env.CXTRUST_DEEPGRAM_KEY = 'test-mock-key';
  const mock = await startMockDeepgram({
    transcripts: [],
    closeAfterFrames: 3, // close after the 3rd audio frame arrives
  });
  try {
    const provider = new DeepgramLiveSTTProvider({ baseUrl: mock.url });
    await assert.rejects(
      async () => {
        for await (const _ of provider.transcribe({
          contactId: 'CT-abrupt',
          audioSource: new PlaybackAudioSource(attackWav()),
        })) { /* consume until the error surfaces */ }
      },
      (err: Error) => err.message.includes('[deepgram-stt]'),
    );
  } finally {
    delete process.env.CXTRUST_DEEPGRAM_KEY;
    mock.close();
  }
});

// ---------------------------------------------- parse unit (Deepgram msg shape)

test('MOCK deepgram parse: final only, empty transcript skipped, non-Results ignored', () => {
  assert.deepEqual(parseDeepgramResults({ type: 'Results', is_final: true, start: 2.31, channel: { alternatives: [{ transcript: ' hello world ' }] } }),
    [{ text: 'hello world', speaker: 'CUSTOMER', offsetS: 2.3 }]);
  assert.deepEqual(parseDeepgramResults({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'partial' }] } }), []);
  assert.deepEqual(parseDeepgramResults({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: '' }] } }), []);
  assert.deepEqual(parseDeepgramResults({ type: 'Metadata' as never }), []);
});

// --------------------------------------- (d) Twilio wiring over the mock server

test('MOCK twilio wiring: sttFactory(Deepgram) turns land in governance API', async () => {
  process.env.CXTRUST_DEEPGRAM_KEY = 'test-mock-key';
  const mock = await startMockDeepgram({
    transcripts: [
      { text: 'I need to recover my account right now.', startS: 1.0 },
      { text: 'Move my funds today.', startS: 4.0 },
    ],
  });

  // real governance API on an ephemeral port (in-test pattern from adapter.test.ts)
  const { createApi } = await import('@cxtrust/server/src/index.ts');
  const { SqliteStore } = await import('@cxtrust/server/src/store.ts');
  const apiServer = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => apiServer.listen(0, r));
  const apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

  const orig = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:8787')) {
      return orig(url.replace('http://127.0.0.1:8787', apiBase), init as RequestInit);
    }
    return orig(url as string, init as RequestInit);
  }) as typeof fetch;

  const provider = new DeepgramLiveSTTProvider({ baseUrl: mock.url });
  const adapter = new TwilioStreamAdapter({ sttFactory: () => provider });
  const adapterServer = adapter.listen(0);
  await new Promise<void>(r => adapterServer.on('listening', r));
  const adapterBase = `http://127.0.0.1:${(adapterServer.address() as AddressInfo).port}`;

  // open a Twilio stream and feed real mulaw frames (silence + scripted tone)
  const callSid = 'CA-deepgram-mock';
  const ws = new WebSocket(adapterBase.replace('http', 'ws') + '/twilio');
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    start: {
      streamSid: `ST-${callSid}`,
      callSid,
      customParameters: { customer_phone: '+155****1111' },
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  }));
  // Twilio media frames carry 160 bytes (20ms) of mulaw audio; the adapter
  // paces the stream source in ~100ms chunks, so ~6000 frames ≈ 120s of audio
  // — plenty for the mock to emit two ~500ms transcripts.
  const frame = Buffer.alloc(160, 0x55).toString('base64');
  for (let i = 0; i < 6000; i++) {
    ws.send(JSON.stringify({ event: 'media', sequenceNumber: String(i + 2), streamSid: `ST-${callSid}`, media: { payload: frame } }));
    if (i % 50 === 0) await new Promise(r => setTimeout(r, 1));
  }
  // wait for Deepgram turns to flow through MuLawStreamSource → provider → API
  await new Promise(r => setTimeout(r, 3000));
  const interactionId = `INT-TW-${callSid}`;
  const snap = (await (await fetch(`${apiBase}/v1/interactions/${interactionId}`)).json()) as {
    timeline?: { kind?: string; turns?: { text: string }[] }[];
  };
  assert.ok(snap.timeline, 'governance timeline exists for the deepgram-wired twilio call');
  const texts = JSON.stringify(snap.timeline);
  assert.ok(texts.includes('recover my account'), 'deepgram turn 1 landed in governance');
  assert.ok(texts.includes('Move my funds'), 'deepgram turn 2 landed in governance');

  ws.close();
  adapterServer.closeAllConnections?.();
  adapterServer.close();
  apiServer.closeAllConnections?.();
  apiServer.close();
  globalThis.fetch = orig;
  delete process.env.CXTRUST_DEEPGRAM_KEY;
  mock.close();
});
