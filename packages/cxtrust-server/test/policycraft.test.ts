// POST /v1/policy/compile — natural-language authoring route. Proves the
// full authoring loop stays honest: deterministic compile (no eval), errors
// reported with line numbers, and the compiled artifact feeds the simulator.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '@cxtrust/core';
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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => { server?.close(); });

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

test('compile: happy NL text → deterministic Policy artifact + rendered rules', async () => {
  const r = await post('/v1/policy/compile', {
    text: 'IF synthetic voice probability is greater than 0.9 AND requested action is CHANGE_BANK_ACCOUNT THEN deny and step up authentication',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const policy = r.data.policy as { policyId: string; rules: Array<{ id: string; actions: string[]; severity: string }> };
  assert.equal(policy.rules.length, 1);
  assert.equal(policy.rules[0].id, 'NL_1');
  assert.deepEqual(policy.rules[0].actions, ['DENY', 'STEP_UP_AUTH']);
  assert.equal(policy.rules[0].severity, 'CRITICAL');
  assert.equal((r.data.rendered as string[])[0].includes('syntheticVoiceProbability'), true);
});

test('compile: error text → ok:false with line-numbered errors', async () => {
  const r = await post('/v1/policy/compile', {
    text: 'IF zorb score is greater than 3 THEN deny',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false);
  const errors = r.data.errors as Array<{ line: number; message: string }>;
  assert.ok(errors.length >= 1);
  assert.equal(errors[0].line, 1);
  assert.match(errors[0].message, /zorb|unknown field/i);
});

test('compile: empty text → 400', async () => {
  const r = await post('/v1/policy/compile', { text: '   ' });
  assert.equal(r.status, 400);
});

test('authoring loop: compiled NL policy feeds /v1/simulate as candidate', async () => {
  const c = await post('/v1/policy/compile', {
    text: 'IF risk score is at least 60 THEN transfer to human',
  });
  assert.equal(c.data.ok, true);
  const s = await post('/v1/simulate', { candidate: c.data.policy });
  assert.equal(s.status, 200);
  const totals = s.data.totals as { scenariosCompared: number };
  assert.equal(totals.scenariosCompared, SCENARIOS.length);
});
