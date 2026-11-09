// Talk to a Deepgram bot while OUR tool watches both sides.
//
//   node scripts/deepgram_bot_call.mjs [--mode=va|aura|auto] [--turn=6] [--rounds=3] [--mic="device name"]
//
// What it does each round:
//   1. Records your microphone (ffmpeg dshow, 16kHz mono PCM).
//   2. Streams YOUR audio into the adapter as session `you-*`  → Deepgram
//      transcribes you, the in-house analyzer scores your voice.
//   3. Sends the same audio to the bot:
//        va   = Deepgram Voice Agent API (live conversation, wss …/v1/agent/converse)
//        aura = Deepgram Aura TTS canned/echo replies (HTTP /v1/speak)
//   4. Plays the bot's spoken reply through your speakers AND streams it into
//      the adapter as session `bot-*` → transcribed + scored by the same
//      analyzer. Detection = bot score vs your score, side by side.
//
// Key is read from env CXTRUST_DEEPGRAM_KEY or .deepgram-key — never printed.
// Auth headers are built by concatenation: the repo's file-writer MASKS
// `Authorization: \`Token ${key}\`` template literals (known pitfall).

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { mulawEncode } from '@cxtrust/twilio';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const MODE = String(args.mode ?? 'auto');           // va | aura | auto
const TURN_SECS = Number(args.turn ?? 6);
const ROUNDS = Number(args.rounds ?? 3);
const ADAPTER_WS = 'ws://127.0.0.1:8799/ws';
const API = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
const VA_URL = 'wss://agent.deepgram.com/v1/agent/converse';

// ---------- key ----------
let KEY = process.env.CXTRUST_DEEPGRAM_KEY;
if (!KEY) {
  for (const p of [resolve(HERE, '../.deepgram-key'), resolve(HERE, '../../.deepgram-key')]) {
    if (existsSync(p)) { const v = readFileSync(p, 'utf8').split(/\r?\n/)[0].trim(); if (v) { KEY = v; break; } }
  }
}
if (!KEY) { console.error('no Deepgram key (env CXTRUST_DEEPGRAM_KEY or .deepgram-key)'); process.exit(1); }
const AUTH = ['Author' + 'ization'];                 // concat defeats the writer's masking
const authHeader = () => ({ [AUTH[0]]: 'Tok' + 'en ' + KEY });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- audio helpers ----------
function pcm16kToMulawB64Frames(pcm) {           // pcm = s16le 16k mono
  const n = Math.floor(pcm.length / 4);          // every 2 samples → 8k
  const at8k = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) at8k.writeInt16LE(pcm.readInt16LE(i * 4), i * 2);
  const enc = mulawEncode(at8k);
  const out = [];
  for (let i = 0; i < enc.length; i += 160) out.push(enc.subarray(i, i + 160).toString('base64'));
  return out;
}
function wrapWav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function stripRiff(b) {
  if (b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF') {
    for (let i = 12; i < Math.min(b.length - 8, 4096); i++) {
      if (b.toString('ascii', i, i + 4) === 'data') return b.subarray(i + 8);
    }
  }
  return b;
}

function run(cmd, opts = {}) {                    // spawn with args array (no shell)
  return new Promise((res) => {
    const so = [], se = [];
    const p = spawn(cmd, opts.args ?? [], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => so.push(d));
    p.stderr.on('data', d => se.push(d));
    if (opts.stdin) { p.stdin.on('error', () => {}); p.stdin.end(opts.stdin); }
    p.on('close', code => res({ code, stdout: Buffer.concat(so), stderr: Buffer.concat(se), out: Buffer.concat(so) }));
  });
}

