// Opt-in hooks: behavioral-biometrics seam + trust-passport verification.
// Pure function-injection — core has zero dependency on @cxtrust/biometrics
// or @cxtrust/passport; these tests use hand-rolled fakes matching the
// provider shapes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GovernanceSession } from '../src/session.ts';
import type { AgentRegistration, Detection, Participant } from '../src/schema.ts';

function interaction() {
  return {
    interactionId: 'INT-HOOKS-1', organizationId: 'org-demo', channel: 'voice' as const,
    platform: 'test', startedAt: '2026-09-01T00:00:00Z', metadata: {},
  };
}

function registration(agentId: string): AgentRegistration {
  return {
    agentId, name: 'Test Agent', organizationId: 'org-demo', owner: 't@example.com',
    environment: 'PROD', modelProvider: 'internal', model: 'm1', purpose: 'tests',
    approvedChannels: ['voice'], approvedTools: [], approvedDomains: [],
    permittedDataClasses: ['INTERNAL'], permittedActions: ['CUSTOMER_LOOKUP'],
    maxTransactionLimit: 5000, riskClassification: 'MEDIUM',
    humanEscalationPolicy: 'escalate', jurisdiction: 'US', policyVersion: 4,
    deploymentVersion: '1.0.0',
  };
}

function participant(id: string, kind: Participant['kind'], agentId?: string,
  classification: Participant['classification'] = 'UNKNOWN_PARTICIPANT'): Participant {
  return {
    participantId: id, interactionId: 'INT-HOOKS-1', organizationId: 'org-demo',
    kind, classification, identityConfidence: 0.3, agentId, authLevel: 'NONE',
    joinedAtOffsetS: 0, riskState: {},
  };
}

function roboCadenceDetection(offsetS: number): Detection {
  return {
    detectionId: `det-robo-${offsetS}`, interactionId: 'INT-HOOKS-1', participantId: 'p-bot',
    category: 'AGENT_BEHAVIOR', code: 'robo_cadence',
    title: 'Robotic turn cadence (bot/IVR signature)', confidence: 0.8, weight: 14,
    ts: '2026-09-01T00:00:00Z', offsetS, evidence: [], providerId: 'behavioral-v1',
  };
}

test('behavioral hook: robo_cadence ingested exactly once across 6 regular-cadence turns', () => {
  let calls = 0;
  // mimics analyzeBehavior: once >=4 regular turns exist, the detector fires
  // on EVERY subsequent evaluation — session-side fire-once must dedupe it
  const behavioral = (turns: { participantId: string; text: string; offsetS: number }[]) => {
    calls++;
    if (turns.length < 4) return [];
    assert.ok(turns.every(t => t.participantId === 'p-bot'), 'hook receives final-turn list so far');
    return [roboCadenceDetection(turns[turns.length - 1].offsetS)];
  };
  const session = new GovernanceSession(interaction(), [], {}, undefined, { behavioral });
  session.registerParticipant(participant('p-bot', 'CUSTOMER'));
  for (let i = 0; i < 6; i++) {
    session.addTurn({ participantId: 'p-bot', text: 'I need my account now', offsetS: i * 2, partial: false });
  }
  const snap = session.snapshot();
  assert.equal(calls, 6, 'hook consulted on every final turn');
  const robs = snap.detections.filter(d => d.code === 'robo_cadence');
  assert.equal(robs.length, 1, 'fire-once per (code, participant): cadence signal not re-scored');
  assert.equal(robs[0].detectionId, 'det-robo-6', 'first firing is the one kept');
  // DIMENSION_OF maps robo_cadence → BEHAVIORAL_RISK
  assert.ok(snap.risk.dimensions.BEHAVIORAL_RISK > 0, 'robo_cadence fuses into BEHAVIORAL_RISK');
  assert.ok(session.verifyChain(), 'evidence chain still verifies');
});

test('passport hook untrusted: ENTERPRISE_AI downgraded to UNKNOWN_AI + timeline entry + risk boost', () => {
  const session = new GovernanceSession(
    { interactionId: 'INT-HOOKS-2', organizationId: 'org-demo', channel: 'voice', platform: 'test', startedAt: '2026-09-01T00:00:00Z', metadata: {} },
    [registration('AG-1')], {}, undefined,
    { passportCheck: () => ({ trusted: false, reasons: ['expired'] }) },
  );
  const p = participant('p-agent', 'ENTERPRISE_AI', 'AG-1', 'AUTHORIZED_ENTERPRISE_AI');
  session.registerParticipant(p);
  const snap = session.snapshot();
  assert.equal(p.classification, 'UNKNOWN_AI', 'zero trust: unverifiable = untrusted');
  assert.equal(p.passportVerified, false);
  assert.deepEqual(p.passportReasons, ['expired']);
  assert.ok(snap.timeline.some(t => t.kind === 'DETECTION' && t.label === 'Unverified agent passport → UNKNOWN_AI'),
    'timeline DETECTION entry recorded');
  assert.ok(snap.risk.reasons.some(r => r.label === 'unverified agent passport' && r.points === 15),
    'IDENTITY_RISK +15 context boost recorded');
  assert.equal(snap.risk.dimensions.IDENTITY_RISK, 15);
  // and the downgrade flows into policy: money action now hits R004 read-only denial
  const d = session.evaluateAction({ requestedAction: 'MONEY_TRANSFER', participantId: 'p-agent', amount: 100 });
  assert.equal(d.allowed, false);
});

