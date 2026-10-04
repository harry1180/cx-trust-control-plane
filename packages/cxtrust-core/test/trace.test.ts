// Trace/span layer + shadow-mode incident semantics (end-to-end through the session).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GovernanceSession, frameworkMapForRule } from '../src/session.ts';
import { latencyByStage, percentiles } from '../src/trace.ts';
import type { InteractionEnvelope, Participant } from '../src/schema.ts';

const envelope: InteractionEnvelope = {
  interactionId: 'INT-TRACE-TEST',
  organizationId: 'org-test',
  channel: 'voice',
  platform: 'test',
  startedAt: new Date().toISOString(),
  metadata: {},
};

const customer: Participant = {
  participantId: 'cust-1', interactionId: 'INT-TRACE-TEST', organizationId: 'org-test',
  kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.4,
  authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
};

test('session produces a stable traceId + spans for the turn pipeline', () => {
  const s = new GovernanceSession(envelope, []);
  assert.match(s.traceId, /^[0-9a-f]{32}$/);
  s.registerParticipant(customer);
  s.addTurn({ participantId: 'cust-1', text: 'Please transfer my money right now', offsetS: 1, partial: false });
  s.evaluateAction({ requestedAction: 'MONEY_TRANSFER', participantId: 'cust-1', intent: 'MONEY_TRANSFER' });
  const spans = s.spanList();
  const stages = new Set(spans.map(x => x.stage));
  assert.ok(stages.has('DETECT'));
  assert.ok(stages.has('POLICY'));
  for (const sp of spans) {
    assert.equal(sp.traceId, s.traceId);
    assert.equal(sp.interactionId, 'INT-TRACE-TEST');
    assert.ok(sp.durationMs >= 0);
  }
  const agg = latencyByStage(spans);
  assert.ok(agg.DETECT.count >= 1);
  assert.ok(agg.POLICY.p50 >= 0);
});

test('traceId from interaction metadata is honored (propagation from connectors)', () => {
  const e: InteractionEnvelope = { ...envelope, interactionId: 'INT-T2', metadata: { traceId: 'abc123def456abc123def456abc123ff' } };
  const s = new GovernanceSession(e, []);
  assert.equal(s.traceId, 'abc123def456abc123def456abc123ff');
});

test('frameworkMapForRule returns control mappings (not certifications)', () => {
  assert.ok(frameworkMapForRule('R001_SYNTHETIC_VOICE_BLOCK').includes('OWASP-LLM:LLM01'));
  assert.deepEqual(frameworkMapForRule('UNKNOWN_RULE'), ['NIST-AI-RMF:MANAGE']);
});

test('percentiles: nearest-rank on a small set', () => {
  const p = percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(p.p50, 50);
  assert.equal(p.p95, 100);
  assert.equal(p.p99, 100);
  assert.deepEqual(percentiles([]), { p50: 0, p95: 0, p99: 0 });
});