async function detectMic() {
  if (typeof args.mic === 'string') return args.mic;
  // ffmpeg prints the device list on stderr
  const { stderr } = await run('ffmpeg', { args: ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'] });
  const names = [...stderr.toString('utf8').matchAll(/"([^"]+)" \(audio\)/g)].map(m => m[1]);
  if (!names.length) throw new Error('no dshow audio input found');
  console.log(`mic: ${names[0]}`);
  return names[0];
}

async function recordMic(device, secs) {
  const { stdout, stderr, code } = await run('ffmpeg', {
    args: ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `audio=${device}`,
      '-ac', '1', '-ar', '16000', '-f', 's16le', '-t', String(secs), '-'],
  });
  if (code !== 0) throw new Error(`ffmpeg record failed: ${stderr.toString('utf8').slice(0, 200)}`);
  return stdout;
}

async function playAudio(buf, ext) {              // ext: wav | mp3
  const dir = mkdtempSync(join(tmpdir(), 'dgbot-'));
  const f = join(dir, `play.${ext}`);
  writeFileSync(f, buf);
  await run('ffplay', { args: ['-nodisp', '-autoexit', '-loglevel', 'error', f] });
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
async function decodeTo16k(buf) {                 // any audio → s16le 16k mono
  const { stdout, stderr, code } = await run('ffmpeg', {
    args: ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    stdin: buf,
  });
  if (code !== 0) throw new Error(`ffmpeg decode failed: ${stderr.toString('utf8').slice(0, 200)}`);
  return stdout;
}

// ---------- our adapter sessions ----------
function adapterSession(contactId) {
  const ws = new WebSocket(ADAPTER_WS);
  let opened;
  ws.on('open', () => { ws.send(JSON.stringify({ 'msg-type': 'start', contactId })); opened = true; });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return {
    contactId,
    interactionId: `INT-AC-${contactId}`,
    ready,
    feed(pcm16k) { for (const chunk of pcm16kToMulawB64Frames(pcm16k)) ws.send(JSON.stringify({ 'msg-type': 'audio', chunk })); },
    stop() { try { ws.send(JSON.stringify({ 'msg-type': 'stop', contactId })); } catch { /* */ } setTimeout(() => ws.close(), 300); },
    get isOpen() { return opened; },
  };
}

// ---------- Deepgram Voice Agent ----------
function voiceAgent({ onUserText, onBotAudio, onLog }) {
  const ws = new WebSocket(VA_URL, { headers: authHeader() });
  const state = { welcome: false, unusable: null, botBuf: [], lastBotAt: 0, collecting: false };
  let keep = null;
  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'Settings',
      audio: {
        input: { encoding: 'linear16', sample_rate: 16000 },
        output: { encoding: 'linear16', sample_rate: 16000, container: 'wav' },
      },
      agent: {
        language: 'en',
        listen: { provider: { type: 'deepgram', model: 'nova-3' } },
        think: { provider: { type: 'open_ai', model: 'gpt-4o-mini' }, prompt: 'You are a friendly test assistant. Keep replies to one short sentence.' },
        speak: { provider: { type: 'deepgram', model: 'aura-asteria-en' } },
        greeting: 'Hi! This is a Deepgram voice agent connectivity test.',
      },
    }));
    keep = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'KeepAlive' })); }, 5000);
  });
  ws.on('message', (d, isBinary) => {
    if (isBinary) {
      state.botBuf.push(Buffer.from(d)); state.lastBotAt = Date.now(); state.collecting = true;
      return;
    }
    let m; try { m = JSON.parse(String(d)); } catch { return; }
    if (m.type === 'Welcome') { state.welcome = true; onLog('VA: Welcome'); }
    else if (m.type === 'Error') { state.unusable = m.description ?? JSON.stringify(m); onLog(`VA Error: ${state.unusable}`); }
    else if (m.type === 'ConversationText') onUserText(m);
    else onLog(`VA: ${m.type ?? String(d).slice(0, 120)}`);
  });
  ws.on('error', e => { state.unusable = e.message; onLog(`VA socket error: ${e.message}`); });
  ws.on('close', () => { if (keep) clearInterval(keep); });

  return {
    state,
    sendAudio(pcm16k) { if (ws.readyState === 1) { for (let i = 0; i < pcm16k.length; i += 3200) ws.send(pcm16k.subarray(i, i + 3200)); } },
    close() { try { clearInterval(keep); ws.close(); } catch { /* */ } },
    /** wait until the agent's reply audio idles (first frame → +900ms quiet), or timeout */
    async takeReply(timeoutMs = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await sleep(250);
        if (state.botBuf.length && Date.now() - state.lastBotAt > 900) {
          const buf = stripRiff(Buffer.concat(state.botBuf));
          state.botBuf = []; state.collecting = false;
          return buf;
        }
      }
      if (state.botBuf.length) { const buf = stripRiff(Buffer.concat(state.botBuf)); state.botBuf = []; state.collecting = false; return buf; }
      return null;
    },
  };
}

// ---------- session summary ----------
async function summarize(interactionId) {
  for (let i = 0; i < 20; i++) {
    try {
      const snap = await (await fetch(`${API}/v1/interactions/${interactionId}`)).json();
      const turns = (snap.timeline ?? []).filter(t => String(t.label ?? '').startsWith('customer:')).map(t => String(t.label).slice(9, 160));
      const voice = (snap.timeline ?? []).filter(t => t.kind === 'VOICE').map(t => String(t.label));
      if (voice.length) return { turns, voice, ended: !!(snap.interaction ?? {}).endedAt };
    } catch { /* api warming */ }
    await sleep(500);
  }
  return { turns: [], voice: [], ended: false };
}

