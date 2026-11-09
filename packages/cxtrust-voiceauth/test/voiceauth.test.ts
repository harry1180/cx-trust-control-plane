// VoiceAuthenticityEngine tests — risk-not-verdict semantics + harness math.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DemoVoiceAuthenticityEngine, evaluateSpoofTrials, verdictToDetection,
  type VoiceAuthenticityEngine,
} from '../src/index.ts';

test('demo engine returns risk + MANDATORY limitations (never a verdict)', async () => {
  const eng: VoiceAuthenticityEngine = new DemoVoiceAuthenticityEngine();
  const v = await eng.evaluate({ participantId: 'p1', audioRef: 'call-audio-xyz' });
  assert.ok(v.syntheticRisk >= 0 && v.syntheticRisk <= 1);
  assert.ok(v.limitations.length >= 1);
  assert.match(v.limitations[0], /DEMO ONLY/);
  assert.ok(v.confidence <= 1);
});

test('evaluateSpoofTrials: perfect separation gives 0 FAR / 0 FRR', () => {
  const m = evaluateSpoofTrials([
    { trialId: 'g1', isGenuine: true, score: 0.1 },
    { trialId: 'g2', isGenuine: true, score: 0.2 },
    { trialId: 's1', isGenuine: false, score: 0.9 },
    { trialId: 's2', isGenuine: false, score: 0.8 },
  ], 0.5);
  assert.equal(m.falseAcceptRate, 0);
  assert.equal(m.falseRejectRate, 0);
  assert.equal(m.accuracy, 1);
  assert.ok(m.eer < 0.1);
});

test('evaluateSpoofTrials: known false accepts/rejects are counted honestly', () => {
  const m = evaluateSpoofTrials([
    { trialId: 'g1', isGenuine: true, score: 0.9 },   // false reject
    { trialId: 'g2', isGenuine: true, score: 0.1 },
    { trialId: 's1', isGenuine: false, score: 0.3 },  // false accept
    { trialId: 's2', isGenuine: false, score: 0.8 },
  ], 0.5);
  assert.equal(m.falseAcceptRate, 0.5);
  assert.equal(m.falseRejectRate, 0.5);
  assert.equal(m.accuracy, 0.5);
});

test('verdictToDetection: weight scales with risk, evidence carries signals', async () => {
  const eng = new DemoVoiceAuthenticityEngine();
  const v = await eng.evaluate({ participantId: 'p1', audioRef: 'abc' });
  const d = verdictToDetection(v, 'INT-V1', 5);
  assert.equal(d.category, 'VOICE_TRUST');
  assert.equal(d.code, 'voice_authenticity_risk');
  assert.ok(d.weight >= 0 && d.weight <= 30);
  assert.equal(d.evidence.length, v.evidence.length);
});