test('passport hook trusted: no downgrade, verified flag set, R007 does NOT fire on money action', () => {
  const session = new GovernanceSession(interaction(), [registration('AG-1')], {}, undefined,
    { passportCheck: () => ({ trusted: true, reasons: [] }) });
  const p = participant('p-agent', 'ENTERPRISE_AI', 'AG-1', 'AUTHORIZED_ENTERPRISE_AI');
  session.registerParticipant(p);
  assert.equal(p.classification, 'AUTHORIZED_ENTERPRISE_AI', 'verified agent keeps classification');
  assert.equal(p.passportVerified, true);
  const d = session.evaluateAction({ requestedAction: 'CHANGE_BANK_ACCOUNT', participantId: 'p-agent' });
  assert.notEqual(d.matchedRule, 'R007_PASSPORT_REQUIRED', 'verified passport must not hit the passport gate');
  assert.ok(['DEFAULT_ALLOW', 'R005_UNREGISTERED_AGENT_NO_SENSITIVE', 'R003_AGENT_TX_LIMIT'].includes(d.matchedRule),
    `matchedRule ${d.matchedRule} should be a pre-existing rule or default`);
});

test('passport hook fires once per participant', () => {
  let n = 0;
  const session = new GovernanceSession(interaction(), [registration('AG-1')], {}, undefined,
    { passportCheck: () => { n++; return { trusted: true, reasons: [] }; } });
  session.registerParticipant(participant('p-agent', 'ENTERPRISE_AI', 'AG-1', 'AUTHORIZED_ENTERPRISE_AI'));
  session.registerParticipant(participant('p-agent', 'ENTERPRISE_AI', 'AG-1', 'AUTHORIZED_ENTERPRISE_AI'));
  session.addTurn({ participantId: 'p-agent', text: 'hello', offsetS: 5, partial: false });
  assert.equal(n, 1, 'passportCheck runs exactly once for the participant');
});

test('R007 fires for AI participant with no passport verification', () => {
  // no hook set, no agentId: an AI claiming verification on a money action is denied
  const session = new GovernanceSession(interaction(), [], {});
  session.registerParticipant(participant('p-ai', 'THIRD_PARTY_AI', undefined, 'VERIFIED_THIRD_PARTY_AI'));
  const d = session.evaluateAction({ requestedAction: 'MONEY_TRANSFER', participantId: 'p-ai', amount: 1000 });
  assert.equal(d.matchedRule, 'R007_PASSPORT_REQUIRED');
  assert.equal(d.allowed, false);
  assert.ok(d.actions.includes('DENY') && d.actions.includes('REQUIRE_APPROVAL'));
});

test('rule ordering: unverified-agent over-limit refund still resolves to R003 (first match wins)', () => {
  const session = new GovernanceSession(interaction(), [registration('AG-1')], {}, undefined,
    { passportCheck: () => ({ trusted: false, reasons: ['no passport attached'] }) });
  session.registerParticipant(participant('p-agent', 'ENTERPRISE_AI', 'AG-1', 'AUTHORIZED_ENTERPRISE_AI'));
  const d = session.evaluateAction({ requestedAction: 'ISSUE_REFUND', participantId: 'p-agent', amount: 25000 });
  assert.equal(d.matchedRule, 'R003_AGENT_TX_LIMIT', 'R003 placed before R007 keeps the tx-limit verdict');
});

test('hooks default-off: no behavioral ingestion, no passport fields, identical timeline', () => {
  const session = new GovernanceSession(interaction(), [registration('AG-1')]);
  const p = participant('p-agent', 'ENTERPRISE_AI', 'AG-1', 'AUTHORIZED_ENTERPRISE_AI');
  session.registerParticipant(p);
  session.addTurn({ participantId: 'p-agent', text: 'regular cadenced reply', offsetS: 2, partial: false });
  const snap = session.snapshot();
  assert.equal(p.passportVerified, undefined, 'no passport fields without the hook');
  assert.equal(p.passportReasons, undefined);
  assert.equal(p.classification, 'AUTHORIZED_ENTERPRISE_AI', 'no downgrade without the hook');
  assert.ok(!snap.timeline.some(t => /passport/i.test(t.label)), 'no passport timeline noise by default');
});
