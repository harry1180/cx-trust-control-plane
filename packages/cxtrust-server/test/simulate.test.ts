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

interface Totals { newlyBlocked: number; newlyAllowed: number; falsePositiveEstimate: number; scenariosCompared: number }
interface ResultRow { scenarioId: string; summary: { totalActions: number; baselineBlocked: number; candidateBlocked: number; newlyBlocked: number; newlyAllowed: number; falsePositiveEstimate: number }; diff: unknown[]; candidateDecisions: unknown[] }

test('GET /v1/simulate/candidates lists stricter + looser presets', async () => {
  const r = await req('GET', '/v1/simulate/candidates');
  assert.equal(r.status, 200);
  const candidates = r.json.candidates as { name: string; policyId: string; version: number }[];
  assert.ok(typeof r.json.note === 'string' && r.json.note.length > 0);
  const names = candidates.map(c => c.name);
  assert.ok(names.includes('stricter'));
  assert.ok(names.includes('looser'));
  for (const c of candidates) {
    assert.equal(typeof c.policyId, 'string');
    assert.equal(typeof c.version, 'number');
  }
});

test('POST /v1/simulate preset stricter: 8 results, newlyBlocked>=1, FP estimate>=1', async () => {
  const r = await req('POST', '/v1/simulate', { candidate: 'stricter' });
  assert.equal(r.status, 200);
  const results = r.json.results as ResultRow[];
  assert.equal(results.length, SCENARIOS.length);
  const totals = r.json.totals as Totals;
  assert.ok(totals.newlyBlocked >= 1, `newlyBlocked=${totals.newlyBlocked}`);
  assert.ok(totals.falsePositiveEstimate >= 1, `fp=${totals.falsePositiveEstimate}`);
  assert.equal(totals.scenariosCompared, SCENARIOS.length);
  assert.ok(results.every(x => typeof x.scenarioId === 'string' && x.summary.totalActions >= 0));
});

test('POST /v1/simulate preset looser: newlyAllowed>=1', async () => {
  const r = await req('POST', '/v1/simulate', { candidate: 'looser' });
  assert.equal(r.status, 200);
  assert.equal((r.json.results as ResultRow[]).length, SCENARIOS.length);
  const totals = r.json.totals as Totals;
  assert.ok(totals.newlyAllowed >= 1, `newlyAllowed=${totals.newlyAllowed}`);
});

test('POST /v1/simulate scenarioIds subset is honored', async () => {
  const r = await req('POST', '/v1/simulate', { candidate: 'stricter', scenarioIds: ['normal-customer', 'deepfake-ato'] });
  assert.equal(r.status, 200);
  const results = r.json.results as ResultRow[];
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(x => x.scenarioId).sort(), ['deepfake-ato', 'normal-customer']);
  assert.equal((r.json.totals as Totals).scenariosCompared, 2);
});

test('POST /v1/simulate custom Policy JSON (DENY amount gt 100) evaluates', async () => {
  const custom = {
    policyId: 'CUSTOM_TEST_POLICY',
    name: 'Custom test — deny transactions over 100',
    version: 1,
    failMode: 'CLOSED',
    rules: [{
      id: 'X1_DENY_BIG',
      description: 'Deny any action over $100',
      match: 'ALL',
      conditions: [{ field: 'amount', op: 'gt', value: 100 }],
      actions: ['DENY'],
      severity: 'HIGH',
    }],
  };
  const r = await req('POST', '/v1/simulate', { candidate: custom });
  assert.equal(r.status, 200);
  const results = r.json.results as ResultRow[];
  assert.equal(results.length, SCENARIOS.length);
  for (const row of results) {
    assert.equal(typeof row.scenarioId, 'string');
    assert.ok(Array.isArray(row.diff));
    assert.ok(Array.isArray(row.candidateDecisions));
    assert.equal(typeof row.summary.totalActions, 'number');
    assert.equal(typeof row.summary.candidateBlocked, 'number');
  }
  // The custom rule fires wherever an amount > 100 is requested: the
  // agent-over-limit scenario must be denied by X1_DENY_BIG.
  const over = results.find(x => x.scenarioId === 'agent-over-limit');
  assert.ok(over);
  const decisions = over.candidateDecisions as { matchedRule: string; policyId: string; allowed: boolean }[];
  assert.ok(decisions.some(d => d.matchedRule === 'X1_DENY_BIG' && d.policyId === 'CUSTOM_TEST_POLICY' && d.allowed === false));
  const totals = r.json.totals as Totals;
  assert.equal(totals.scenariosCompared, SCENARIOS.length);
});

test('POST /v1/simulate invalid candidate → 400 with a clear reason', async () => {
  const missingPolicyId = await req('POST', '/v1/simulate', {
    candidate: { version: 1, rules: [] },
  });
  assert.equal(missingPolicyId.status, 400);
  assert.match(String(missingPolicyId.json.error), /policyId/);

  const badOp = await req('POST', '/v1/simulate', {
    candidate: {
      policyId: 'P', version: 1,
      rules: [{ id: 'R', description: 'd', match: 'ALL', conditions: [{ field: 'amount', op: 'regex', value: 'x' }], actions: ['DENY'], severity: 'HIGH' }],
    },
  });
  assert.equal(badOp.status, 400);
  assert.match(String(badOp.json.error), /op 'regex'/);

  const badAction = await req('POST', '/v1/simulate', {
    candidate: {
      policyId: 'P', version: 1,
      rules: [{ id: 'R', description: 'd', match: 'ALL', conditions: [{ field: 'amount', op: 'gt', value: 1 }], actions: ['NUKE'], severity: 'HIGH' }],
    },
  });
  assert.equal(badAction.status, 400);
  assert.match(String(badAction.json.error), /NUKE/);

  const unknownPreset = await req('POST', '/v1/simulate', { candidate: 'bananas' });
  assert.equal(unknownPreset.status, 400);
  assert.match(String(unknownPreset.json.error), /unknown candidate preset/);

  const unknownScenario = await req('POST', '/v1/simulate', { candidate: 'stricter', scenarioIds: ['nope'] });
  assert.equal(unknownScenario.status, 400);
  assert.match(String(unknownScenario.json.error), /unknown scenario ids/);
});
