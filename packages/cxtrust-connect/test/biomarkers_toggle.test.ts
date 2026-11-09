// UI toggle for the voice-biomarker capability: status/flag/override rules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectAdapter, type SpeechToTextProvider } from '../src/index.ts';

let adapterServer: ReturnType<typeof createServer>;
let base = '';

const stubSTT: SpeechToTextProvider = {
  id: 'test-stub-stt',
  async *transcribe(): AsyncIterable<never> { /* no media in these tests */ },
};

test.before(async () => {
  delete process.env.ENABLE_VOICE_BIOMARKERS;
  const adapter = new ConnectAdapter({ stt: stubSTT } as never);
  adapterServer = adapter.listen(0);
  await new Promise<void>(r => adapterServer.on('listening', r));
  base = `http://127.0.0.1:${(adapterServer.address() as AddressInfo).port}`;
});
test.after(() => { delete process.env.ENABLE_VOICE_BIOMARKERS; adapterServer.close(); });

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}
async function postJson(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

test('default status follows the ENABLE_VOICE_BIOMARKERS flag (default ON)', async () => {
  const s = await getJson('/connect/biomarkers/status');
  assert.equal(s.status, 200);
  assert.equal(s.body.enabled, true);
  assert.equal(s.body.source, 'flag');
  assert.equal(s.body.flagDefault, true);
});

test('env flag turns the capability off when no UI override is set', async () => {
  process.env.ENABLE_VOICE_BIOMARKERS = 'false';
  const s = await getJson('/connect/biomarkers/status');
  assert.equal(s.body.enabled, false);
  assert.equal(s.body.source, 'flag');
  const a = await postJson('/connect/biomarkers/analyze', { contactId: 'no-such-contact' });
  assert.equal(a.status, 403, 'disabled capability refuses analysis');
  assert.equal(a.body.disabled, true);
  delete process.env.ENABLE_VOICE_BIOMARKERS;
});

test('UI toggle off/on wins over the flag; analysis gate follows it', async () => {
  const off = await postJson('/connect/biomarkers/toggle', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.source, 'runtime');

  // gate fires BEFORE audio lookup → 403 even for an unknown contact
  const gated = await postJson('/connect/biomarkers/analyze', { contactId: 'no-such-contact' });
  assert.equal(gated.status, 403);
  assert.equal(gated.body.disabled, true);

  // env says off, UI override says on → runtime wins
  process.env.ENABLE_VOICE_BIOMARKERS = 'false';
  const on = await postJson('/connect/biomarkers/toggle', { enabled: true });
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.source, 'runtime');

  // gate passes now: request reaches the audio-lookup stage (400, not 403)
  const passGate = await postJson('/connect/biomarkers/analyze', { contactId: 'no-such-contact' });
  assert.equal(passGate.status, 400, 'enabled capability proceeds to the audio stage');
  assert.notEqual(passGate.body.disabled, true);

  // reset to flag default
  delete process.env.ENABLE_VOICE_BIOMARKERS;
  await postJson('/connect/biomarkers/toggle', { enabled: true });
});

test('toggle rejects non-boolean payloads', async () => {
  const bad = await postJson('/connect/biomarkers/toggle', { enabled: 'yes' });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /enabled:boolean/);
});