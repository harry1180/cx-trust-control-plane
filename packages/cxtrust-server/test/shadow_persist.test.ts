// Shadow-mode persistence: execution + wouldEnforceActions survive the store
// round-trip (decisions read back from sqlite after the session is gone).

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

// Force shadow on this API instance by patching the served policy through the
// seed policy's per-policy field (server injects the seed policy; here we use
// the env var path instead — set before creating the store interaction).
test('persisted decisions keep execution + wouldEnforceActions after session end', async () => {
  process.env.GOVERNANCE_MODE = 'shadow';
  try {
    const start = await req('POST', '/v1/interactions', { organizationId: 'org-shadow' });
    assert.equal(start.status, 201);
    const id = String(start.json.interactionId);
    await req('POST', `/v1/interactions/${id}/participant`, {
      participantId: 'p-s', interactionId: id, organizationId: 'org-shadow',
      kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
      authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
    });
    await req('POST', `/v1/interactions/${id}/voice`, {
      participantId: 'p-s', syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9,
    });
    await req('POST', `/v1/interactions/${id}/actions`, {
      requestedAction: 'CHANGE_BANK_ACCOUNT', participantId: 'p-s', intent: 'CHANGE_BANK_ACCOUNT',
    });
    await req('POST', `/v1/interactions/${id}/end`, {}); // persist + evict

    const dec = await req('GET', `/v1/interactions/${id}/decisions`);
    assert.equal(dec.status, 200);
    const decisions = dec.json.decisions as { execution?: string; wouldEnforceActions?: string[]; allowed: boolean }[];
    assert.ok(decisions.length >= 1);
    const shadowed = decisions.find(d => d.execution === 'shadow');
    assert.ok(shadowed, 'at least one persisted decision is shadow');
    assert.deepEqual(shadowed!.wouldEnforceActions, ['DENY', 'STEP_UP_AUTH', 'HANDOFF_TO_HUMAN']);
  } finally {
    delete process.env.GOVERNANCE_MODE;
  }
});
