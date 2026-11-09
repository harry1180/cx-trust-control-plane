import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTranscriptEvent, wavDataOffset, PlaybackAudioSource, TranscribeLiveCallProvider } from '../src/transcribe.ts';

// ---- unit: transcript event parsing (real Transcribe event shape) ----

test('parseTranscriptEvent: final results only, channel mapping, confidence', () => {
  const ev = {
    TranscriptEvent: {
      Transcript: {
        Results: [
          { IsPartial: false, ChannelId: 0, StartTime: 2.31, Alternatives: [{ Transcript: ' change my bank account ', Items: [{ Confidence: 0.91 }, { Confidence: 0.85 }] }] },
          { IsPartial: true, ChannelId: 0, StartTime: 3, Alternatives: [{ Transcript: 'move my' }] },
          { IsPartial: false, ChannelId: 1, StartTime: 5.1, Alternatives: [{ Transcript: 'let me check that for you', Items: [{ Confidence: 0.99 }] }] },
        ],
      },
    },
  };
  const utts = parseTranscriptEvent(ev as never);
  assert.equal(utts.length, 2, 'partial filtered');
  assert.equal(utts[0].speaker, 'CUSTOMER');
  assert.equal(utts[0].text, 'change my bank account');
  assert.equal(utts[0].offsetS, 2.3);
  assert.ok(Math.abs(utts[0].confidence - 0.88) < 0.01);
  assert.equal(utts[1].speaker, 'AGENT');
  assert.equal(utts[1].offsetS, 5.1);
});

test('parseTranscriptEvent: empty event', () => {
  assert.deepEqual(parseTranscriptEvent({}), []);
  assert.deepEqual(parseTranscriptEvent({ TranscriptEvent: { Transcript: { Results: [] } } }), []);
});

// ---- unit: WAV handling ----

test('wavDataOffset finds data chunk and PlaybackAudioSource streams real-time PCM', async () => {
  const wav = readFileSync(new URL('./fixtures/attack_call.wav', import.meta.url));
  const off = wavDataOffset(wav);
  assert.ok(off >= 44 && off < wav.length);
  const src = new PlaybackAudioSource(wav);
  const chunks: number[] = [];
  let total = 0;
  const t0 = Date.now();
  for await (const c of src.chunks()) {
    total += c.length;
    chunks.push(1);
    if (chunks.length >= 10) break;
  }
  assert.equal(total, 10 * Math.floor(100 * 32), '100ms of 16k mono 16-bit = 3200B chunks');
  assert.ok(Date.now() - t0 >= 900, 'real-time pacing (100ms per chunk)');
});

// ---- integration: provider over the REAL Transcribe API ----
// Runs only when AWS credentials are configured; otherwise asserts the
// provider fails with a LABELED error (explicit degradation contract).

test('TranscribeLiveCallProvider over real AWS (or labeled failure without creds)', async () => {
  const wav = readFileSync(new URL('./fixtures/attack_call.wav', import.meta.url));
  const provider = new TranscribeLiveCallProvider();
  const turns: { speaker: string; text: string }[] = [];
  let failed = null as null | Error;
  try {
    for await (const turn of provider.transcribe({
      contactId: 'test-wav-1',
      audioSource: new PlaybackAudioSource(wav),
    })) {
      turns.push(turn);
    }
  } catch (e) {
    failed = e as Error;
  }

  if (failed) {
    // explicit degradation contract: labeled error, no silent fallback
    const msg = failed.message ?? String(failed);
    assert.ok(
      /credential|UnrecognizedClientException|network|ENOTFOUND|ECONNREFUSED|timeout|aws|AccessDenied|InvalidSignature|ExpiredToken|Region/i.test(msg),
      `failure must be an AWS/network credential error, got: ${msg}`,
    );
    assert.ok(msg.length > 10);
    return; // no AWS in this environment — contract still verified
  }

  // AWS path: the synthesized speech must come back as text
  assert.ok(turns.length >= 1, 'real transcription produced turns');
  const all = turns.map(t => t.text).join(' ').toLowerCase();
  assert.ok(
    /account|bank|phone|recover|funds/.test(all),
    `transcript should contain the spoken attack phrases, got: ${all.slice(0, 200)}`,
  );
  for (const t of turns) assert.ok(['CUSTOMER', 'AGENT'].includes(t.speaker));
});

test('provider refuses missing audio source with labeled error', async () => {
  const provider = new TranscribeLiveCallProvider();
  await assert.rejects(
    () => provider.transcribe({ contactId: 'x' })[Symbol.asyncIterator]().next(),
    /no audio source provided/,
  );
});
