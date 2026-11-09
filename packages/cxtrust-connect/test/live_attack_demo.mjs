// Live attack simulation against the running stack:
// API :8787 + Connect adapter :8799. Opens a real Connect media-stream
// WebSocket with a spoofed ANI, plays the attack call, then attempts the
// bank-account change through the adapter's enforcement gate.

import WebSocket from 'ws';

const API = 'http://127.0.0.1:8787';
const ADAPTER = 'http://127.0.0.1:8799';
const SPOOF = '+155' + '50001111';

async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. simulate Connect starting a media stream (start message over /ws)
const ws = new WebSocket('ws://127.0.0.1:8799/ws');
await new Promise(r => ws.on('open', r));
const start = await new Promise(resolve => {
  ws.on('message', d => resolve(JSON.parse(String(d))));
  ws.send(JSON.stringify({ 'msg-type': 'start', contactId: 'live-demo-1', customerPhoneNumber: SPOOF }));
});
console.log('1. media stream started → governed interaction', start.interactionId);

// 2. let the call play (scripted transcriber feeds turns into governance)
await sleep(3000);

// 3. snapshot from governance API
const snap = await api('GET', `/v1/interactions/${start.interactionId}`);
console.log('2. participants:', (snap.participants || []).map(p => `${p.kind}:${p.classification} (synthetic ${p.riskState?.syntheticVoiceProbability ?? '—'})`).join(' | '));
console.log('   risk:', snap.risk?.overall, 'detections:', (snap.detections || []).map(d => d.code).join(', '));

// 4. the fraudster attempts the account change through the Connect flow gate
const decision = await (await fetch(`${ADAPTER}/connect/action/live-demo-1`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ requestedAction: 'CHANGE_BANK_ACCOUNT', intent: 'CHANGE_BANK_ACCOUNT' }),
})).json();
console.log('3. enforcement gate →', decision.decision?.matchedRule, '| allowed:', decision.decision?.allowed, '| actions:', decision.decision?.actions?.join(', '));

// 5. end the contact
await fetch(`${ADAPTER}/connect/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ EventType: 'CONTACT_ENDED', ContactData: { ContactId: 'live-demo-1' } }) });
await sleep(500);

const ev = await api('GET', `/v1/interactions/${start.interactionId}/evidence`);
console.log('4. evidence chain valid:', ev.chainValid, '| records:', ev.evidence.length);
const usage = await api('GET', '/v1/usage/org-demo');
console.log('5. usage:', JSON.stringify(usage));
ws.close();
