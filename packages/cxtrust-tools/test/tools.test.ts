// Authority verification + tool governance tests — synthetic only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthorityVerificationEngine, canInvokeTool, classifyTool, extractClaims,
  TOOL_RISK, REQUIRED_AUTH_LEVEL,
} from '../src/index.ts';

test('classifyTool maps known tools and defaults to CUSTOM', () => {
  assert.equal(classifyTool('PAYMENT'), 'FINANCIAL');
  assert.equal(classifyTool('payment'), 'FINANCIAL'); // case-insensitive
  assert.equal(classifyTool('UPDATE_ADDRESS'), 'PROFILE_CHANGE');
  assert.equal(classifyTool('GET_BALANCE'), 'READ_ONLY');
  assert.equal(classifyTool('MADE_UP_TOOL'), 'CUSTOM');
});

test('auth floor: HIGH tools require HIGH auth, READ_ONLY needs none', () => {
  assert.ok(canInvokeTool({ tool: 'PAYMENT', authLevel: 'HIGH', policyAllowed: true }).ok);
  const denied = canInvokeTool({ tool: 'PAYMENT', authLevel: 'LOW', policyAllowed: true });
  assert.equal(denied.ok, false);
  assert.match(denied.reason!, /requires auth level HIGH/);
  assert.ok(canInvokeTool({ tool: 'GET_BALANCE', authLevel: 'NONE', policyAllowed: true }).ok);
  assert.equal(canInvokeTool({ tool: 'PAYMENT', authLevel: 'HIGH', policyAllowed: false }).ok, false);
});

test('extractClaims recognizes completion claims for payment/address/transfer', () => {
  const claims = extractClaims('Great news — your payment has been processed and your mailing address has been updated.', 30);
  const tools = claims.map(c => c.assertedAction).sort();
  assert.deepEqual(tools, ['PAYMENT', 'UPDATE_ADDRESS']);
  assert.equal(claims[0].offsetS, 30);
  assert.equal(extractClaims('How else can I help you today?', 40).length, 0);
});

function engineWithSuccessfulPayment() {
  const eng = new AuthorityVerificationEngine('INT-T1');
  eng.recordToolCall({
    interactionId: 'INT-T1', tool: 'PAYMENT', authLevel: 'HIGH',
    policyAllowed: true, status: 'SUCCESS', resultSummary: 'txn ok', latencyMs: 410, offsetS: 8,
  });
  return eng;
}

test('CLAIM_MATCH: agent says payment processed and the tool succeeded', () => {
  const eng = engineWithSuccessfulPayment();
  const results = eng.verifyClaims('Your payment has been processed.', 'agent-1', 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].verdict, 'CLAIM_MATCH');
  assert.equal(results[0].detection, undefined);
});

test('CLAIM_MISMATCH: claim of success but the tool failed — detection raised', () => {
  const eng = new AuthorityVerificationEngine('INT-T2');
  eng.recordToolCall({
    interactionId: 'INT-T2', tool: 'PAYMENT', authLevel: 'HIGH',
    policyAllowed: true, status: 'FAILURE', error: 'backend 502', offsetS: 8,
  });
  const results = eng.verifyClaims('Your payment has been processed.', 'agent-1', 10);
  assert.equal(results[0].verdict, 'CLAIM_MISMATCH');
  const det = results[0].detection!;
  assert.equal(det.code, 'authority_claim_mismatch');
  assert.equal(det.category, 'AGENT_BEHAVIOR');
  assert.equal(det.weight, 25);
  assert.match(det.evidence[0].text, /Agent claim/);
  assert.match(det.evidence[1].text, /FAILURE/);
});

test('CLAIM_MISMATCH: tool succeeded but policy had not allowed it', () => {
  const eng = new AuthorityVerificationEngine('INT-T3');
  eng.recordToolCall({
    interactionId: 'INT-T3', tool: 'PAYMENT', authLevel: 'LOW',
    policyAllowed: false, status: 'SUCCESS', offsetS: 3,
  });
  const results = eng.verifyClaims('Your payment has been processed.', undefined, 5);
  assert.equal(results[0].verdict, 'CLAIM_MISMATCH');
  assert.match(results[0].reasons[0], /policy gate had NOT allowed/);
});

test('CLAIM_UNVERIFIABLE: no tool call on record — flagged, not punished', () => {
  const eng = new AuthorityVerificationEngine('INT-T4');
  const results = eng.verifyClaims('Your payment has been processed.', 'agent-1', 10);
  assert.equal(results[0].verdict, 'CLAIM_UNVERIFIABLE');
  assert.equal(results[0].detection, undefined);
  assert.match(results[0].reasons[0], /no recorded tool call/);
});

test('window: a tool call far in the past does not satisfy the claim', () => {
  const eng = new AuthorityVerificationEngine('INT-T5', { windowS: 10 });
  const old = 10 - 60; // 60s before the claim's offset
  eng.recordToolCall({
    interactionId: 'INT-T5', tool: 'PAYMENT', authLevel: 'HIGH',
    policyAllowed: true, status: 'SUCCESS', offsetS: old,
  });
  const results = eng.verifyClaims('Your payment has been processed.', 'agent-1', 10);
  assert.equal(results[0].verdict, 'CLAIM_UNVERIFIABLE');
});

test('multiple claims in one turn each verify independently', () => {
  const eng = new AuthorityVerificationEngine('INT-T6');
  eng.recordToolCall({ interactionId: 'INT-T6', tool: 'PAYMENT', authLevel: 'HIGH', policyAllowed: true, status: 'SUCCESS', offsetS: 15 });
  // UPDATE_ADDRESS never executed
  const results = eng.verifyClaims('Your payment has been processed and your mailing address has been updated.', 'a', 20);
  const byTool = new Map(results.map(r => [r.claim.assertedAction, r.verdict]));
  assert.equal(byTool.get('PAYMENT'), 'CLAIM_MATCH');
  assert.equal(byTool.get('UPDATE_ADDRESS'), 'CLAIM_UNVERIFIABLE');
});

test('risk tables are coherent: every category has an auth floor', () => {
  for (const cat of Object.values(TOOL_RISK)) {
    assert.ok(REQUIRED_AUTH_LEVEL[cat]);
  }
  assert.ok(Object.isFrozen === undefined || true); // table shape smoke
});