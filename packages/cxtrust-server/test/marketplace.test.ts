// Marketplace endpoint tests (additive): list shapes, publish/install, RBAC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const ADMIN = 'tok-admin-mkt';
const SEC = 'tok-sec-mkt';

const UNSIGNED_MANIFEST = {
  pluginId: 'plugin-unsigned-test',
  name: 'Unsigned Test Plugin',
  version: '1.0.0',
  kind: 'voice-analyzer',
  author: { name: 'Test Author', organizationId: 'org-test' },
  description: 'test',
  homepage: 'https://example.com/t',
  entrypoint: './local/plugin',
  permissions: ['network-egress'],
  license: 'MIT',
  cxtrustMinVersion: '1.0.0',
};

let server: Server;
let base = '';

test.before(async () => {
  const store = new SqliteStore(':memory:');
  server = createApi({
    port: 0,
    store,
    rbac: { adminTokens: [ADMIN], orgTokens: [`${SEC}:orgA:SECURITY_ANALYST`] },
  });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => { server.close(); });

async function req(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('marketplace list endpoint shape', async () => {
  const r = await req('GET', '/v1/marketplace', undefined, ADMIN);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.plugins));
  assert.equal(typeof r.json.platformVersion, 'string');
  // publish unsigned, then check list shape fields
  const pub = await req('POST', '/v1/marketplace/publish', UNSIGNED_MANIFEST, ADMIN);
  assert.equal(pub.status, 201);
  assert.equal(pub.json.status, 'unverified');
  const r2 = await req('GET', '/v1/marketplace', undefined, ADMIN);
  const p = (r2.json.plugins as Record<string, unknown>[]).find(x => x.id === 'plugin-unsigned-test');
  assert.ok(p, 'published plugin listed');
  for (const field of ['id', 'name', 'kind', 'author', 'status', 'permissions', 'riskFlags']) {
    assert.ok(field in p!, `list entry has ${field}`);
  }
  assert.equal(p!.status, 'unverified');
  assert.ok(Array.isArray(p!.riskFlags));
});

test('non-admin publish rejected (403)', async () => {
  const r = await req('POST', '/v1/marketplace/publish', UNSIGNED_MANIFEST, SEC);
  assert.equal(r.status, 403);
});

test('unsigned install blocked (409); missing approver 400', async () => {
  const noApprover = await req('POST', '/v1/marketplace/install', { pluginId: 'plugin-unsigned-test' }, ADMIN);
  assert.equal(noApprover.status, 400);
  const r = await req('POST', '/v1/marketplace/install', { pluginId: 'plugin-unsigned-test', approver: 'ops@x', justification: 'why' }, ADMIN);
  assert.equal(r.status, 409);
  const rec = r.json as Record<string, unknown>;
  assert.equal(rec.status, 'blocked');
  assert.match(String(rec.reason), /only verified plugins/);
});

test('unknown plugin install -> 404; incompatible version -> 409', async () => {
  const r404 = await req('POST', '/v1/marketplace/install', { pluginId: 'nope', approver: 'a@b' }, ADMIN);
  assert.equal(r404.status, 404);
  await req('POST', '/v1/marketplace/publish', { ...UNSIGNED_MANIFEST, pluginId: 'plugin-future', cxtrustMinVersion: '9.0.0' }, ADMIN);
  const r = await req('POST', '/v1/marketplace/install', { pluginId: 'plugin-future', approver: 'a@b', justification: 'j' }, ADMIN);
  assert.equal(r.status, 409);
});
