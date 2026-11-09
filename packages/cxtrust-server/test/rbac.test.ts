// RBAC + multi-tenant isolation tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import { can, ROUTE_PERMISSIONS, ROLE_PERMISSIONS } from '../src/auth.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const ADMIN = 'tok-admin-root';
const ADMIN2 = 'tok-admin-two';
const SEC = 'tok-sec-orgA';
const CXA = 'tok-cxa-orgA';
const SVC = 'tok-svc-orgA';
const SVC_B = 'tok-svc-orgB';

let server: Server;
let base = '';

test.before(async () => {
  const store = new SqliteStore(':memory:');
  // Seed a foreign-org interaction so cross-org isolation is testable.
  server = createApi({
    port: 0,
    store,
    rbac: {
      adminTokens: [ADMIN, ADMIN2],
      orgTokens: [
        `${SEC}:orgA:SECURITY_ANALYST`,
        `${CXA}:orgA:CX_ANALYST`,
        `${SVC}:orgA:SERVICE`,
        `${SVC_B}:orgB:SERVICE`,
      ],
    },
  });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;

  // Create a foreign-org (orgB) interaction with evidence via the admin token.
  const r = await fetch(`${base}/v1/interactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ADMIN },
    body: JSON.stringify({ organizationId: 'orgB', interactionId: 'INT-orgB-1' }),
  });
  assert.equal(r.status, 201);
  await fetch(`${base}/v1/interactions/INT-orgB-1/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ADMIN },
    body: JSON.stringify({ participantId: 'p-b', text: 'wire the funds now', offsetS: 1 }),
  });
});

test.after(() => { server.close(); });

async function req(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-api-key': key } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('rbac matrix basics', () => {
  assert.equal(can('ADMIN', 'tokens:read'), true);
  assert.equal(can('SECURITY_ANALYST', 'evidence:read'), true);
  assert.equal(can('CX_ANALYST', 'evidence:read'), false);
  assert.equal(can('CX_ANALYST', 'interactions:read'), true);
  assert.equal(can('SERVICE', 'interactions:list'), false);
  assert.equal(can('SERVICE', 'turns:write'), true);
  assert.equal(can('SECURITY_ANALYST', 'turns:write'), false);
  assert.equal(ROUTE_PERMISSIONS['GET /v1/interactions/{id}/evidence'], 'evidence:read');
  assert.ok(ROLE_PERMISSIONS['CX_ANALYST'].includes('usage:read'));
});

test('unauthenticated request is 401 when auth enabled', async () => {
  const r = await req('GET', '/v1/interactions');
  assert.equal(r.status, 401);
  const bad = await req('GET', '/v1/interactions', undefined, 'wrong-key');
  assert.equal(bad.status, 401);
});

test('ADMIN can read everything cross-org, incl. masked tokens', async () => {
  const got = await req('GET', '/v1/interactions/INT-orgB-1', undefined, ADMIN2);
  assert.equal(got.status, 200);
  const ev = await req('GET', '/v1/interactions/INT-orgB-1/evidence', undefined, ADMIN);
  assert.equal(ev.status, 200);
  const list = await req('GET', '/v1/interactions', undefined, ADMIN);
  assert.equal(list.status, 200);
  const rows = list.json.interactions as { organizationId: string }[];
  assert.ok(rows.some(i => i.organizationId === 'orgB'));
  const tok = await req('GET', '/v1/tokens', undefined, ADMIN);
  assert.equal(tok.status, 200);
  const tokens = tok.json.tokens as { token: string }[];
  assert.ok(tokens.every(t => !t.token.includes('tok-admin-root') || t.token !== 'tok-admin-root'));
  assert.ok(tokens.some(t => t.token.includes('...') || t.token === '****'));
});

test('SERVICE cannot list interactions (403)', async () => {
  const r = await req('GET', '/v1/interactions', undefined, SVC);
  assert.equal(r.status, 403);
});

test('SERVICE can POST turns to own org, 404 on other org interaction', async () => {
  const start = await req('POST', '/v1/interactions', { interactionId: 'INT-orgA-1' }, SVC);
  assert.equal(start.status, 201);
  assert.equal((start.json.interaction as { organizationId: string }).organizationId, 'orgA');

  const own = await req('POST', '/v1/interactions/INT-orgA-1/turns',
    { participantId: 'p-a', text: 'help me', offsetS: 0 }, SVC);
  assert.equal(own.status, 200);

  const foreign = await req('POST', '/v1/interactions/INT-orgB-1/turns',
    { participantId: 'p-x', text: 'sneaky', offsetS: 0 }, SVC);
  assert.equal(foreign.status, 404);

  const foreignGet = await req('GET', '/v1/interactions/INT-orgB-1', undefined, SVC);
  assert.equal(foreignGet.status, 404);
});

test('CX_ANALYST blocked from evidence; SECURITY_ANALYST reads evidence fine', async () => {
  const blocked = await req('GET', '/v1/interactions/INT-orgA-1/evidence', undefined, CXA);
  assert.equal(blocked.status, 404);
  const tl = await req('GET', '/v1/interactions/INT-orgA-1/timeline', undefined, CXA);
  assert.equal(tl.status, 200);

  const sec = await req('GET', '/v1/interactions/INT-orgA-1/evidence', undefined, SEC);
  assert.equal(sec.status, 200);
  assert.equal(sec.json.chainValid, true);
  assert.ok((sec.json.evidence as unknown[]).length > 0);
});

test('cross-org list returns only own org rows', async () => {
  const svcB = await req('GET', '/v1/interactions', undefined, SVC_B);
  assert.equal(svcB.status, 403); // SERVICE cannot list at all
  const sec = await req('GET', '/v1/interactions', undefined, SEC);
  assert.equal(sec.status, 200);
  const rows = sec.json.interactions as { organizationId: string }[];
  assert.ok(rows.length > 0);
  assert.ok(rows.every(i => i.organizationId === 'orgA'));
});

test('client-supplied organizationId mismatch rejected for non-admin', async () => {
  const r = await req('POST', '/v1/interactions', { organizationId: 'orgB' }, SVC);
  assert.equal(r.status, 403);
  // cross-org usage read is 404 (no existence leak)
  const u = await req('GET', '/v1/usage/orgB', undefined, SEC);
  assert.equal(u.status, 404);
  const own = await req('GET', '/v1/usage/orgA', undefined, SEC);
  assert.equal(own.status, 200);
});

test('auth-off mode unchanged', async () => {
  const s = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => s.listen(0, r));
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const no = await fetch(`${b}/v1/agents`);
  assert.equal(no.status, 200); // anonymous access still allowed when auth off
  const nf = await fetch(`${b}/v1/tokens`);
  assert.equal(nf.status, 404); // token route only exists under rbac
  s.close();
});
