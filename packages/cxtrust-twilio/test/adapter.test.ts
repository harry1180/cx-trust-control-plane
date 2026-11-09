import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  TwilioStreamAdapter, MulawCodec, MuLawStreamSource, upsample8kTo16k,
  ScriptedCallTranscriber, DemoVoiceAnalyzer, SPOOF_NUMBERS,
} from '../src/index.ts';

// Start the REAL governance API on an ephemeral port; redirect the adapter's
// module-captured fetch target (http://127.0.0.1:8787) to it.
const { createApi } = await import('../../cxtrust-server/src/index.ts');
const { SqliteStore } = await import('../../cxtrust-server/src/store.ts');

let apiServer: ReturnType<typeof createServer>;
let apiBase = '';
let adapterServer: ReturnType<typeof createServer>;
let adapterBase = '';
let adapter: TwilioStreamAdapter;

test.before(async () => {
  apiServer = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => apiServer.listen(0, r));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  process.env.CXTRUST_API_URL = apiBase;

  const orig = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:8787')) {
      return orig(url.replace('http://127.0.0.1:8787', apiBase), init as RequestInit);
    }
    return orig(url as string, init as RequestInit);
  }) as typeof fetch;

  adapter = new TwilioStreamAdapter({
    stt: new ScriptedCallTranscriber(),
    voice: new DemoVoiceAnalyzer(),
  });
  adapterServer = adapter.listen(0);
  await new Promise<void>(r => adapterServer.on('listening', r));
  adapterBase = `http://127.0.0.1:${(adapterServer.address() as AddressInfo).port}`;
});

test.after(() => {
  apiServer.close();
  adapterServer.close();
});

// ---------------------------------------------------------------- mulaw codec

test('mulaw decode: silence 0xFF → 0', () => {
  assert.equal(MulawCodec.decodeSample(0xff), 0);
  assert.equal(MulawCodec.decode(Buffer.from([0xff])).readInt16LE(0), 0);
});

test('mulaw round-trip on known linear values', () => {
  const samples = [0, 100, -100, 1000, -1000, 8000, -8000, 20000, -20000, 32767, -32768];
  for (const s of samples) {
    const u = MulawCodec.encodeSample(s);
    const back = MulawCodec.decodeSample(u);
    // standard G.711 ulaw quantization: error bounded by ~2% of magnitude + segment slack
    const err = Math.abs(back - s);
    const tol = Math.max(40, Math.abs(s) * 0.05);
    assert.ok(err <= tol, `sample ${s}: decoded ${back}, err ${err} > tol ${tol}`);
  }
});

test('mulaw encode/decode buffer round-trip (bulk)', () => {
  const pcm = Buffer.alloc(160 * 2);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
  const mulaw = MulawCodec.encode(pcm);
  assert.equal(mulaw.length, 160);
  const back = MulawCodec.decode(mulaw);
  assert.equal(back.length, pcm.length);
  for (let i = 0; i < 160; i++) {
    const orig = pcm.readInt16LE(i * 2);
    const got = back.readInt16LE(i * 2);
    assert.ok(Math.abs(got - orig) <= Math.max(40, Math.abs(orig) * 0.05), `i=${i} orig=${orig} got=${got}`);
  }
});

// ------------------------------------------------------- MuLawStreamSource

test('media frames decoded into AudioSource: chunk size and pacing', async () => {
  const src = new MuLawStreamSource();
  // 3200 bytes of 16k PCM = 1600 samples of 16k = 800 samples of 8k = 800 mulaw bytes
  const framesPerChunk = 800 / 160; // Twilio sends 160-byte (20ms) frames
  // push 2 chunks' worth of frames (silence payload, content irrelevant here)
  const frame = Buffer.alloc(160, 0xff).toString('base64');
  void framesPerChunk;
  const t0 = Date.now();
  const consume = (async () => {
    const it = src.chunks()[Symbol.asyncIterator]();
    const first = await it.next();
    assert.ok(!first.done);
    assert.equal(first.value.length, 3200, 'chunk is ~100ms of 16kHz mono 16-bit PCM');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 80, `first chunk arrives as soon as data is buffered, got ${elapsed}ms`);
    // second chunk arrives ~100ms later (real-time pacing)
    const t1 = Date.now();
    const second = await it.next();
    assert.ok(!second.done);
    assert.equal(second.value.length, 3200);
    const gap = Date.now() - t1;
    assert.ok(gap >= 90, `second chunk paced ~100ms later, gap ${gap}ms`);
    it.return?.(undefined as never);
    return null;
  })();
  for (let i = 0; i < 10; i++) src.push(frame);
  await consume;
  // PCM values: silence mulaw 0xFF decodes to 0 linear
  const decoded = MulawCodec.decode(Buffer.alloc(160, 0xff));
  assert.equal(decoded.readInt16LE(0), 0);
});

