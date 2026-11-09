// Threat Graph campaign routes: seeded scenarios must surface a campaign of
// >=2 attack interactions (shared demo voice signature), keep the benign
// caller out of it, and expose stored member rows per campaign.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, resetThreatGraphForTests } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let base = '';

test.before(async () => {
  resetThreatGraphForTests();
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

interface Campaign {
  campaignId: string;
  interactionIds: string[];
  sharedSignals: string[];
  phoneNumbers: string[];
  firstSeen: string;
  lastSeen: string;
  totalRisk: number;
  description: string;
}

async function runScenario(id: string): Promise<string> {
  const res = await req('POST', `/v1/scenarios/${id}`);
  assert.equal(res.status, 200, `scenario ${id} failed`);
  const snap = res.json.interaction as { interactionId: string };
  return snap.interactionId;
}

test('campaign routes: attack scenarios cluster, benign stays out', async () => {
  const deepfake = await runScenario('deepfake-ato');
  const fraud = await runScenario('fraud-campaign');
  const aiCaller = await runScenario('unknown-ai-caller');
  const benign = await runScenario('normal-customer');

  const list = await req('GET', '/v1/campaigns');
  assert.equal(list.status, 200);
  const summary = list.json.summary as { nodeCount: number; edgeCount: number; campaigns: Campaign[] };
  const campaigns = list.json.campaigns as Campaign[];

  assert.ok(summary.nodeCount > 0, 'expected graph nodes after scenario seeding');
  assert.ok(Array.isArray(campaigns));

  const attackIds = new Set([deepfake, fraud, aiCaller]);
  const campaign = campaigns.find(c =>
    c.interactionIds.filter(id => attackIds.has(id)).length >= 2
    && !c.interactionIds.includes(benign));
  assert.ok(campaign, `expected a campaign of >=2 attack interactions excluding the benign one; got ${JSON.stringify(campaigns.map(c => c.interactionIds))}`);

  // The benign interaction may appear in NO campaign at all: it shares no
  // synthetic-voice signature and raises no FRAUD detection codes.
  for (const c of campaigns) {
    assert.ok(!c.interactionIds.includes(benign), 'benign interaction must not join a campaign');
  }

  // Detail route: campaign + each member's stored row from the interaction store.
  const detail = await req('GET', `/v1/campaigns/${campaign.campaignId}`);
  assert.equal(detail.status, 200);
  const detailCampaign = detail.json.campaign as Campaign;
  assert.equal(detailCampaign.campaignId, campaign.campaignId);
  const members = detail.json.members as { interactionId: string; stored: Record<string, unknown> | null }[];
  assert.equal(members.length, campaign.interactionIds.length);
  for (const m of members) {
    assert.ok(m.stored, `missing stored row for ${m.interactionId}`);
    assert.equal((m.stored as { interactionId: string }).interactionId, m.interactionId);
  }

  const missing = await req('GET', '/v1/campaigns/camp-does-not-exist');
  assert.equal(missing.status, 404);
});
