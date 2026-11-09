// PolicyCraft tests — the NL compiler is deterministic string-to-structure;
// compiled artifacts must round-trip through the REAL core engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compilePolicyText, describeRule } from '../src/index.ts';
import type { CompileError } from '../src/index.ts';
import type { PolicyEvalContext } from '@cxtrust/core/src/policy.ts';
import { compilePolicy, evaluateAction } from '@cxtrust/core/src/policy.ts';

// ---------- 1. full happy rule: aliases, ops, values, actions, severity ----------

test('happy rule: synthetic voice + requested action → DENY + REQUIRE_APPROVAL', () => {
  const res = compilePolicyText(
    'IF synthetic voice probability is greater than 0.85 AND requested action is CHANGE_BANK_ACCOUNT THEN DENY AND REQUIRE HUMAN APPROVAL',
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.policy.rules.length, 1);
  const rule = res.policy.rules[0];
  assert.equal(rule.id, 'NL_1');
  assert.equal(rule.match, 'ALL');
  assert.deepEqual(rule.conditions, [
    { field: 'syntheticVoiceProbability', op: 'gt', value: 0.85 },
    { field: 'requestedAction', op: 'eq', value: 'CHANGE_BANK_ACCOUNT' },
  ]);
  assert.deepEqual(rule.actions, ['DENY', 'REQUIRE_APPROVAL']);
  assert.equal(rule.severity, 'CRITICAL'); // DENY present → CRITICAL
});

// ---------- 2. OR rule → ANY + HIGH via friendly action ----------

test('OR conditions → match ANY; step up authentication → STEP_UP_AUTH + HIGH', () => {
  const res = compilePolicyText(
    'IF amount is greater than 5000 OR risk score is at least 80 THEN step up authentication',
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const rule = res.policy.rules[0];
  assert.equal(rule.match, 'ANY');
  assert.deepEqual(rule.conditions, [
    { field: 'amount', op: 'gt', value: 5000 },
    { field: 'risk.overall', op: 'gte', value: 80 },
  ]);
  assert.deepEqual(rule.actions, ['STEP_UP_AUTH']);
  assert.equal(rule.severity, 'HIGH');
});

// ---------- 3. dollar / amount parsing ----------

test('dollar-prefixed and dollar-suffixed amounts parse to numbers', () => {
  const res = compilePolicyText(
    ['IF transaction amount is greater than $25,000 THEN require human approval',
     'IF amount is at most 5000 dollars THEN warn'].join('\n\n'),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.policy.rules[0].conditions[0], { field: 'amount', op: 'gt', value: 25000 });
  assert.deepEqual(res.policy.rules[1].conditions[0], { field: 'amount', op: 'lte', value: 5000 });
});

// ---------- 4. in-list parsing (comma and AND-joined tokens) ----------

test("'is one of' builds an in-list from comma tokens", () => {
  const res = compilePolicyText(
    'IF requested action is one of CHANGE_BANK_ACCOUNT, ISSUE_REFUND, MONEY_TRANSFER THEN block',
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.policy.rules[0].conditions[0], {
    field: 'requestedAction', op: 'in',
    value: ['CHANGE_BANK_ACCOUNT', 'ISSUE_REFUND', 'MONEY_TRANSFER'],
  });
  assert.deepEqual(res.policy.rules[0].actions, ['DENY']);
});

test("'is one of' survives an AND-joined list when no alias follows the AND", () => {
  const res = compilePolicyText(
    'IF intent is one of MONEY_TRANSFER AND ACCOUNT_RECOVERY THEN REQUIRE APPROVAL',
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const rule = res.policy.rules[0];
  assert.equal(rule.conditions.length, 1);
  assert.deepEqual(rule.conditions[0], { field: 'intent', op: 'in', value: ['MONEY_TRANSFER', 'ACCOUNT_RECOVERY'] });
});

// ---------- 5. exists ----------

test("'agent id exists' → exists condition with value true", () => {
  const res = compilePolicyText('IF agent id exists AND passport verified is false THEN quarantine');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.policy.rules[0].conditions, [
    { field: 'agent.agentId', op: 'exists', value: true },
    { field: 'participant.passportVerified', op: 'eq', value: false },
  ]);
  assert.deepEqual(res.policy.rules[0].actions, ['QUARANTINE']);
  assert.equal(res.policy.rules[0].severity, 'CRITICAL');
});

// ---------- 6. WHEN / -> accepted, booleans, 'detected' ----------

test('WHEN ... -> ... with detected boolean and quoted string', () => {
  const res = compilePolicyText(`WHEN prompt injection is detected THEN "QUARANTINE"`);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.policy.rules[0].conditions, [
    { field: 'promptInjectionDetected', op: 'eq', value: true },
  ]);
  assert.deepEqual(res.policy.rules[0].actions, ['QUARANTINE']);
});

// ---------- 7. unknown field alias → error names line + nearest aliases ----------

