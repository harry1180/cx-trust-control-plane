import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base = '';

test.before(async () => {
  const store = new SqliteStore(':memory:');
  server = createApi({ port: 0, store });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => { server.close(); });

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('executive summary rolls up benign + attack interactions', async () => {
  // Benign interaction: verified customer, low risk, no blocks.
  const benign = await req('POST', '/v1/interactions', {
    interactionId: 'INT-exec-benign', organizationId: 'org-demo', platform: 'exec-test-voice',
  });
  assert.equal(benign.status, 201);
  await req('POST', '/v1/interactions/INT-exec-benign/participant', {
    participantId: 'p-caller', interactionId: 'INT-exec-benign', organizationId: 'org-demo',
    kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  await req('POST', `/v1/interactions/INT-exec-benign/auth`, { participantId: 'p-caller', result: 'SUCCESS', level: 'HIGH' });
  await req('POST', `/v1/interactions/INT-exec-benign/turns`, {
    participantId: 'p-caller', text: 'Hi, can you tell me my checking account balance?', offsetS: 5,
  });
  const benignAct = await req('POST', '/v1/interactions/INT-exec-benign/actions', {
    requestedAction: 'READ_BALANCE', participantId: 'p-caller', intent: 'BALANCE_INQUIRY',
  });
  assert.equal(benignAct.status, 200);
  assert.equal((benignAct.json.decision as { allowed: boolean }).allowed, true);
  await req('POST', '/v1/interactions/INT-exec-benign/end');

  // Attack interaction: synthetic voice + fraud transcript + blocked transfer with amount.
  const attack = await req('POST', '/v1/interactions', {
    interactionId: 'INT-exec-attack', organizationId: 'org-demo', platform: 'exec-test-voice',
  });
  assert.equal(attack.status, 201);
  await req('POST', '/v1/interactions/INT-exec-attack/participant', {
    participantId: 'p-caller', interactionId: 'INT-exec-attack', organizationId: 'org-demo',
    kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  await req('POST', '/v1/interactions/INT-exec-attack/voice', {
    participantId: 'p-caller', syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9,
  });
  await req('POST', '/v1/interactions/INT-exec-attack/turns', {
    participantId: 'p-caller', text: 'This is the fraud department. Read me the one time code we just sent.', offsetS: 6,
  });
  await req('POST', '/v1/interactions/INT-exec-attack/turns', {
    participantId: 'p-caller', text: 'Wire the money to the new account today or else.', offsetS: 12,
  });
  const attackAct = await req('POST', '/v1/interactions/INT-exec-attack/actions', {
    requestedAction: 'MONEY_TRANSFER', participantId: 'p-caller', amount: 9000, intent: 'MONEY_TRANSFER',
  });
  assert.equal(attackAct.status, 200);
  const attackDecision = attackAct.json.decision as { allowed: boolean; subject?: { amount?: number } };
  assert.equal(attackDecision.allowed, false);
  assert.equal(attackDecision.subject?.amount, 9000);
  await req('POST', '/v1/interactions/INT-exec-attack/end');

  // Executive summary for the org.
  const exec = await req('GET', '/v1/executive/org-demo');
  assert.equal(exec.status, 200);
  const s = exec.json as Record<string, unknown>;
  assert.equal(s.organizationId, 'org-demo');

  // Governed: at least the two seeded interactions are counted.
  const governed = Number(s.governed);
  assert.ok(governed >= 2, `governed ${governed} >= 2`);

  // Blocked decisions exist and the fraud-prevented estimate carries the amount.
  const blocked = Number(s.blockedTransactions);
  assert.ok(blocked >= 1, `blockedTransactions ${blocked} >= 1`);
  const est = Number(s.estFraudPreventedUsd);
  assert.ok(est > 0, `estFraudPreventedUsd ${est} > 0 (blocked decision carried amount 9000)`);
  assert.ok(String(s.estFraudPreventedBasis).includes('LOWER_BOUND'));

  // Fraud detections derived from the attack transcript.
  assert.ok(Number(s.fraudAttempts) >= 1);
  // Deepfake: synthetic voice detection from the voice provider result.
  assert.ok(Number(s.deepfakeAttempts) >= 1);
  assert.ok(Number(s.meanPolicyLatencyMs) >= 0);
  // Platform breakdown has entries for the seeded platform.
  const byPlatform = s.byPlatform as Record<string, number>;
  assert.ok((byPlatform['exec-test-voice'] ?? 0) >= 2);
  // Incidents: the attack produced at least one enforcement incident.
  assert.ok(Number(s.incidents) >= 1);
  const bySeverity = s.bySeverity as Record<string, number>;
  assert.ok(Object.values(bySeverity).reduce((a, b) => a + b, 0) >= 1);
});

test('executive reasons endpoint returns sorted labels', async () => {
  const r = await req('GET', '/v1/executive/org-demo/reasons');
  assert.equal(r.status, 200);
  const reasons = r.json.reasons as { label: string; points: number }[];
  assert.ok(Array.isArray(reasons));
  assert.ok(reasons.length > 0, 'reasons present after seeded interactions');
  for (let i = 1; i < reasons.length; i++) {
    assert.ok(reasons[i - 1].points >= reasons[i].points, 'sorted desc by points');
  }
  for (const x of reasons) {
    assert.equal(typeof x.label, 'string');
    assert.ok(x.label.length > 0);
    assert.ok(typeof x.points === 'number');
  }
});
