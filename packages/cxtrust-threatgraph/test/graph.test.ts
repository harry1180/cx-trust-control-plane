// ThreatGraph tests — campaign clustering, shared signals, cross-platform proof.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ThreatGraph,
  correlateScenarios,
  DEMO_SYNTH_VOICE_HASH,
} from '../src/index.ts';
import {
  runScenario,
  SCENARIOS,
  GovernanceSession,
  type ScenarioDef,
  type GovernanceSnapshot,
} from '@cxtrust/core';

function run(def: ScenarioDef): GovernanceSnapshot {
  let snap: GovernanceSnapshot | undefined;
  runScenario(def, (s) => { snap = s; });
  if (!snap) throw new Error(`scenario ${def.id} produced no snapshot`);
  return snap;
}

function scenarioById(id: string): ScenarioDef {
  const def = SCENARIOS.find((s) => s.id === id);
  if (!def) throw new Error(`unknown scenario ${id}`);
  return def;
}

/** Build a synthetic-customer snapshot on an arbitrary platform (for cross-platform proof). */
function syntheticCustomerSnapshot(platform: string, interactionId: string): GovernanceSnapshot {
  const session = new GovernanceSession({
    interactionId,
    organizationId: 'org-demo',
    channel: 'voice',
    platform,
    startedAt: new Date().toISOString(),
    metadata: { scenario: `twilio-${platform}` },
  }, []);
  session.registerParticipant({
    participantId: 'p-caller', interactionId, organizationId: 'org-demo',
    kind: 'CUSTOMER', classification: 'UNKNOWN_PARTICIPANT', identityConfidence: 0.3,
    authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
  });
  session.applyVoiceAnalysis('p-caller', { syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9 });
  session.addTurn({ participantId: 'p-caller', text: 'Read me the one time code we just sent immediately.', offsetS: 4, partial: false });
  session.end();
  return session.snapshot();
}

test('shared voice signature links interactions with SHARED_VOICE_SIGNATURE edge', () => {
  const g = new ThreatGraph();
  const a = run(scenarioById('deepfake-ato'));
  const b = run(scenarioById('fraud-campaign'));
  g.addInteraction(a, { voiceSignatureHash: DEMO_SYNTH_VOICE_HASH });
  g.addInteraction(b, { voiceSignatureHash: DEMO_SYNTH_VOICE_HASH });
  const shared = g.edgeCount();
  assert.ok(shared >= 1, 'expected at least the voice-signature edge');
  const edges = (g as unknown as { edges: { type: string }[] }).edges;
  assert.ok(edges.some((e) => e.type === 'SHARED_VOICE_SIGNATURE'));
});

test('campaign detection clusters the 3+ synthetic fraud scenarios', () => {
  const { graph, scenarioById: byId, campaigns } = correlateScenarios(
    ['deepfake-ato', 'unknown-ai-caller', 'fraud-campaign', 'normal-customer'].map(scenarioById),
  );
  assert.equal(campaigns.length, 1, 'exactly one campaign expected');
  const ids = [...byId.entries()].map(() => campaigns[0].interactionIds);
  assert.ok(campaigns[0].interactionIds.length >= 3);
  assert.ok(ids.length >= 1);
  const nodeTypes = graph.nodesOfType('CAMPAIGN');
  assert.equal(nodeTypes.length, 0, 'campaigns are query results, not pre-created nodes');
});

test('benign scenarios are not part of any campaign', () => {
  const { scenarioById: byId, campaigns } = correlateScenarios(SCENARIOS);
  const benign = ['normal-customer', 'verified-agent-passport'];
  for (const c of campaigns) {
    for (const ixId of c.interactionIds) {
      const sc = byId.get(ixId);
      assert.ok(!benign.includes(sc ?? ''), `benign scenario ${sc} must not be in campaign ${c.campaignId}`);
    }
  }
  // 'verified-agent-passport' shares synthetic_voice code but is an authorized agent —
  // the demo only welds unregistered synthetic customers via the voice hash.
  assert.ok(campaigns.length >= 1);
});

test('phone node is created and linked to its interaction', () => {
  const g = new ThreatGraph();
  g.addInteraction(run(scenarioById('fraud-campaign')), { phone: '+15551230001' });
  const phones = g.nodesOfType('PHONE');
  assert.equal(phones.length, 1);
  assert.equal(phones[0].id, '+15551230001');
  const edges = (g as unknown as { edges: { from: string; type: string; to: string }[] }).edges;
  assert.ok(edges.some((e) => e.type === 'CALLED_FROM' && e.to === 'PHONE:+15551230001'));
});

test('cross-platform clustering: twilio interaction clusters with amazon-connect interactions', () => {
  const g = new ThreatGraph();
  const byId = new Map<string, string>();
  for (const def of ['deepfake-ato', 'unknown-ai-caller', 'fraud-campaign'].map(scenarioById)) {
    const snap = run(def);
    byId.set(snap.interaction.interactionId, def.id);
    g.addInteraction(snap, { voiceSignatureHash: DEMO_SYNTH_VOICE_HASH });
  }
  const twSnap = syntheticCustomerSnapshot('twilio', 'INT-TWILIO-CROSS-1');
  byId.set(twSnap.interaction.interactionId, 'twilio-cross');
  g.addInteraction(twSnap, { voiceSignatureHash: DEMO_SYNTH_VOICE_HASH });

  const campaigns = g.findCampaigns(3);
  assert.equal(campaigns.length, 1);
  const ids = campaigns[0].interactionIds;
  assert.ok(ids.includes('INT-TWILIO-CROSS-1'), 'twilio interaction joins the campaign');
  assert.ok(ids.length >= 4, 'twilio + 3 connect scenarios cluster');
  const platforms = new Set(
    ids.map((id) => (g as unknown as { interactions: Map<string, { platform: string }> }).interactions.get(id)!.platform),
  );
  assert.ok(platforms.has('twilio') && platforms.has('amazon-connect'), 'platform-blind clustering');
});

test('graphSummary counts are sane', () => {
  const { graph, summary } = correlateScenarios(SCENARIOS);
  assert.ok(summary.nodeCount > 0);
  assert.ok(summary.edgeCount > 0);
  assert.equal(summary.nodeCount, graph.nodeCount());
  assert.equal(summary.edgeCount, graph.edgeCount());
  assert.ok(summary.campaigns.length >= 1);
  assert.ok(summary.topSharedSignals.length >= 1);
  // campaign objects expose required fields
  const c = summary.campaigns[0];
  assert.match(c.campaignId, /^camp-[0-9a-f]{12}$/);
  assert.ok(c.totalRisk > 0);
  assert.ok(c.interactionIds.length >= 3);
});

test('correlating the actual SCENARIOS corpus finds the fraud campaign', () => {
  const { scenarioById: byId, campaigns } = correlateScenarios(SCENARIOS);
  assert.equal(campaigns.length, 1, 'only one campaign in the demo corpus');
  const campaign = campaigns[0];
  const scenarioIds = campaign.interactionIds.map((id) => byId.get(id)).sort();
  for (const expected of ['deepfake-ato', 'fraud-campaign', 'unknown-ai-caller']) {
    assert.ok(scenarioIds.includes(expected), `${expected} must be in the fraud campaign`);
  }
  assert.ok(!scenarioIds.includes('normal-customer'));
  assert.ok(!scenarioIds.includes('verified-agent-passport'));
  assert.ok(campaign.interactionIds.length >= 3);
});
