
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PassportIssuer,
  PassportVerifier,
  RevocationList,
  canonicalDigest,
  canonicalJson,
} from '../src/passport.ts';
import { assertAgentAuthorized, PassportRegistry } from '../src/registry.ts';
import { passportCheck } from '../src/index.ts';
import { buildDemoTrustFabric, DEMO_REFUND_CERT_ID } from '../src/demo.ts';
import type { AgentPassport, AgentRegistration } from '@cxtrust/core';

const NOW = new Date('2026-06-15T12:00:00Z');

function makeRegistration(): AgentRegistration {
  return {
    agentId: 'TEST-AGENT-1',
    name: 'Test Agent',
    organizationId: 'org-test',
    owner: 'owner@example.com',
    environment: 'PROD',
    modelProvider: 'internal',
    model: 'm1',
    purpose: 'Testing',
    approvedChannels: ['voice'],
    approvedTools: ['tool.a'],
    approvedDomains: ['example.com'],
    permittedDataClasses: ['INTERNAL'],
    permittedActions: ['ACTION_A', 'ACTION_B'],
    maxTransactionLimit: 1000,
    riskClassification: 'MEDIUM',
    humanEscalationPolicy: 'escalate',
    jurisdiction: 'US',
    policyVersion: 1,
    deploymentVersion: '1.0.0',
  };
}

test('issue -> verify happy path', () => {
  const issuer = new PassportIssuer('test-ca');
  const reg = makeRegistration();
  const { passport } = issuer.issue(reg, {
    validFrom: '2026-01-01T00:00:00Z',
    validTo: '2027-01-01T00:00:00Z',
  });
  assert.equal(passport.signatureAlg, 'ed25519');
  assert.ok(passport.signature);

  const verifier = new PassportVerifier(issuer);
  const result = verifier.verify(passport, NOW);
  assert.equal(result.valid, true, `expected valid, got reason: ${result.reason}`);
  assert.equal(result.passport.subjectAgentId, 'TEST-AGENT-1');
});

test('tampered registration (permittedActions changed after signing) -> signature mismatch', () => {
  const issuer = new PassportIssuer('test-ca');
  const reg = makeRegistration();
  const { passport } = issuer.issue(reg, {
    validFrom: '2026-01-01T00:00:00Z',
    validTo: '2027-01-01T00:00:00Z',
  });

  const tampered: AgentPassport = {
    ...passport,
    registration: {
      ...(passport as unknown as { registration: Record<string, unknown> }).registration,
      permittedActions: ['ACTION_A', 'ACTION_B', 'ACTION_C'],
    },
  } as AgentPassport;

  const verifier = new PassportVerifier(issuer);
  const result = verifier.verify(tampered, NOW);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature mismatch');
});

test('expired passport -> invalid with expired reason', () => {
  const issuer = new PassportIssuer('test-ca');
  const reg = makeRegistration();
  const { passport } = issuer.issue(reg, {
    validFrom: '2025-01-01T00:00:00Z',
    validTo: '2025-12-31T23:59:59Z',
  });
  const verifier = new PassportVerifier(issuer);
  const result = verifier.verify(passport, NOW);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired');
});

test('not yet valid passport -> invalid with not yet valid reason', () => {
  const issuer = new PassportIssuer('test-ca');
  const reg = makeRegistration();
  const { passport } = issuer.issue(reg, {
    validFrom: '2027-01-01T00:00:00Z',
    validTo: '2028-01-01T00:00:00Z',
  });
  const verifier = new PassportVerifier(issuer);
  const result = verifier.verify(passport, NOW);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'not yet valid');
});

test('revoked passport -> invalid with revoked reason', () => {
  const issuer = new PassportIssuer('test-ca');
  const reg = makeRegistration();
  const { passport } = issuer.issue(reg, {
    validFrom: '2026-01-01T00:00:00Z',
    validTo: '2027-01-01T00:00:00Z',
  });
  const revocations = new RevocationList();
  revocations.revoke(passport.certificateId);
  const verifier = new PassportVerifier(issuer, revocations);
  const result = verifier.verify(passport, NOW);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'revoked');

  // revocation list export/import round-trip
  const exported = revocations.export();
  assert.deepEqual(exported, [passport.certificateId]);
  const other = new RevocationList();
  other.import(exported);
  assert.ok(other.isRevoked(passport.certificateId));
});

