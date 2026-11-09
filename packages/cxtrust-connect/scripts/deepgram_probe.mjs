// Diagnostic: read the .deepgram-key file and probe Deepgram REST + manage
// endpoints with it (never prints the key — only masked status).
import { readFileSync } from 'node:fs';

const key = readFileSync(new URL('../.deepgram-key', import.meta.url), 'utf8').trim().split('\n')[0];
console.log(`key: ${key.length} chars, prefix ${key.slice(0, 5)}…, suffix …${key.slice(-3)}`);
if (/\s/.test(key)) console.log('WARNING: whitespace inside key');

async function probe(label, url) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    console.log(`${label}: HTTP ${res.status}`);
    if (!res.ok) console.log(`   body: ${text.slice(0, 300)}`);
    else console.log(`   ok  : ${text.slice(0, 200)}`);
  } catch (e) {
    console.log(`${label}: fetch error ${String(e.message).slice(0, 120)}`);
  }
}

await probe('GET /v1/projects        ', 'https://api.deepgram.com/v1/projects');
await probe('GET /v1/scopes          ', 'https://api.deepgram.com/v1/scopes');
await probe('GET /v1/billing/summary ', 'https://api.deepgram.com/v1/billing/summary');
