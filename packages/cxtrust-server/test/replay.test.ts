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

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('replay endpoint returns timeline, decisions, detections, chain', async () => {
  // Build a governed interaction over the API like the real flow.
  const start = await req('POST', '/v1/interactions', {
    interactionId: 'INT-replay-test', organizationId: 'org-replay', platform: 'test-platform',
  });
  assert.equal(start.status, 201);

  await req('POST', '/v1/interactions/INT-replay-test/participant', {
    participantId: 'p-caller', interactionId: 'INT-replay-test', organizationId: 'org-replay',
    kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  await req('POST', '/v1/interactions/INT-replay-test/voice', {
    participantId: 'p-caller', syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9,
  });
  await req('POST', '/v1/interactions/INT-replay-test/turns', {
    participantId: 'p-caller', text: 'Move all my funds to a new account now.', offsetS: 8,
  });
  const act = await req('POST', '/v1/interactions/INT-replay-test/actions', {
    requestedAction: 'CHANGE_BANK_ACCOUNT', participantId: 'p-caller', intent: 'CHANGE_BANK_ACCOUNT',
  });
  assert.equal(act.status, 200);

  // Replay while the session is still live.
  const live = await req('GET', '/v1/interactions/INT-replay-test/replay');
  assert.equal(live.status, 200);
  const liveTl = live.json.timeline as { kind: string }[];
  assert.ok(liveTl.length > 0);
  assert.ok(liveTl.some(t => t.kind === 'TRANSCRIPT'));
  assert.ok(liveTl.some(t => t.kind === 'DETECTION'));
  assert.ok(liveTl.some(t => t.kind === 'POLICY'));
  assert.ok((live.json.detections as unknown[]).length > 0);
  assert.equal(live.json.chainValid, true);
  assert.ok(Number(live.json.evidenceCount) > 0);
  assert.ok((live.json.decisions as unknown[]).length > 0);

  await req('POST', '/v1/interactions/INT-replay-test/end');

  // Replay from the persisted store after the session is gone.
  const r = await req('GET', '/v1/interactions/INT-replay-test/replay');
  assert.equal(r.status, 200);
  const interaction = r.json.interaction as { interactionId: string; platform: string; organizationId: string; peakRisk: number };
  assert.ok(interaction, 'interaction present');
  assert.equal(interaction.interactionId, 'INT-replay-test');
  assert.equal(interaction.platform, 'test-platform');
  assert.equal(interaction.organizationId, 'org-replay');
  assert.ok(Number(interaction.peakRisk) > 0);

  const timeline = r.json.timeline as { kind: string; refId?: string; label: string; detail?: string; offsetS: number }[];
  assert.ok(timeline.length > 0);
  const kinds = new Set(timeline.map(t => t.kind));
  assert.ok(kinds.has('TRANSCRIPT'), 'TRANSCRIPT entry present');
  assert.ok(kinds.has('DETECTION'), 'DETECTION entry present');
  assert.ok(kinds.has('POLICY'), 'POLICY entry present');

  // Detections reconstructed from timeline entries with refId starting 'det-'.
  const detections = r.json.detections as { refId?: string }[];
  assert.ok(Array.isArray(detections));
  for (const d of detections) assert.ok(d.refId && String(d.refId).startsWith('det-'));
  assert.ok(detections.length === timeline.filter(t => t.refId && t.refId.startsWith('det-')).length);

  // Decisions returned from the store.
  const decisions = r.json.decisions as Record<string, unknown>[];
  assert.ok(decisions.length > 0);
  assert.ok(decisions.some(d => d.allowed === false));

  // Chain valid + evidence count.
  assert.equal(r.json.chainValid, true);
  assert.ok(Number(r.json.evidenceCount) > 3);

  // Decisions endpoint agrees.
  const dec = await req('GET', '/v1/interactions/INT-replay-test/decisions');
  assert.equal((dec.json.decisions as unknown[]).length, decisions.length);
});

test('list filters by organizationId and platform', async () => {
  for (const [iid, org, plat] of [
    ['INT-filter-a', 'org-fx', 'platform-voice'],
    ['INT-filter-b', 'org-fx', 'platform-chat'],
    ['INT-filter-c', 'org-other', 'platform-voice'],
  ] as const) {
    const s = await req('POST', '/v1/interactions', { interactionId: iid, organizationId: org, platform: plat });
    assert.equal(s.status, 201);
    await req('POST', `/v1/interactions/${iid}/end`);
  }

  const byOrg = await req('GET', '/v1/interactions?organizationId=org-fx');
  const orgIds = (byOrg.json.interactions as { interactionId: string }[]).map(i => i.interactionId);
  assert.deepEqual(orgIds.sort(), ['INT-filter-a', 'INT-filter-b']);

  const byPlatform = await req('GET', '/v1/interactions?platform=platform-voice');
  const platIds = (byPlatform.json.interactions as { interactionId: string }[]).map(i => i.interactionId);
  assert.ok(platIds.includes('INT-filter-a'));
  assert.ok(platIds.includes('INT-filter-c'));
  assert.ok(!platIds.includes('INT-filter-b'));

  const byBoth = await req('GET', '/v1/interactions?organizationId=org-fx&platform=platform-chat');
  assert.deepEqual((byBoth.json.interactions as { interactionId: string }[]).map(i => i.interactionId), ['INT-filter-b']);

  const unfiltered = await req('GET', '/v1/interactions');
  assert.ok((unfiltered.json.interactions as unknown[]).length >= 3);

  // filter for an org with nothing → empty list
  const none = await req('GET', '/v1/interactions?organizationId=org-nothing');
  assert.deepEqual(none.json.interactions, []);
});
