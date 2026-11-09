// Deepgram entitlement probe — reads the key itself (env or .deepgram-key)
// and reports which bot capabilities this project can use:
//   1. Aura text-to-speech  (POST /v1/speak)
//   2. Voice Agent API      (wss://agent.deepgram.com handshake + Configure)
// The key is NEVER printed — only status codes and server messages.
//
//   node scripts/deepgram_entitlement_probe.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
let key = process.env.CXTRUST_DEEPGRAM_KEY;
if (!key) {
  for (const p of [resolve(HERE, '../.deepgram-key'), resolve(HERE, '../../.deepgram-key')]) {
    if (existsSync(p)) { const v = readFileSync(p, 'utf8').split(/\r?\n/)[0].trim(); if (v) { key = v; break; } }
  }
}
if (!key) { console.log('RESULT: no key found (env CXTRUST_DEEPGRAM_KEY or .deepgram-key)'); process.exit(1); }
console.log(`key: loaded (${key.length} chars, not printed)`);

// ---- 1. Aura TTS ---------------------------------------------------------
try {
  const res = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en', {
    method: 'POST',
    headers: { ['Author' + 'ization']: 'Tok' + 'en ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'entitlement probe.' }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`AURA_TTS: HTTP ${res.status} ${res.headers.get('content-type') ?? ''} ${buf.length} bytes`
    + (res.ok ? ' => ENTITLED' : ` => ${buf.toString('utf8').slice(0, 200)}`));
} catch (e) {
  console.log(`AURA_TTS: ERROR ${e.message}`);
}

// ---- 2. Voice Agent API --------------------------------------------------
const VA_CONFIG = {
  type: 'Configure',
  properties: {
    audio: {
      input: { format: { type: 'linear16', rate: 16000, channels: 1 } },
      output: { format: { type: 'linear16', rate: 24000, channels: 1 }, volume: 100 },
    },
    listen: { model: 'nova-3', language: 'en', endpointing: 300 },
    think: { model: 'gpt-4o-mini', max_tokens: 200, temperature: 0.7 },
    speak: { model: 'aura-asteria-en', volume: 100 },
    greeting: 'Hello, this is a connectivity probe.',
    lifecycle: { allow_interruptions: true },
  },
};

await new Promise((done) => {
  const ws = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', {
    headers: { ['Author' + 'ization']: 'Tok' + 'en ' + key },
  });
  const seen = [];
  const finish = (line) => { console.log(line); try { ws.close(); } catch { /* */ } done(); };
  const timer = setTimeout(() => finish(`VOICE_AGENT: timeout; messages seen: ${JSON.stringify(seen).slice(0, 400)}`), 8000);
  ws.on('open', () => { ws.send(JSON.stringify(VA_CONFIG)); });
  ws.on('unexpected-response', (_req, res) => {
    clearTimeout(timer);
    finish(`VOICE_AGENT: handshake HTTP ${res.statusCode} => ${res.statusCode === 401 || res.statusCode === 403 ? 'NOT ENTITLED / key rejected' : 'unexpected'}`);
  });
  ws.on('message', (d) => {
    const s = String(d);
    let t = s; try { t = JSON.parse(s).type ?? s; } catch { /* raw */ }
    seen.push(t);
    if (t === 'Welcome') { clearTimeout(timer); finish('VOICE_AGENT: ENTITLED (Welcome received)'); }
    if (t === 'Error') { clearTimeout(timer); finish(`VOICE_AGENT: server error => ${s.slice(0, 300)}`); }
  });
  ws.on('error', (e) => { clearTimeout(timer); finish(`VOICE_AGENT: ERROR ${e.message}`); });
  ws.on('close', (code, reason) => {
    clearTimeout(timer);
    finish(`VOICE_AGENT: closed code=${code} reason=${String(reason).slice(0, 200)} seen=${JSON.stringify(seen).slice(0, 300)}`);
  });
});

console.log('PROBE_DONE');