import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, runScenario, FINANCIAL_SERVICES_POLICY_V4 } from '@cxtrust/core';
import type { GovernanceSnapshot } from '@cxtrust/core';
import { runSimulation, DEMO_CANDIDATE_POLICIES, BENIGN_SCENARIO_IDS } from '../src/index.ts';

function scenario(id: string): GovernanceSnapshot {
  return runScenario(SCENARIOS.find(s => s.id === id)!, () => {}).snapshot;
}

test('baseline == candidate (seed policy) → zero diffs everywhere', () => {
  const results = runSimulation(SCENARIOS, FINANCIAL_SERVICES_POLICY_V4);
  assert.equal(results.length, SCENARIOS.length);
  for (const r of results) {
    for (const d of r.diff) {
      assert.equal(d.changed, false, `scenario ${r.scenarioId} step@${d.stepAt} changed unexpectedly`);
      assert.equal(d.baselineRule, d.candidateRule);
      assert.equal(d.baselineAllowed, d.candidateAllowed);
    }
    assert.equal(r.summary.newlyBlocked, 0);
    assert.equal(r.summary.newlyAllowed, 0);
    assert.equal(r.summary.falsePositiveEstimate, 0);
    assert.equal(r.summary.baselineBlocked, r.summary.candidateBlocked);
  }
});

test("'stricter' blocks a benign action the baseline allowed (verified by running it)", () => {
  const results = runSimulation(SCENARIOS, DEMO_CANDIDATE_POLICIES.stricter!);
  const benign = results.filter(r => BENIGN_SCENARIO_IDS.has(r.scenarioId) && r.summary.newlyBlocked > 0);
  assert.equal(benign.length, 1, 'exactly one benign scenario newly blocked by stricter');
  const r = benign[0];
  assert.equal(r.scenarioId, 'verified-agent-passport');
  assert.equal(r.summary.falsePositiveEstimate, 1);
  const d = r.diff.find(x => x.changed && x.baselineAllowed && !x.candidateAllowed)!;
  assert.equal(d.action, 'PAYMENT_ARRANGEMENT');
  assert.equal(d.baselineRule, 'DEFAULT_ALLOW');
  assert.equal(d.candidateRule, 'R007_SYNTHETIC_AGENT_VOICE');
  // non-benign stricter behavior unchanged for the tight corpus (no other new blocks)
  const otherNew = results.filter(x => !BENIGN_SCENARIO_IDS.has(x.scenarioId) && x.summary.newlyBlocked > 0);
  assert.deepEqual(otherNew.map(x => x.scenarioId), []);
});

test("'looser' unblocks something the baseline blocked (prompt injection no longer quarantines)", () => {
  const results = runSimulation(SCENARIOS, DEMO_CANDIDATE_POLICIES.looser!);
  const inj = results.find(r => r.scenarioId === 'prompt-injection')!;
  assert.ok(inj.summary.newlyAllowed > 0, 'looser should newly allow the injection-transfer');
  const d = inj.diff.find(x => x.changed && !x.baselineAllowed && x.candidateAllowed)!;
  assert.equal(d.action, 'MONEY_TRANSFER');
  assert.equal(d.baselineRule, 'R002_PROMPT_INJECTION_ISOLATE');
});

test('benign scenarios surface the FP estimate', () => {
  for (const id of BENIGN_SCENARIO_IDS) {
    const results = runSimulation([SCENARIOS.find(s => s.id === id)!], DEMO_CANDIDATE_POLICIES.stricter!);
    const r = results[0];
    // FP estimate == newlyBlocked for benign scenarios by definition
    const newlyBlocked = r.diff.filter(d => d.changed && d.baselineAllowed && !d.candidateAllowed).length;
    assert.equal(r.summary.falsePositiveEstimate, newlyBlocked);
  }
  // non-benign scenarios always estimate 0
  const all = runSimulation(SCENARIOS, DEMO_CANDIDATE_POLICIES.looser!);
  for (const r of all) {
    if (!BENIGN_SCENARIO_IDS.has(r.scenarioId)) assert.equal(r.summary.falsePositiveEstimate, 0);
  }
});

test('runScenario equivalence: sim baseline summary matches a plain runScenario run', () => {
  for (const def of SCENARIOS) {
    const [sim] = runSimulation([def], FINANCIAL_SERVICES_POLICY_V4);
    const plain = scenario(def.id);
    const plainActions = plain.decisions.filter(d => d.subject.type === 'AGENT_ACTION');
    assert.equal(sim.summary.totalActions, plainActions.length, `scenario ${def.id}`);
    const plainBlocked = plainActions.filter(d => !d.allowed).length;
    assert.equal(sim.summary.baselineBlocked, plainBlocked, `scenario ${def.id} blocked count`);
    assert.deepEqual(
      sim.baselineDecisions.map(d => [d.matchedRule, d.allowed]),
      plainActions.map(d => [d.matchedRule, d.allowed]),
    );
  }
});
