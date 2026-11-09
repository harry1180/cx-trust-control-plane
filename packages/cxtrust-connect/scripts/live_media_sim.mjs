// Live media-stream simulator: streams the TTS attack fixture as Connect
// media frames (base64 u-law 8kHz over WebSocket) into the adapter — locally
// or through the public tunnel URL — exactly the message shape AWS Connect
// sends when a contact flow has the "Start media streaming" block.
//
//   node scripts/live_media_sim.mjs [wss-url] [path/to/16k-mono-pcm.wav]
//   defaults: ws://127.0.0.1:8799/ws and the built-in TTS attack fixture.
//   (A bare .wav argument is treated as the source with the default target.)
//
// Requires the adapter running with CXTRUST_STT=deepgram for transcripts.
// Prints the governed interaction's turns + in-house voice scores.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { WebSocket } from 'ws';
import { mulawEncode } from '@cxtrust/twilio';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg2 = process.argv[2];
const arg3 = process.argv[3];
const target = arg2 && arg2.startsWith('ws') ? arg2 : 'ws://127.0.0.1:8799/ws';
const sourcePath = arg2 && arg2.endsWith('.wav') ? arg2 : (arg3 && arg3.endsWith('.wav') ? arg3 : resolve(HERE, '../test/fixtures/attack_call.wav'));
const sourceLabel = basename(sourcePath, '.wav');
const API = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';

// --- source: 16kHz mono PCM wav -> 8kHz samples -> u-law
const wav = readFileSync(sourcePath);
let off = 12;
let data = null;
while (off + 8 <= wav.length) {
  const id = wav.toString('ascii', off, off + 4);
  const size = wav.readUInt32LE(off + 4);
  if (id === 'data') data = wav.subarray(off + 8, off + 8 + size);
  off += 8 + size + (size % 2);
}
if (!data) { console.error('no data chunk'); process.exit(1); }
const frames16k = Math.floor(data.length / 2);
const pcm8k = Buffer.alloc(Math.floor(frames16k / 2) * 2);
for (let i = 0; i + 1 < frames16k; i += 2) {
  pcm8k.writeInt16LE(data.readInt16LE(i * 2), (i / 2) * 2);
}
const mulaw = mulawEncode(pcm8k);
const b64frames = [];
for (let i = 0; i < mulaw.length; i += 160) b64frames.push(mulaw.subarray(i, i + 160).toString('base64'));

const contactId = `sim-${sourceLabel}-${Date.now()}`;
console.log(`streaming ${b64frames.length} frames (${(b64frames.length * 0.02).toFixed(1)}s) of ${sourcePath} to ${target} as contact ${contactId}`);

const ws = new WebSocket(target);
let interactionId = '';
ws.on('open', () => {
  ws.send(JSON.stringify({ 'msg-type': 'start', contactId }));
  let i = 0;
  const timer = setInterval(() => {
    // burst-send; the adapter paces consumption in real time
    for (let k = 0; k < 50 && i < b64frames.length; k++, i++) {
      ws.send(JSON.stringify({ 'msg-type': 'audio', chunk: b64frames[i] }));
    }
    if (i >= b64frames.length) {
      clearInterval(timer);
      setTimeout(() => ws.send(JSON.stringify({ 'msg-type': 'stop', contactId })), 3000); // let STT flush
    }
  }, 100);
});
ws.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.interactionId) { interactionId = m.interactionId; console.log('session:', m.interactionId); }
  if (m.ended) console.log('stream ended by adapter');
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let t = 0; t < 45; t++) {
    await sleep(2000);
    if (!interactionId) continue;
    const snap = await (await fetch(`${API}/v1/interactions/${interactionId}`)).json();
    const customer = (snap.participants ?? []).find(p => p.participantId === 'customer');
    const turns = (snap.timeline ?? []).filter(x => String(x.label ?? '').startsWith('customer:'));
    const voiceEntry = (snap.timeline ?? []).find(x => String(x.kind ?? '') === 'VOICE');
    const rs = customer?.riskState ?? {};
    console.log(`[t+${t * 2}s] turns=${turns.length} live-riskState.synthetic=${rs.syntheticVoiceProbability ?? 'n/a'} voiceTimeline=${voiceEntry ? String(voiceEntry.label) : 'none'}`);
    if (turns.length >= 2 && voiceEntry) {
      console.log('\n--- transcript excerpts ---');
      for (const x of turns.slice(0, 6)) console.log('  ', String(x.label ?? '').slice(0, 140));
      console.log('\n--- voice score (persisted in timeline) ---');
      console.log('  ', String(voiceEntry.label), '| analyzer:', String(voiceEntry.detail ?? 'n/a'));
      console.log('\nRESULT: audio streamed → Deepgram transcript + in-house scores, persisted for the Investigation console.');
      ws.close();
      process.exit(0);
    }
  }
  console.log('timed out waiting for transcript + scores (check CXTRUST_STT=deepgram and the key file)');
  ws.close();
  process.exit(2);
})();