// Shadow vs enforce policy execution mode — deterministic, env-selectable.
// Default is ENFORCE (byte-identical to pre-shadow behavior). Shadow is
// opt-in: per-policy execution:'shadow' or GOVERNANCE_MODE=shadow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compilePolicy, evaluateAction, FINANCIAL_SERVICES_POLICY_V4,
  policyExecutionMode, type Policy, type PolicyEvalContext,
} from '../src/policy.ts';

const ctx: PolicyEvalContext = {
  syntheticVoiceProbability: 0.97,
  participant: { participantId: 'p1', interactionId: 'i', organizationId: 'o', kind: 'CUSTOMER', classification: 'SYNTHETIC_IDENTITY', identityConfidence: 0.2, authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {} },
  intent: 'MONEY_TRANSFER',
};

test('default mode is enforce: R001 blocks (existing behavior preserved)', () => {
  const { compiled, policy } = compilePolicy(FINANCIAL_SERVICES_POLICY_V4);
  const d = evaluateAction(compiled, policy, ctx);
  assert.equal(policyExecutionMode(policy), 'enforce');
  assert.equal(d.allowed, false);
  assert.equal(d.execution, 'enforce');
  assert.equal(d.wouldEnforceActions, undefined);
});

test('shadow policy: detection recorded, allowed=true, wouldEnforce captured', () => {
  const shadowPolicy: Policy = { ...FINANCIAL_SERVICES_POLICY_V4, execution: 'shadow' };
  const { compiled, policy } = compilePolicy(shadowPolicy);
  const d = evaluateAction(compiled, policy, ctx);
  assert.equal(policyExecutionMode(policy), 'shadow');
  assert.equal(d.execution, 'shadow');
  assert.equal(d.allowed, true); // nothing blocked in shadow
  assert.deepEqual(d.actions, ['ALLOW_WITH_MONITORING']);
  assert.deepEqual(d.wouldEnforceActions, ['DENY', 'STEP_UP_AUTH', 'HANDOFF_TO_HUMAN']);
  assert.equal(d.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
});

test('GOVERNANCE_MODE=shadow flips an unmarked policy to shadow; enforce overrides back', () => {
  const { policy } = compilePolicy(FINANCIAL_SERVICES_POLICY_V4);
  process.env.GOVERNANCE_MODE = 'shadow';
  assert.equal(policyExecutionMode(policy), 'shadow');
  const enforced: Policy = { ...FINANCIAL_SERVICES_POLICY_V4, execution: 'enforce' };
  assert.equal(policyExecutionMode(enforced), 'enforce'); // explicit beats env
  delete process.env.GOVERNANCE_MODE;
  assert.equal(policyExecutionMode(policy), 'enforce'); // restored default
});

test('shadow mode with a clean context: plain ALLOW, no shadow artifacts', () => {
  const shadowPolicy: Policy = { ...FINANCIAL_SERVICES_POLICY_V4, execution: 'shadow' };
  const { compiled, policy } = compilePolicy(shadowPolicy);
  const d = evaluateAction(compiled, policy, { requestedAction: 'GET_BALANCE' });
  assert.equal(d.allowed, true);
  assert.deepEqual(d.actions, ['ALLOW']);
  assert.equal(d.execution, 'enforce'); // no shadow shortcut taken for allow
});