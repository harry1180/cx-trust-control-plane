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

interface PackView {
  packId: string; name: string; industry: string; description: string;
  detectionCount: number; policyRuleCount: number; refs: string[]; jurisdictions: string[];
}

test('GET /v1/packs returns the 4 industry packs with JSON-safe fields', async () => {
  const res = await fetch(`${base}/v1/packs`);
  assert.equal(res.status, 200);
  const body = await res.json() as { packs: PackView[] };
  assert.equal(body.packs.length, 4);
  const industries = body.packs.map(p => p.industry).sort();
  assert.deepEqual(industries, ['banking', 'healthcare', 'insurance', 'telecom']);
  for (const p of body.packs) {
    assert.equal(typeof p.packId, 'string');
    assert.match(p.packId, /^PACK_/);
    assert.equal(typeof p.name, 'string');
    assert.ok(p.description.length > 20);
    assert.ok(Number.isInteger(p.detectionCount) && p.detectionCount >= 4);
    assert.ok(Number.isInteger(p.policyRuleCount) && p.policyRuleCount >= 4);
    assert.ok(Array.isArray(p.refs) && p.refs.every(r => typeof r === 'string'));
    assert.ok(Array.isArray(p.jurisdictions) && p.jurisdictions.every(j => typeof j === 'string'));
  }
});

test('packs payload is fully JSON-serializable (regex patterns mapped to counts)', async () => {
  const body = await (await fetch(`${base}/v1/packs`)).json() as { packs: unknown };
  const s = JSON.stringify(body);
  const round = JSON.parse(s);
  assert.deepEqual(round, body);
  // detection patterns must never leak as raw objects/functions
  const str = JSON.stringify(body.packs);
  assert.ok(!str.includes('pattern'));
});
