// Voiceprint endpoints: consent gating, enroll/verify mechanics, auth posting.
// Uses a throwaway store file so the package's real store is untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectAdapter, decodeVoiceAudio, type SpeechToTextProvider } from '../src/index.ts';

const storeFile = join(mkdtempSync(join(tmpdir(), 'vp-')), 'voiceprint.json');
process.env.CXTRUST_VOICEPRINT_FILE = storeFile;

const { createApi } = await import('../../cxtrust-server/src/index.ts');
const { SqliteStore } = await import('../../cxtrust-server/src/store.ts');

let apiServer: ReturnType<typeof createServer>;
let apiBase = '';
let adapterServer: ReturnType<typeof createServer>;
let adapterBase = '';

class NoopSTT implements SpeechToTextProvider {
  readonly id = 'noop';
  // eslint-disable-next-line require-yield
  async *transcribe(): AsyncIterable<never> { return; }
}

test.before(async () => {
  apiServer = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => apiServer.listen(0, r));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  process.env.CXTRUST_API_URL = apiBase;
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:8787')) return orig(url.replace('http://127.0.0.1:8787', apiBase), init as RequestInit);
    return orig(url as string, init as RequestInit);
  }) as typeof fetch;
  const adapter = new ConnectAdapter({ stt: new NoopSTT() });
  adapterServer = adapter.listen(0);
  await new Promise<void>(r => adapterServer.on('listening', r));
  adapterBase = `http://127.0.0.1:${(adapterServer.address() as AddressInfo).port}`;
});

test.after(() => {
  apiServer.close(); adapterServer.close();
  try { unlinkSync(storeFile); } catch { /* */ }
});

/** Deterministic "voice": two formant-ish partials with vibrato (voiced, speech-length). */
function voicePcm(baseHz: number, secs: number, vibHz: number): Buffer {
  const n = Math.floor(16000 * secs);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const f = baseHz * (1 + 0.04 * Math.sin((2 * Math.PI * vibHz * i) / 16000));
    const v = 6000 * Math.sin((2 * Math.PI * f * i) / 16000)
      + 3000 * Math.sin((2 * Math.PI * 2.4 * f * i) / 16000)
      + 1500 * Math.sin((2 * Math.PI * 3.9 * f * i) / 16000);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return b;
}
const b64 = (pcm: Buffer) => pcm.toString('base64');

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${adapterBase}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('enroll without consent is rejected before any processing', async () => {
  const { status, json } = await post('/connect/voiceprint/enroll', { audio: b64(voicePcm(140, 2, 5)) });
  assert.equal(status, 400);
  assert.match(String(json.error), /consent required/);
  assert.equal(existsSync(storeFile), false, 'no template written without consent');
});

test('decodeVoiceAudio: WAV format validation with actionable error', () => {
  // raw pcm passes through
  const raw = voicePcm(140, 1, 5);
  assert.deepEqual(decodeVoiceAudio(raw.toString('base64')), { pcm: raw });
  // non-RIFF garbage odd length rejected
  assert.ok(decodeVoiceAudio(Buffer.from('abc').toString('base64')).error);
});

test('enroll with consent → status shows consent record; verify same voice matches, different voice scores lower', async () => {
  const speakerA = voicePcm(140, 3, 5);
  const enroll = await post('/connect/voiceprint/enroll', {
    consent: true, consentBy: 'test-user', label: 'test speaker A', audio: b64(speakerA),
  });
  assert.equal(enroll.status, 200, JSON.stringify(enroll.json));
  assert.equal(enroll.json.enrolled, true);
  const consent = enroll.json.consent as { at: string; by: string };
  assert.equal(consent.by, 'test-user');
  assert.ok(consent.at, 'consent timestamp recorded with the template');

  const status = await (await fetch(`${adapterBase}/connect/voiceprint/status`)).json() as Record<string, unknown>;
  assert.equal(status.enrolled, true);
  assert.equal((status.template as { consent: { by: string } }).consent.by, 'test-user');
  assert.ok(!(status.template as Record<string, unknown>).vector, 'raw template vector never exposed by status');

  // same speaker, different utterance → high similarity, must match at default threshold
  const same = await post('/connect/voiceprint/verify', { audio: b64(voicePcm(141, 2.5, 5.2)) });
  assert.equal(same.status, 200);
  assert.equal(same.json.match, true, `same-speaker similarity ${same.json.similarity} must match`);
  assert.ok(Number(same.json.similarity) >= 0.8);

  // clearly different speaker → lower similarity than the same-speaker score
  const other = await post('/connect/voiceprint/verify', { audio: b64(voicePcm(320, 2.5, 8)) });
  assert.equal(other.status, 200);
  assert.ok(Number(other.json.similarity) < Number(same.json.similarity),
    `different speaker (${other.json.similarity}) must score below same speaker (${same.json.similarity})`);
});

test('template persists across adapter "restarts" (file store)', async () => {
  const { _resetVoiceprintCache, voiceprintStatus } = await import('../src/voiceprint.ts');
  _resetVoiceprintCache(); // simulates a fresh process reading the file
  const s = voiceprintStatus();
  assert.equal(s.enrolled, true, 'template reloaded from the store file');
});

test('verify without enrollment → 400, no fabricated score', async () => {
  const { deleteVoiceprint, _resetVoiceprintCache, verifyVoiceprint } = await import('../src/voiceprint.ts');
  deleteVoiceprint();
  _resetVoiceprintCache();
  const r = verifyVoiceprint(voicePcm(140, 2, 5));
  assert.equal(r.ok, false);
  const status = await (await fetch(`${adapterBase}/connect/voiceprint/status`)).json() as { enrolled: boolean };
  assert.equal(status.enrolled, false);
});

test('verify-live without captured audio → clear 400', async () => {
  const { status, json } = await post('/connect/voiceprint/verify-live', { contactId: 'no-such-contact' });
  assert.equal(status, 400);
  assert.match(String(json.error), /no live audio/);
});