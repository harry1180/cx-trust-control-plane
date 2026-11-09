// Threat Pack tests — detections fire on real attack utterances, not on benign ones;
// pack policies compose with the core engine and evaluate via the real policy engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FINANCIAL_SERVICES_POLICY_V4, compilePolicy, evaluateAction } from '@cxtrust/core/src/policy.ts';
import type { Policy } from '@cxtrust/core/src/policy.ts';
import type { EvaluationContext } from '@cxtrust/core/src/detections.ts';

import { THREAT_PACKS, packPolicy, getPack } from '../src/packs.ts';
import { composePack, evaluatePack, evaluatePackPolicy, evaluatePackTranscript } from '../src/compose.ts';

function evalCtx(text: string, participants: EvaluationContext['participants'] = []): EvaluationContext {
  return {
    interactionId: 'it-test',
    organizationId: 'org-test',
    now: new Date().toISOString(),
    offsetS: 0,
    transcript: [{ speaker: 'caller-1', text, offsetS: 0 }],
    participants,
  };
}

test('all four packs exist with expected industries', () => {
  assert.deepEqual(THREAT_PACKS.map(p => p.industry).sort(),
    ['banking', 'healthcare', 'insurance', 'telecom']);
  assert.ok(getPack('PACK_BANKING_V1'));
  assert.ok(getPack('PACK_INSURANCE_V1'));
  assert.ok(getPack('PACK_HEALTHCARE_V1'));
  assert.ok(getPack('PACK_TELECOM_V1'));
});

test('each pack has 4-6 detection rules and 2+ benign examples', () => {
  for (const pack of THREAT_PACKS) {
    assert.ok(pack.detectionRules.length >= 4 && pack.detectionRules.length <= 6,
      `${pack.packId} rule count`);
    assert.ok(pack.benignPatterns.length >= 2, `${pack.packId} benign corpus`);
  }
});

test('every regex pattern in every pack compiles and matches its probe', () => {
  // Compile-probe: constructing RegExp objects at import time already proves compilation;
  // exercise .test() on each to ensure no runtime surprises.
  for (const pack of THREAT_PACKS) {
    for (const rule of pack.detectionRules) {
      assert.ok(rule.patterns.length > 0, `${pack.packId}/${rule.code} has patterns`);
      for (const re of rule.patterns) {
        assert.ok(re instanceof RegExp);
        re.test('compile probe string');
      }
    }
  }
});

test('no duplicate rule ids within a pack policy or across composed rules', () => {
  for (const pack of THREAT_PACKS) {
    const ids = pack.policyRules.map(r => r.id);
    assert.equal(new Set(ids).size, ids.length, `${pack.packId} policy rule ids unique`);
    const codes = pack.detectionRules.map(r => r.code);
    assert.equal(new Set(codes).size, codes.length, `${pack.packId} detection codes unique`);
    // pack ids distinct from base policy ids
    const baseIds = new Set(FINANCIAL_SERVICES_POLICY_V4.rules.map(r => r.id));
    for (const id of ids) assert.ok(!baseIds.has(id), `${id} collides with base policy`);
  }
});

// ---------- Detection firing tests (attack utterances from public fraud typologies) ----------

const ATTACK_UTTERANCES: Record<string, string> = {
  PACK_BANKING_V1:
    'I need you to wire the money today, my broker says closing is at noon — please do it right now.',
  PACK_INSURANCE_V1:
    'I found cheap car insurance online but the guy said he is not licensed and wants payment in cash app.',
  PACK_HEALTHCARE_V1:
    'They said the free dna test is covered, they just need your medicare number and we can bill it as a different procedure code.',
  PACK_TELECOM_V1:
    'My phone is broken, I need you to swap my sim to this new one right now and do not send any confirmation code.',
};

for (const pack of THREAT_PACKS) {
  test(`[${pack.industry}] detection fires on attack utterance`, () => {
    const text = ATTACK_UTTERANCES[pack.packId];
    assert.ok(text, `attack utterance defined for ${pack.packId}`);
    const dets = evaluatePack(pack, evalCtx(text));
    assert.ok(dets.length >= 1, `expected >=1 detection, got 0 for "${text}"`);
    for (const d of dets) {
      assert.ok(pack.detectionRules.some(r => r.code === d.code));
      assert.equal(d.providerId, 'threatpacks-v1');
    }
  });

  test(`[${pack.industry}] no detections on benign utterances (demo-grade corpus)`, () => {
    // Benign corpus is demo-grade: hand-written everyday utterances, not a research corpus.
    for (const benign of pack.benignPatterns) {
      const dets = evaluatePack(pack, evalCtx(benign));
      assert.equal(dets.length, 0, `benign utterance "${benign}" triggered: ${dets.map(d => d.code).join(',')}`);
    }
  });
}