test('upsample 8k→16k duplicates samples', () => {
  const pcm8k = Buffer.from([0x01, 0x00, 0x02, 0x00]); // samples 1, 2
  const up = upsample8kTo16k(pcm8k);
  assert.equal(up.length, 8);
  assert.equal(up.readInt16LE(0), 1);
  assert.equal(up.readInt16LE(2), 1);
  assert.equal(up.readInt16LE(4), 2);
  assert.equal(up.readInt16LE(6), 2);
});

// ------------------------------------------------- governance integration

async function openStream(callSid: string, phone: string): Promise<{ ws: WebSocket; reply: Record<string, unknown> }> {
  const ws = new WebSocket(adapterBase.replace('http', 'ws') + '/twilio');
  await new Promise(r => ws.on('open', r));
  const reply = await new Promise<Record<string, unknown>>(resolve => {
    ws.on('message', d => resolve(JSON.parse(String(d)) as Record<string, unknown>));
    ws.send(JSON.stringify({
      event: 'start',
      sequenceNumber: '1',
      start: {
        streamSid: `ST-${callSid}`,
        callSid,
        customParameters: { customer_phone: phone },
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    }));
  });
  return { ws, reply };
}

test('ws start event creates governed interaction via API', async () => {
  const { ws, reply } = await openStream('CA-test-1', '+155****1111');
  const interactionId = String(reply.interactionId ?? '');
  assert.match(interactionId, /^INT-TW-CA-test-1$/);
  assert.equal(reply.governed, true);
  // wait for scripted turns to land in governance
  await new Promise(r => setTimeout(r, 2200));
  const snap = (await (await fetch(`${apiBase}/v1/interactions/${interactionId}`)).json()) as Record<string, unknown>;
  assert.ok(snap.timeline, 'governance timeline exists for the twilio call');
  ws.close();
});

test('GET /twilio/streams lists live streams and healthz ok', async () => {
  const { ws } = await openStream('CA-test-2', '+155****4567');
  const res = await fetch(`${adapterBase}/twilio/streams`);
  const body = (await res.json()) as { streams: { callSid: string }[] };
  assert.ok(body.streams.some(s => s.callSid === 'CA-test-2'), 'live stream listed');
  const h = (await (await fetch(`${adapterBase}/healthz`)).json()) as { ok: boolean };
  assert.equal(h.ok, true);
  ws.close();
});

test('action gate blocks on synthetic voice', async () => {
  const { ws } = await openStream('CA-test-3', '+155****1111');
  // wait for first scripted turn + voice analysis to land
  await new Promise(r => setTimeout(r, 1400));
  const d = (await (await fetch(`${adapterBase}/twilio/action/CA-test-3`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestedAction: 'CHANGE_BANK_ACCOUNT', intent: 'CHANGE_BANK_ACCOUNT' }),
  })).json()) as { decision?: { allowed: boolean; matchedRule: string } };
  assert.equal(d.decision?.allowed, false, 'synthetic-voice caller blocked');
  assert.equal(d.decision?.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
  // violation recorded on call state
  const call = adapter.getCall('CA-test-3');
  assert.ok(call && call.violations.length >= 1, 'violation recorded on call state');
  assert.ok(SPOOF_NUMBERS.has('+155****1111'));
  ws.close();
});

test('stop event ends the governed session', async () => {
  const { ws, reply } = await openStream('CA-test-4', '+155****4567');
  assert.ok(reply.interactionId);
  const stopReply = await new Promise<Record<string, unknown>>(resolve => {
    ws.on('message', d => resolve(JSON.parse(String(d)) as Record<string, unknown>));
    ws.send(JSON.stringify({
      event: 'stop',
      sequenceNumber: '9',
      stop: { streamSid: `ST-CA-test-4`, callSid: 'CA-test-4' },
    }));
  });
  assert.equal(stopReply.ended, true);
  // stream no longer live
  const body = (await (await fetch(`${adapterBase}/twilio/streams`)).json()) as { streams: { callSid: string }[] };
  assert.ok(!body.streams.some(s => s.callSid === 'CA-test-4'), 'stream removed after stop');
  ws.close();
});

// silence an unused-import lint nudge for ScriptedCallTranscriber (used above)
void ScriptedCallTranscriber;
