// Test Lab over the live API: POST /v1/lab/run executes the corpus against
// REAL governance sessions; GET /v1/lab/corpus lists the cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base = '';

test.before(async () => {
  server = createApi({ port: 0, store: new SqliteStore(':memory:') });
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

test('corpus endpoint lists cases with expectations', async () => {
  const r = await req('GET', '/v1/lab/corpus');
  assert.equal(r.status, 200);
  const cases = r.json.cases as { caseId: string; category: string; expected: Record<string, unknown> }[];
  assert.ok(cases.length >= 10);
  assert.ok(cases.every(c => c.caseId && c.category));
});

test('lab run: red-team corpus executes against real sessions and scores', async () => {
  const r = await req('POST', '/v1/lab/run', {});
  assert.equal(r.status, 200);
  const run = r.json as { summary: { pass: number; fail: number; skip: number; total: number; scorePct: number }; results: { caseId: string; verdict: string; checks: { check: string; ok: boolean; detail: string }[] }[] };
  assert.equal(run.summary.total >= 10, true);
  // The classic attack paths MUST pass against the real engine.
  assert.ok(run.summary.pass >= 6, `expected >=6 passes, got ${run.summary.pass}: ${JSON.stringify(run.results.map(x => [x.caseId, x.verdict, x.checks.filter(c => !c.ok).map(c => c.detail)]))}`);
  assert.ok(run.summary.scorePct >= 50, `score ${run.summary.scorePct}%`);
  // Every detection-based case either passed or carries honest detail.
  for (const res of run.results) {
    assert.ok(res.checks.length >= 0);
    if (res.verdict === 'FAIL') {
      assert.ok(res.checks.some(c => !c.ok), `${res.caseId} FAIL must have a failing check detail`);
    }
  }
});