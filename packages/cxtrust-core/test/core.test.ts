import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, SCENARIOS } from '../src/scenarios.ts';
import { fuseRisk } from '../src/risk.ts';
import { GovernanceSession } from '../src/session.ts';
import type { GovernanceSnapshot } from '../src/session.ts';

function scenario(id: string): { snap: GovernanceSnapshot; verify: () => boolean } {
  let snap: GovernanceSnapshot | undefined;
  const { session } = runScenario(SCENARIOS.find(s => s.id === id)!, s => { snap = s; });
  return { snap: snap!, verify: () => session.verifyChain() };
}

test('scenario 1: verified customer allowed', () => {
  const { snap, verify } = scenario('normal-customer');
  const caller = snap.participants[0];
  assert.equal(caller.classification, 'HUMAN_VERIFIED');
  assert.ok(snap.risk.overall < 15, `risk ${snap.risk.overall} should be low`);
  const actions = snap.decisions.flatMap(d => d.actions);
  assert.ok(actions.includes('ALLOW'), 'balance read should be allowed');
  assert.ok(verify(), 'evidence chain verifies');
});

test('scenario 2: deepfake blocked', () => {
  const { snap, verify } = scenario('deepfake-ato');
  const caller = snap.participants[0];
  assert.ok(['UNKNOWN_AI', 'HUMAN_IMPERSONATION_RISK', 'SYNTHETIC_IDENTITY'].includes(caller.classification),
    `classification ${caller.classification} should be synthetic/suspect; final state after failed auth may be impersonation risk`);
  assert.ok(snap.risk.overall > 50, `risk ${snap.risk.overall} should be high`);
  assert.ok(snap.decisions.some(d => d.matchedRule === 'R001_SYNTHETIC_VOICE_BLOCK' && !d.allowed));
  assert.ok(snap.incidents.some(i => i.severity === 'CRITICAL'));
  assert.ok(snap.risk.reasons.some(r => /authentication failed/i.test(r.label)));
  assert.ok(verify());
});

test('scenario 3: unknown AI denied sensitive action', () => {
  const { snap } = scenario('unknown-ai-caller');
  assert.ok(snap.decisions.some(d => !d.allowed && d.matchedRule === 'R004_UNKNOWN_AI_READ_ONLY'));
  assert.ok(snap.decisions.some(d => d.matchedRule === 'R001_SYNTHETIC_VOICE_BLOCK'));
});

test('scenario 4: passport agent allowed', () => {
  const { snap } = scenario('verified-agent-passport');
  assert.equal(snap.participants[0].classification, 'AUTHORIZED_ENTERPRISE_AI');
  assert.ok(snap.decisions.some(d => d.allowed && d.matchedRule === 'DEFAULT_ALLOW'));
});

test('scenario 5: prompt injection quarantines', () => {
  const { snap } = scenario('prompt-injection');
  assert.ok(snap.detections.some(d => d.code === 'prompt_injection'));
  assert.ok(snap.decisions.some(d => d.matchedRule === 'R002_PROMPT_INJECTION_ISOLATE' && !d.allowed));
});

test('scenario 6: over-limit refund requires approval', () => {
  const { snap } = scenario('agent-over-limit');
  const d = snap.decisions.find(x => x.matchedRule === 'R003_AGENT_TX_LIMIT');
  assert.ok(d, 'tx-limit rule matched');
  assert.ok(d!.actions.includes('REQUIRE_APPROVAL'));
  assert.equal(d!.allowed, false, 'REQUIRE_APPROVAL is not an auto-allow');
});

test('scenario 7: PCI masking', () => {
  const { snap } = scenario('pci-leak');
  assert.ok(snap.detections.some(d => d.code === 'pci_digits'));
  assert.ok(snap.detections.some(d => d.code === 'cvv_spoken'));
  assert.ok(snap.decisions.some(d => d.matchedRule === 'R006_PCI_SPOKEN'));
  const det = snap.detections.find(d => d.code === 'pci_digits')!;
  assert.ok(det.evidence.every(e => !/\d{12}/.test(e.text)), 'no full card number in evidence');
});

test('scenario 8: campaign signals cluster', () => {
  const { snap } = scenario('fraud-campaign');
  assert.ok(snap.detections.some(d => d.code === 'otp_harvesting'));
  assert.ok(snap.detections.some(d => d.code === 'urgency_coercion'));
  assert.ok(snap.detections.some(d => d.code === 'wire_transfer_pressure'));
  assert.ok(snap.risk.overall > 60, `risk ${snap.risk.overall}`);
});

test('evidence chain is tamper-evident', () => {
  const { snap, verify } = scenario('deepfake-ato');
  assert.ok(verify());
  assert.ok(snap.evidence.length > 3);
  const session = new GovernanceSession(
    { interactionId: 'x', organizationId: 'o', channel: 'voice', platform: 't', startedAt: new Date().toISOString(), metadata: {} },
    [],
  );
  session.addTurn({ participantId: 'p', text: 'hello', offsetS: 1, partial: false });
  assert.ok(session.verifyChain(), 'fresh session chain verifies');
});

test('risk fusion: attribution and growth', () => {
  const r1 = fuseRisk(undefined, [{
    detectionId: 'd1', interactionId: 'i', category: 'VOICE_TRUST', code: 'synthetic_voice',
    title: 'Synthetic voice', confidence: 1, weight: 22, ts: '', offsetS: 5, evidence: [], providerId: 'x',
  }], []);
  assert.equal(r1.overall, 22);
  assert.ok(r1.reasons.length === 1);
  const r2 = fuseRisk(r1, [], [{ dimension: 'IDENTITY_RISK', points: 24, label: 'Unknown AI caller', source: 'vp' }]);
  assert.ok(r2.overall > r1.overall);
  assert.ok(r2.reasons.some(r => r.label === 'Unknown AI caller'));
});
