// Scripted-demo runner tests with an in-process mock governance server —
// asserts the exact normalized event sequence (create → participant → voice →
// turns → evaluate → end) and canned production-shaped evaluate decisions
// (R001_SYNTHETIC_VOICE_BLOCK / DENY), per the task's mock contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NiceCxoneConnector, detectSensitiveAction, DEMO_NICE_AI_ANI } from '../src/index.ts';

interface Recorded { method: string; path: string; body: Record<string, unknown> }

let mockServer: http.Server;
let mockBase: string;
let calls: Recorded[];

/** Snapshot derived from the participant registration of the SAME interaction. */
function snapshotFor(rec: Recorded[], interactionId: string) {
  const part = [...rec].reverse()
    .find(c => c.path.endsWith('/participant') && c.path.includes(interactionId));
  const classification = part ? String((part.body as { classification?: string }).classification ?? 'HUMAN_UNKNOWN') : 'HUMAN_UNKNOWN';
  return { participants: [{ participantId: 'customer', classification }], risk: { overall: classification === 'UNKNOWN_AI' ? 67 : 12 } };
}

test.before(async () => {
  calls = [];
  mockServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* empty */ }
      calls.push({ method: req.method ?? '', path, body });
      const m = path.match(/^\/v1\/interactions\/([^/]+)/);
      const id = m ? m[1] : String(body.interactionId ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (path === '/v1/interactions') {
        res.end(JSON.stringify({ interactionId: body.interactionId, ...snapshotFor(calls, id) }));
      } else if (path.endsWith('/actions')) {
        const sensitive = ['CHANGE_BANK_ACCOUNT', 'MONEY_TRANSFER', 'ISSUE_REFUND', 'CREDIT_DECISION'].includes(String(body.requestedAction));
        const cls = snapshotFor(calls, id).participants[0].classification;
        res.end(JSON.stringify({
          decision: sensitive && cls === 'UNKNOWN_AI'
            ? { allowed: false, matchedRule: 'R001_SYNTHETIC_VOICE_BLOCK', actions: ['DENY', 'STEP_UP_AUTH', 'HANDOFF_TO_HUMAN'] }
            : { allowed: true, matchedRule: 'DEFAULT_ALLOW', actions: ['ALLOW'] },
        }));
      } else if (m && req.method === 'GET') {
        res.end(JSON.stringify(snapshotFor(calls, id)));
      } else if (path.endsWith('/end')) {
        res.end(JSON.stringify({ ended: true }));
      } else {
        res.end(JSON.stringify(snapshotFor(calls, id)));
      }
    });
  });
  await new Promise<void>(r => mockServer.listen(0, () => r()));
  mockBase = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
  const { setApiBase } = await import('../src/index.ts');
  setApiBase(mockBase);
});

test.after(() => { mockServer.close(); });

test('demo runner returns one summary per scripted interaction (2)', async () => {
  calls.length = 0;
  const connector = new NiceCxoneConnector();
  const summaries = await connector.runDemo();
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].scenario, 'benign-balance-voice');
  assert.equal(summaries[1].scenario, 'unregistered-ai-money-action');
});

test('benign interaction: turns appended, no evaluate call, not blocked', async () => {
  calls.length = 0;
  const connector = new NiceCxoneConnector();
  const [benign] = await connector.runDemo();
  assert.equal(benign.blocked, false);
  assert.equal(benign.matchedRule, null);
  assert.equal(benign.classification, 'HUMAN_UNKNOWN');
  const paths = calls.filter(c => c.path.includes('nice-demo-benign-1')).map(c => `${c.method} ${c.path}`);
  assert.deepEqual(paths.filter(p => p.includes('/actions')), [], 'no evaluate for a balance question');
  const turns = calls.filter(c => c.path.endsWith('/turns') && c.path.includes('nice-demo-benign-1'));
  assert.equal(turns.length, 3, '2 customer + 1 agent turns normalized');
  assert.ok(calls.some(c => c.path === '/v1/interactions' && c.method === 'POST'), 'session created');
  assert.ok(calls.some(c => c.path.endsWith('/end') && c.path.includes('nice-demo-benign-1')), 'session ended');
});

