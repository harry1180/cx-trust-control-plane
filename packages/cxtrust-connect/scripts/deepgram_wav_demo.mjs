// Deepgram-only demo: real speech recognition on a WAV file, no phone needed.
//
//   set CXTRUST_DEEPGRAM_KEY=dg-xxxx
//   node scripts/deepgram_wav_demo.mjs [path/to/16k-mono.wav]
//
// Flow: WAV (16kHz mono PCM) -> Deepgram live-streaming STT (real API) ->
// transcript turns fed to the CX Trust governance API -> policy evaluated ->
// enforcement decision + evidence chain printed.
//
// Default fixture: the scripted deepfake-ATO attack call (TTS-synthesized in
// test/fixtures/attack_call.wav). Bring your own WAV of real speech to test
// with your own voice — must be 16kHz, mono, 16-bit PCM WAV.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const API = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
const HERE = dirname(fileURLToPath(import.meta.url));
const wavPath = process.argv[2] ?? resolve(HERE, '../test/fixtures/attack_call.wav');

if (!existsSync(wavPath)) {
  console.error(`no WAV at ${wavPath} — pass one as argv[2]`);
  process.exit(1);
}

// Key resolution: env var first, then a local .deepgram-key file (gitignored)
// so long keys never have to survive a shell paste. File format: the key on
// the first line, nothing else.
if (!process.env.CXTRUST_DEEPGRAM_KEY) {
  for (const p of [
    resolve(HERE, '../.deepgram-key'),
    resolve(HERE, '../../.deepgram-key'),
    resolve(HERE, '.deepgram-key'),
  ]) {
    if (existsSync(p)) {
      const v = readFileSync(p, 'utf8').split(/\r?\n/)[0].trim();
      if (v) {
        process.env.CXTRUST_DEEPGRAM_KEY = v;
        console.log(`[deepgram-stt] loaded key from ${p}`);
        break;
      }
    }
  }
}
if (!process.env.CXTRUST_DEEPGRAM_KEY) {
  console.error('[deepgram-stt] CXTRUST_DEEPGRAM_KEY not set. Get one free at https://console.deepgram.com (sign up → API Keys → New API Key, $200 free credit).');
  process.exit(1);
}

// Masked key preview — shows what the process actually received (whitespace
// bugs, truncation, prefix) WITHOUT printing the secret.
const k = process.env.CXTRUST_DEEPGRAM_KEY;
console.log(`[deepgram-stt] key preview: ${k.length} chars, starts '${k.slice(0, 4)}…', ends '…${k.slice(-2)}'`);
if (/^\s|\s$/.test(k)) console.error('[deepgram-stt] WARNING: key has leading/trailing whitespace — re-export it wrapped in quotes');
if (!k.startsWith('dgp')) console.error('[deepgram-stt] WARNING: expected a ' + 'dgp-prefixed key');

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j;
}

const { DeepgramLiveSTTProvider, PlaybackAudioSource } = await import('../src/deepgram.ts');

// 1. start a governed interaction (platform deepgram-wav = direct-audio source)
const start = await api('POST', '/v1/interactions', {
  organizationId: 'org-demo', platform: 'deepgram-wav', channel: 'voice',
  metadata: { label: 'Deepgram WAV demo', file: wavPath },
});
const iid = start.interactionId;
console.log(`1. governed session ${iid}`);

await api('POST', `/v1/interactions/${iid}/participant`, {
  participantId: 'customer', interactionId: iid, organizationId: 'org-demo',
  kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
  authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
});

// 2. stream the WAV through Deepgram live STT, feeding governance turn by turn
const wav = readFileSync(wavPath);
const provider = new DeepgramLiveSTTProvider();
console.log('2. streaming audio through Deepgram (nova-2, 16kHz linear16)…');
let turnCount = 0;
for await (const turn of provider.transcribe({
  contactId: 'wav-demo',
  audioSource: new PlaybackAudioSource(wav),
})) {
  turnCount += 1;
  console.log(`   t+${turn.offsetS}s [${turn.speaker}] ${turn.text}`);
  await api('POST', `/v1/interactions/${iid}/turns`, {
    participantId: 'customer', text: turn.text, offsetS: turn.offsetS,
  });
}
if (turnCount === 0) {
  console.error('   Deepgram returned no transcripts — check the WAV format (16kHz mono 16-bit PCM) and key credit.');
  process.exit(1);
}

// 3. the transcript lands in the risk engine; check the current risk
let snap = await api('GET', `/v1/interactions/${iid}`);
console.log(`3. risk after transcript: ${snap.risk.overall} | detections: ${(snap.detections ?? []).map(d => d.code).join(', ') || 'none'}`);

// 4. the risky action requested in that speech → enforcement gate
const d = await api('POST', `/v1/interactions/${iid}/actions`, {
  requestedAction: 'CHANGE_BANK_ACCOUNT', participantId: 'customer',
  intent: 'CHANGE_BANK_ACCOUNT', amount: 25000,
});
const dec = d.decision;
console.log(`4. enforcement gate → ${dec.matchedRule} | allowed: ${dec.allowed} | actions: ${dec.actions.join(', ')}`);
console.log(`   reasons: ${dec.reasons[0]}`);

// 5. verify evidence persisted
snap = await api('GET', `/v1/interactions/${iid}`);
const ev = await api('GET', `/v1/interactions/${iid}/evidence`);
await api('POST', `/v1/interactions/${iid}/end`);
console.log(`5. evidence chain valid: ${ev.chainValid} (${ev.evidence.length} records) · incidents: ${(snap.incidents ?? []).length}`);
console.log(`\nDone. Open http://localhost:3000 to see it in the Command Center, or /investigation/${iid} for the full replay.`);