test('assertAgentAuthorized end-to-end: tampered live registration -> drift rejection', () => {
  const issuer = new PassportIssuer('test-ca');
  const reg = makeRegistration();
  const { passport } = issuer.issue(reg, {
    validFrom: '2026-01-01T00:00:00Z',
    validTo: '2027-01-01T00:00:00Z',
  });
  const verifier = new PassportVerifier(issuer);

  const drifted = { ...reg, permittedActions: ['ACTION_A'] };
  const result = assertAgentAuthorized(passport, drifted, verifier, NOW);
  assert.equal(result.authorized, false);
  if (!result.authorized) {
    assert.ok(result.reason.includes('drift'), `unexpected reason: ${result.reason}`);
    assert.ok(result.reason.includes('permittedActions'));
  }
});

test('assertAgentAuthorized end-to-end: matching registration -> authorized + decorated', () => {
  const issuer = new PassportIssuer('test-ca');
  const reg = makeRegistration();
  const { passport } = issuer.issue(reg, {
    validFrom: '2026-01-01T00:00:00Z',
    validTo: '2027-01-01T00:00:00Z',
  });
  const verifier = new PassportVerifier(issuer);
  const result = assertAgentAuthorized(passport, reg, verifier, NOW);
  assert.equal(result.authorized, true);
  if (result.authorized) {
    assert.equal(result.registration.passportVerified, true);
    assert.ok(result.registration.passportVerifiedAt);
  }
});

test('DEMO_TRUST_FABRIC: collections agent authorized, refund agent rejected', () => {
  const fabric = buildDemoTrustFabric();
  assert.equal(fabric.verifier.verify(fabric.collections.passport, NOW).valid, true);
  assert.equal(fabric.verifier.verify(fabric.refund.passport, NOW).valid, false);

  const ok = assertAgentAuthorized(fabric.collections.passport, fabric.collections.registration, fabric.verifier, NOW);
  assert.equal(ok.authorized, true);
  if (ok.authorized) assert.equal(ok.registration.agentId, 'ACME-COLLECTIONS-AGENT-145');

  const bad = assertAgentAuthorized(fabric.refund.passport, fabric.refund.registration, fabric.verifier, NOW);
  assert.equal(bad.authorized, false);
  if (!bad.authorized) assert.equal(bad.reason, 'revoked');
  assert.equal(fabric.refund.passport.certificateId, DEMO_REFUND_CERT_ID);

  // registry admission gate
  const admitted = fabric.registry.assertAdmissible('ACME-COLLECTIONS-AGENT-145', NOW);
  assert.equal(admitted.passportVerified, true);
  assert.throws(() => fabric.registry.assertAdmissible('ACME-REFUND-AGENT-77', NOW), /revoked/);
});

test('passportCheck governance glue: trusted and untrusted paths', () => {
  const fabric = buildDemoTrustFabric();
  const trusted = passportCheck(
    { ...fabric.collections.registration, passport: fabric.collections.passport },
    { now: NOW },
  );
  assert.deepEqual(trusted, { trusted: true, reasons: [] });

  const revoked = passportCheck(
    { ...fabric.refund.registration, passport: fabric.refund.passport },
    { now: NOW },
  );
  assert.equal(revoked.trusted, false);
  assert.deepEqual(revoked.reasons, ['revoked']);

  const noPassport = passportCheck(makeRegistration());
  assert.equal(noPassport.trusted, false);
  assert.deepEqual(noPassport.reasons, ['no passport attached to registration']);
});

test('canonical serialization stability: key insertion order does not change digest', () => {
  const a = { z: 1, a: { y: 2, b: [3, { d: 4, c: 5 }] }, m: 'x' };
  const b = { m: 'x', a: { b: [3, { c: 5, d: 4 }], y: 2 }, z: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalDigest(a), canonicalDigest(b));
  assert.equal(canonicalDigest(a), canonicalDigest(JSON.parse(canonicalJson(a))));
});

test('PassportRegistry: revoke -> admission rejected', () => {
  const issuer = new PassportIssuer('test-ca');
  const keyId = issuer.createSigningKey('test-ca-key-1');
  const registry = new PassportRegistry(issuer);
  const reg = makeRegistration();
  const { passport } = issuer.issue(reg, {
    validFrom: '2026-01-01T00:00:00Z',
    validTo: '2027-01-01T00:00:00Z',
    keyId,
  });
  registry.register(passport, reg);
  const admitted = registry.assertAdmissible('TEST-AGENT-1', NOW);
  assert.equal(admitted.passportVerified, true);

  registry.revoke(passport.certificateId);
  assert.throws(() => registry.assertAdmissible('TEST-AGENT-1', NOW), /revoked/);
});