test('AI interaction: participant registered UNKNOWN_AI, money action → R001 DENY surfaced', async () => {
  calls.length = 0;
  const connector = new NiceCxoneConnector();
  const [, ai] = await connector.runDemo();
  assert.equal(ai.blocked, true);
  assert.equal(ai.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
  assert.equal(ai.classification, 'UNKNOWN_AI');
  assert.equal(ai.risk, 67);
  const part = calls.find(c => c.path.endsWith('/participant') && c.path.includes('nice-demo-ai-1'));
  assert.ok(part, 'customer participant registered');
  assert.equal(part.body.classification, 'UNKNOWN_AI', 'aiSuspected/bot metadata maps to UNKNOWN_AI at registration');
  const action = calls.find(c => c.path.endsWith('/actions') && c.path.includes('nice-demo-ai-1')
    && c.body.requestedAction === 'CHANGE_BANK_ACCOUNT');
  assert.ok(action, 'sensitive phrase triggered trust evaluate');
  assert.equal(action.body.intent, 'CHANGE_BANK_ACCOUNT');
});

test('normalized call order for the AI interaction matches create→participant→voice→turns→actions→end', async () => {
  calls.length = 0;
  const connector = new NiceCxoneConnector();
  await connector.runDemo();
  const ID = 'INT-NICE-nice-demo-ai-1';
  const seq = calls
    .map(c => {
      if (c.path === '/v1/interactions' && c.method === 'POST' && c.body.interactionId === ID) return '/v1/interactions';
      if (c.path.includes(ID)) return c.path.slice(c.path.indexOf(ID) + ID.length) || ':id';
      return null; // belongs to the benign interaction
    })
    .filter((p): p is string => p !== null);
  // NOTE: the first AI turn ('recover my account') itself carries an
  // ACCOUNT_RECOVERY intent, so evaluate fires on BOTH money turns.
  assert.deepEqual(seq, [
    '/v1/interactions',
    '/participant',
    '/voice',
    '/turns',
    '/actions',
    '/turns',
    '/actions',
    ':id', // snapshot read
    '/end',
  ]);
});

test('PARTICIPANT_JOIN-only payload on a bot channel still registers UNKNOWN_AI and no turns', async () => {
  calls.length = 0;
  const connector = new NiceCxoneConnector();
  const s = await connector.processInteraction({
    interactionId: 'nice-join-only',
    mediaType: 'CHAT',
    metadata: { botId: 'bot-77' },
    events: [{ type: 'PARTICIPANT_JOIN' }],
  });
  assert.equal(s.classification, 'UNKNOWN_AI', 'botId metadata counts as bot presence');
  assert.equal(s.blocked, false);
  assert.equal(calls.filter(c => c.path.endsWith('/turns')).length, 0);
});

test('detectSensitiveAction: CHANGE_BANK_ACCOUNT-style phrases like the genesys demo script', () => {
  assert.equal(detectSensitiveAction('Change my bank account to the new one and move my funds today.'), 'CHANGE_BANK_ACCOUNT');
  assert.equal(detectSensitiveAction('please update my bank account details'), 'CHANGE_BANK_ACCOUNT');
  assert.equal(detectSensitiveAction('wire my funds to this new routing number'), 'MONEY_TRANSFER');
  assert.equal(detectSensitiveAction('I need a refund for last month'), 'ISSUE_REFUND');
  assert.equal(detectSensitiveAction('I lost my phone, recover my account'), 'ACCOUNT_RECOVERY');
  assert.equal(detectSensitiveAction('Hi, can you tell me my checking account balance?'), null);
  assert.equal(detectSensitiveAction('what are your office hours?'), null);
});

test('AI demo ANI without payload flags still scores synthetic via demo analyzer seam', async () => {
  calls.length = 0;
  const connector = new NiceCxoneConnector();
  const s = await connector.processInteraction({
    interactionId: 'nice-ani-only',
    ani: DEMO_NICE_AI_ANI,
    mediaType: 'VOICE',
    events: [{ type: 'CUSTOMER_MESSAGE', text: 'change my bank account' }],
  }, 'ani-only');
  // no aiSuspected/bot metadata → registration stays HUMAN_UNKNOWN; but the
  // sensitive phrase still reaches evaluate and the mock denies AI class only,
  // so this must NOT be blocked (honest signal-driven behavior)
  assert.equal(s.blocked, false);
  assert.equal(s.classification, 'HUMAN_UNKNOWN');
});