test('evaluatePackTranscript evaluates every final turn', () => {
  const pack = getPack('PACK_BANKING_V1')!;
  const ctx = evalCtx('');
  ctx.transcript = [
    { speaker: 'caller-1', text: 'Please wire the funds today, asap.', offsetS: 0 },
    { speaker: 'caller-1', text: 'And do not tell my wife about this.', offsetS: 5 },
    { speaker: 'caller-1', text: 'partial not evaluated', offsetS: 8, partial: true },
  ] as EvaluationContext['transcript'];
  const dets = evaluatePackTranscript(pack, ctx);
  const codes = dets.map(d => d.code);
  assert.ok(codes.includes('BANK_WIRE_ESCALATION'));
  assert.ok(codes.includes('BANK_P2P_PRESSURE') === false);
});

// ---------- Policy engine composition tests ----------

test('pack policies are standalone Policy objects with packId as policyId', () => {
  for (const pack of THREAT_PACKS) {
    const p = packPolicy(pack);
    assert.equal(p.policyId, pack.packId);
    assert.equal(p.rules.length, pack.policyRules.length);
  }
});

test('composePack preserves base rules and puts pack rules first', () => {
  const pack = getPack('PACK_BANKING_V1')!;
  const composed = composePack(pack, FINANCIAL_SERVICES_POLICY_V4);
  assert.equal(composed.rules.length, pack.policyRules.length + FINANCIAL_SERVICES_POLICY_V4.rules.length);
  assert.deepEqual(composed.rules.slice(0, pack.policyRules.length).map(r => r.id),
    pack.policyRules.map(r => r.id));
  assert.ok(composed.rules.some(r => r.id === 'R001_SYNTHETIC_VOICE_BLOCK'));
});

test('composePack throws on duplicate rule ids', () => {
  const pack = getPack('PACK_BANKING_V1')!;
  const dup: Policy = { ...FINANCIAL_SERVICES_POLICY_V4, rules: [...FINANCIAL_SERVICES_POLICY_V4.rules, { ...pack.policyRules[0] }] };
  // ensure a colliding id exists
  dup.rules[dup.rules.length - 1] = { ...dup.rules[dup.rules.length - 1], id: pack.policyRules[0].id };
  assert.throws(() => composePack(pack, dup), /duplicate policy rule id/);
});

test('composed policy evaluates with the real engine: unknown-AI blocked in every pack', () => {
  for (const pack of THREAT_PACKS) {
    const res = evaluatePackPolicy(pack, {
      classification: 'UNKNOWN_AI',
      requestedAction: 'READ_RECORD',
    }, FINANCIAL_SERVICES_POLICY_V4);
    assert.equal(res.allowed, false, `${pack.packId} unknown-AI should be denied`);
    assert.ok(res.actions.includes('DENY'));
    // pack rule (higher priority) should match before base unknown-AI rule
    assert.ok(pack.policyRules.some(r => r.id === res.matchedRule),
      `${pack.packId}: expected a pack rule to win, got ${res.matchedRule}`);
  }
});

test('agent-over-limit rule fires per pack', () => {
  const cases: Record<string, { amount: number; requestedAction?: string }> = {
    PACK_BANKING_V1: { amount: 2000 },
    PACK_INSURANCE_V1: { amount: 3000 },
    PACK_HEALTHCARE_V1: { amount: 4000 },
    PACK_TELECOM_V1: { amount: 800 },
  };
  for (const pack of THREAT_PACKS) {
    const res = evaluatePackPolicy(pack, {
      agent: { agentId: 'agent-7' } as never,
      amount: cases[pack.packId].amount,
      requestedAction: 'READ_RECORD',
    });
    // REQUIRE_APPROVAL is not on the engine's "allowed" action whitelist by design:
    // an agent over limit is gated, not auto-allowed.
    assert.ok(res.actions.includes('REQUIRE_APPROVAL'),
      `${pack.packId}: expected REQUIRE_APPROVAL, got ${res.actions.join(',')}`);
    const overLimitRule = pack.policyRules.find(r => r.conditions.some(c => c.field === 'agent.agentId'))!.id;
    assert.equal(res.matchedRule, overLimitRule,
      `${pack.packId}: expected pack over-limit rule to match, got ${res.matchedRule}`);
  }
});

test('base policy rules still evaluate through composed policy (R002 prompt injection)', () => {
  const pack = getPack('PACK_INSURANCE_V1')!;
  const composed = composePack(pack, FINANCIAL_SERVICES_POLICY_V4);
  const { compiled } = compilePolicy(composed);
  const res = evaluateAction(compiled, composed, {
    promptInjectionDetected: true,
    requestedAction: 'READ_RECORD',
  });
  assert.equal(res.allowed, false);
  assert.ok(res.actions.includes('QUARANTINE'));
});