test('unknown field alias errors with line number and edit-distance suggestion', () => {
  const res = compilePolicyText(
    ['IF amount is greater than 10 THEN allow',
     'IF risk scor is greater than 5 THEN warn'].join('\n'),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.errors.length, 1);
  const err: CompileError = res.errors[0];
  assert.equal(err.line, 2);
  assert.match(err.message, /unknown field/);
  assert.match(err.message, /'risk score'/); // nearest alias suggested
});

// ---------- 8. unknown action → error listing allowed actions ----------

test('unknown action errors and lists allowed actions', () => {
  const res = compilePolicyText('IF amount is greater than 1 THEN defenestrate');
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].line, 1);
  assert.match(res.errors[0].message, /unknown action/);
  assert.match(res.errors[0].message, /STEP_UP_AUTH/);
  assert.match(res.errors[0].message, /HANDOFF_TO_HUMAN/);
});

// ---------- 9. mixed AND/OR at same level → compile error ----------

test('mixing AND and OR at the same level is a compile error', () => {
  const res = compilePolicyText(
    'IF amount is greater than 10 AND risk score is at least 50 OR tool is present THEN warn',
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].line, 1);
  assert.match(res.errors[0].message, /mixes AND and OR/);
});

// ---------- 10. empty text → error ----------

test('empty policy text errors on line 1', () => {
  for (const bad of ['', '   \n\n  \n', '# only a comment\n// another']) {
    const res = compilePolicyText(bad);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].line, 1);
    assert.match(res.errors[0].message, /empty/);
  }
});

// ---------- 11. multi-rule paragraphs → NL_1 / NL_2 + defaults + warnings array ----------

test('two paragraphs compile to NL_1 and NL_2 with policy defaults', () => {
  const res = compilePolicyText(
    ['IF data class is PCI THEN mask AND redact',
     '',
     'IF identity confidence is less than 0.5 THEN transfer to human'].join('\n'),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.warnings, []);
  assert.equal(res.policy.policyId, 'nl-policy');
  assert.equal(res.policy.name, 'Natural Language Policy');
  assert.equal(res.policy.version, 1);
  assert.equal(res.policy.failMode, 'RESTRICTED');
  assert.deepEqual(res.policy.rules.map(r => r.id), ['NL_1', 'NL_2']);
  assert.deepEqual(res.policy.rules[0].actions, ['MASK', 'REDACT']);
  assert.equal(res.policy.rules[0].severity, 'MEDIUM');
  assert.deepEqual(res.policy.rules[1].actions, ['HANDOFF_TO_HUMAN']);
  assert.equal(res.policy.rules[1].severity, 'HIGH');
});

