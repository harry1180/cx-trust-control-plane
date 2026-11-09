// Test Lab unit tests: corpus shape + runLab verdict logic on a fake handle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTACK_CORPUS, runLab, type LabHandle } from '../src/index.ts';
import type { Detection } from '@cxtrust/core';

test('corpus: unique ids, every case has checks-worthy expectations', () => {
  const ids = new Set(ATTACK_CORPUS.map(c => c.caseId));
  assert.equal(ids.size, ATTACK_CORPUS.length);
  for (const c of ATTACK_CORPUS) {
    assert.ok(c.expected.detectionCode || c.expected.riskAtLeast !== undefined || c.expected.decisionBlocked,
      `${c.caseId} must expect something`);
    assert.ok(c.blurb.length > 10);
  }
});

function fakeHandle(opts: { risk: number; detections: string[]; allowed?: boolean; authority?: { verdicts: string[]; mismatches: number }; grounding?: { grounded: boolean; supportRatio: number } }): LabHandle {
  return {
    interactionId: 'INT-FAKE',
    registerParticipant: () => {},
    applyVoice: () => {},
    addTurn: async () => ({ ...(opts.authority ? { authority: opts.authority } : {}), ...(opts.grounding ? { grounding: opts.grounding } : {}) }),
    evaluateAction: () => ({ allowed: opts.allowed ?? true }),
    snapshot: () => ({
      risk: { overall: opts.risk },
      detections: opts.detections.map(code => ({ code })) as Detection[],
    }),
  };
}

test('runLab: passing case (detection + risk + block all satisfied)', async () => {
  const run = await runLab({
    startInteraction: async () => fakeHandle({ risk: 67, detections: ['synthetic_voice', 'prompt_injection'], allowed: false }),
    caseIds: ['inj-01', 'auth-01'],
  });
  assert.equal(run.summary.total, 2);
  assert.equal(run.summary.pass, 2);
  assert.equal(run.summary.scorePct, 100);
  for (const r of run.results) {
    assert.equal(r.verdict, 'PASS');
    assert.ok(r.checks.length >= 1);
    assert.ok(r.checks.every(c => c.ok));
  }
});

test('runLab: failing case recorded with per-check detail', async () => {
  const run = await runLab({
    startInteraction: async () => fakeHandle({ risk: 3, detections: [] }),
    caseIds: ['inj-01'],
  });
  assert.equal(run.summary.fail, 1);
  const r = run.results[0];
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.checks.some(c => !c.ok && /detections were/.test(c.detail)));
});

test('runLab: agent cases SKIP when the seam did not engage', async () => {
  const run = await runLab({
    startInteraction: async () => fakeHandle({ risk: 40, detections: [] }),
    caseIds: ['hallucination-01'],
  });
  assert.equal(run.results[0].verdict, 'SKIP');
});

test('runLab: authority + hallucination agent cases pass with seams', async () => {
  const run = await runLab({
    startInteraction: async () => fakeHandle({
      risk: 30, detections: ['unsupported_claim', 'authority_claim_mismatch'],
      authority: { verdicts: ['PAYMENT:CLAIM_MISMATCH'], mismatches: 1 },
      grounding: { grounded: false, supportRatio: 0 },
    }),
    caseIds: ['hallucination-01', 'authority-01'],
  });
  assert.equal(run.summary.pass, 2);
});