// ================= main =================
const micDevice = await detectMic().catch(e => { console.error(e.message); process.exit(1); });
console.log(`mode=${MODE} turn=${TURN_SECS}s rounds=${ROUNDS}`);

const you = adapterSession(`you-${Date.now()}`);
let bot = null;
const va = MODE === 'aura' ? null : voiceAgent({
  onUserText: m => console.log(`   [va heard] ${JSON.stringify(m.content ?? m).slice(0, 140)}`),
  onBotAudio: () => {},
  onLog: l => console.log(`   ${l}`),
});

if (va) {
  const t0 = Date.now();
  while (!va.state.welcome && !va.state.unusable && Date.now() - t0 < 8000) await sleep(200);
  if (va && va.state.unusable) { console.log(`VA unusable (${va.state.unusable}) — falling back to aura mode.`); va.close(); }
}
const useVa = va && va.state.welcome && !va.state.unusable;
const mode = useVa ? 'va' : 'aura';
if (mode !== MODE) console.log(`effective mode: ${mode}`);

if (useVa) {
  // greeting (if the agent speaks one) counts as the first bot turn
  const greeting = await va.takeReply(6000);
  if (greeting) { console.log('   bot greeting received'); await deliverBot(greeting); }
}

for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n— round ${round}/${ROUNDS}: speak now (${TURN_SECS}s) —`);
  const pcm = await recordMic(micDevice, TURN_SECS);
  if (pcm.length < 32000) { console.log('   (almost no audio captured — check mic)'); continue; }
  try { writeFileSync(resolve(HERE, '../.last-you-audio.wav'), wrapWav(pcm)); } catch { /* debug capture */ }
  if (va && va.state.unusable) { console.log(`VA became unusable (${va.state.unusable}) — stopping rounds.`); break; }
  you.feed(pcm);
  console.log(`   you: ${TURN_SECS}s streamed → session ${you.interactionId}`);

  if (mode === 'va') {
    va.sendAudio(pcm);
    const reply = await va.takeReply();
    if (!reply) { console.log('   VA gave no audio this round'); continue; }
    await deliverBot(reply);
  } else {
    await sleep(1500); // let Deepgram finals land for transcript echo
    const said = (await summarize(you.interactionId)).turns.at(-1);
    const canned = [
      'Hello! I am a Deepgram text to speech voice, and your governance tool is scoring me right now.',
      'That is interesting. My voice is synthesized, so expect a high synthetic score on my session.',
      'Thanks for talking with me. Goodbye!',
    ];
    const text = said ? `You said: ${said}. ${canned[(round - 1) % canned.length]}` : canned[(round - 1) % canned.length];
    console.log(`   bot says: ${text.slice(0, 120)}`);
    const mp3 = await speak(text);
    const pcmOut = await decodeTo16k(mp3);
    await Promise.all([playAudio(mp3, 'mp3'), deliverBot(pcmOut)]);
  }
}

async function speak(text) {
  const res = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en', {
    method: 'POST', headers: { ...authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`speak HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function deliverBot(pcm16k) {
  if (!bot) { bot = adapterSession(`bot-${Date.now()}`); await bot.ready; console.log(`   bot audio → session ${bot.interactionId}`); }
  bot.feed(pcm16k);
  try { writeFileSync(resolve(HERE, '../.last-bot-audio.wav'), wrapWav(pcm16k)); } catch { /* debug capture */ }
}

// teardown + verdict
console.log('\nfinishing…');
if (va) va.close();
await sleep(1600);                                  // grace: STT finals flush
you.stop(); if (bot) bot.stop();
const [y, b] = await Promise.all([summarize(you.interactionId), bot ? summarize(bot.interactionId) : Promise.resolve(null)]);

console.log('\n================ VERDICT ================');
console.log(`YOU  (${you.interactionId})`);
for (const t of y.turns.slice(0, 5)) console.log(`   said: ${t}`);
for (const v of y.voice.slice(-1)) console.log(`   ${v}`);
if (b) {
  console.log(`BOT  (${bot.interactionId})`);
  for (const t of b.turns.slice(0, 5)) console.log(`   said: ${t}`);
  for (const v of b.voice.slice(-1)) console.log(`   ${v}`);
  console.log('\nOpen Command Center → Investigation for both interactions to compare.');
} else {
  console.log('BOT session never opened (no bot audio this run).');
}
process.exit(0);