test('opts override policy identity', () => {
  const res = compilePolicyText('IF tool is "send_email" THEN allow with monitoring', {
    policyId: 'ACRAFT-1', name: 'Authoring draft', version: 7, failMode: 'CLOSED',
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.policy.policyId, 'ACRAFT-1');
  assert.equal(res.policy.name, 'Authoring draft');
  assert.equal(res.policy.version, 7);
  assert.equal(res.policy.failMode, 'CLOSED');
  assert.equal(res.policy.rules[0].severity, 'LOW');
});

// ---------- 12. ALL errors collected, not just first ----------

test('multiple bad rules report every error with its own line', () => {
  const res = compilePolicyText(
    ['IF risk score is greater than 5 THEN explode',
     'IF my mood is sad THEN warn',
     'IF amount is greater than 1 THEN allow'].join('\n'),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.errors.length, 2);
  assert.deepEqual(res.errors.map(e => e.line).sort((a, b) => a - b), [1, 2]);
  assert.match(res.errors.find(e => e.line === 1)!.message, /unknown action/);
  assert.match(res.errors.find(e => e.line === 2)!.message, /unknown field/);
});

// ---------- 13. round-trip through the REAL core engine ----------

const AGENT_RULES = [
  'IF agent id exists AND amount is greater than 5000 dollars THEN REQUIRE HUMAN APPROVAL AND ALLOW WITH MONITORING',
  'IF classification is one of UNKNOWN_AI, MALICIOUS_AUTOMATION OR synthetic voice probability is greater than 0.9 THEN DENY AND HANDOFF TO HUMAN',
].join('\n\n');

const ALL_DIMENSIONS = [
  'IDENTITY_RISK', 'VOICE_RISK', 'TELEPHONY_RISK', 'FRAUD_RISK', 'CONVERSATION_RISK',
  'CYBER_RISK', 'AI_AGENT_RISK', 'DATA_RISK', 'COMPLIANCE_RISK', 'TRANSACTION_RISK', 'BEHAVIORAL_RISK',
] as const;
function allDims(v: number): Record<(typeof ALL_DIMENSIONS)[number], number> {
  return Object.fromEntries(ALL_DIMENSIONS.map(d => [d, v])) as Record<(typeof ALL_DIMENSIONS)[number], number>;
}

function baseCtx(): PolicyEvalContext {
  return {
    participant: {
      participantId: 'p-1', interactionId: 'i-1', organizationId: 'o-1',
      kind: 'ENTERPRISE_AI', classification: 'AUTHORIZED_ENTERPRISE_AI',
      identityConfidence: 0.95, agentId: 'ag-1', authLevel: 'HIGH',
      joinedAtOffsetS: 0, riskState: {},
    },
    classification: 'AUTHORIZED_ENTERPRISE_AI',
    risk: { overall: 20, dimensions: allDims(10), reasons: [], asOfOffsetS: 0 },
    requestedAction: 'MONEY_TRANSFER',
    amount: 25000,
    agent: {
      agentId: 'ag-1', name: 'Payments bot', organizationId: 'o-1', owner: 'platform',
      environment: 'PROD', modelProvider: 'nous', model: 'm', purpose: 'payments',
      approvedChannels: ['voice'], approvedTools: [], approvedDomains: [],
      permittedDataClasses: ['PII'], permittedActions: ['MONEY_TRANSFER'],
      maxTransactionLimit: 50000, riskClassification: 'LOW',
      humanEscalationPolicy: 'none', jurisdiction: 'US', policyVersion: 1,
      deploymentVersion: 'v1',
    },
    syntheticVoiceProbability: 0.1,
    promptInjectionDetected: false,
  };
}

test('round-trip: compiled NL policy passes core compilePolicy and evaluates to REQUIRE_APPROVAL on match', () => {
  const res = compilePolicyText(AGENT_RULES, { policyId: 'NL-RT', name: 'Round trip', version: 2 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const policy = res.policy;

  // engine-side acceptance — no schema/shape complaints
  const { compiled } = compilePolicy(policy);
  assert.equal(compiled.length, 2);
  assert.equal(compiled[0].rule.id, 'NL_1');

  // matching context: agent + amount 25000 > 5000 → first rule fires
  const decision = evaluateAction(compiled, policy, baseCtx());
  assert.equal(decision.matchedRule, 'NL_1');
  assert.equal(decision.allowed, false); // REQUIRE_APPROVAL is not an allow action
  assert.deepEqual(decision.actions, ['REQUIRE_APPROVAL', 'ALLOW_WITH_MONITORING']);
  assert.equal(decision.policyId, 'NL-RT');
  assert.equal(decision.policyVersion, 2);
  assert.ok(decision.reasons.some(r => r.includes('amount > 5000')));

  // ANY-rule path: unknown AI + high synthetic voice → NL_2 denies
  const rogue: PolicyEvalContext = {
    ...baseCtx(),
    participant: { ...baseCtx().participant!, agentId: undefined, kind: 'EXTERNAL_AI', classification: 'UNKNOWN_AI' },
    classification: 'UNKNOWN_AI',
    agent: undefined,
    syntheticVoiceProbability: 0.97,
  };
  const d2 = evaluateAction(compiled, policy, rogue);
  assert.equal(d2.matchedRule, 'NL_2');
  assert.equal(d2.allowed, false);
  assert.deepEqual(d2.actions, ['DENY', 'HANDOFF_TO_HUMAN']);
});

test('round-trip: non-matching context falls through to DEFAULT_ALLOW', () => {
  const res = compilePolicyText(AGENT_RULES);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const { policy } = res;
  const { compiled } = compilePolicy(policy);
  const calm: PolicyEvalContext = {
    ...baseCtx(),
    amount: 100,
    requestedAction: 'CHECK_BALANCE',
  };
  const decision = evaluateAction(compiled, policy, calm);
  assert.equal(decision.matchedRule, 'DEFAULT_ALLOW');
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.actions, ['ALLOW']);
});

// ---------- 14. describeRule output for UI rendering ----------

test('describeRule renders a readable IF/THEN restatement with dot-paths', () => {
  const res = compilePolicyText(
    'IF synthetic voice probability is greater than 0.85 AND requested action is one of CHANGE_BANK_ACCOUNT OR MONEY_TRANSFER THEN DENY AND step up authentication',
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const rule = res.policy.rules[0];
  assert.equal(rule.match, 'ALL');
  assert.deepEqual(rule.actions, ['DENY', 'STEP_UP_AUTH']);
  const text = describeRule(rule);
  assert.equal(text,
    'IF syntheticVoiceProbability > 0.85 AND requestedAction is one of ["CHANGE_BANK_ACCOUNT", "MONEY_TRANSFER"] '
    + 'THEN DENY AND STEP_UP_AUTH');
  // the compiled description is the same human restatement
  assert.equal(rule.description, text);
});

// ---------- 15. operators: symbols and ne ----------

test('symbol operators and != map to core ops', () => {
  const res = compilePolicyText('IF identity confidence < 0.5 AND agent != "ag-7" THEN warn');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.policy.rules[0].conditions, [
    { field: 'participant.identityConfidence', op: 'lt', value: 0.5 },
    { field: 'agent.agentId', op: 'ne', value: 'ag-7' },
  ]);
  assert.equal(res.policy.rules[0].severity, 'MEDIUM');
});
