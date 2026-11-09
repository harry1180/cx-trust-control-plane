
/**
 * Demo trust fabric — real, signed passports for the platform's demo agents.
 *
 * ACME-COLLECTIONS-AGENT-145: VALID passport.
 * ACME-REFUND-AGENT-77: REVOKED passport (rejected path).
 */
import type { AgentRegistration } from '@cxtrust/core';
import { PassportIssuer, PassportVerifier, RevocationList } from './passport.ts';
import { PassportRegistry, assertAgentAuthorized, type AuthorizedRegistration } from './registry.ts';

export const DEMO_ISSUER_ID = 'cxtrust-demo-ca';
export const DEMO_VALID_FROM = '2026-01-01T00:00:00Z';
export const DEMO_VALID_TO = '2027-01-01T00:00:00Z';
export const DEMO_REFUND_CERT_ID = 'cert-acme-refund-77';

/** Registration snapshot for the refund agent (defined here; not in core's demo registry). */
export const ACME_REFUND_AGENT_REGISTRATION: AgentRegistration = {
  agentId: 'ACME-REFUND-AGENT-77',
  name: 'Acme Refund Agent',
  organizationId: 'org-acme',
  owner: 'payments-eng@acme.example.com',
  environment: 'PROD',
  modelProvider: 'internal',
  model: 'acme-voice-2',
  purpose: 'Refunds',
  approvedVoice: 'voice-pool-a',
  approvedChannels: ['voice'],
  approvedTools: ['customer.lookup', 'refund.issue'],
  approvedDomains: ['acme.example.com'],
  permittedDataClasses: ['INTERNAL'],
  permittedActions: ['CUSTOMER_LOOKUP', 'ISSUE_REFUND'],
  maxTransactionLimit: 2500,
  riskClassification: 'HIGH',
  humanEscalationPolicy: 'transfer-supervisor-on-refund-above-limit',
  jurisdiction: 'US',
  policyVersion: 4,
  deploymentVersion: '1.4.0',
};

export interface DemoTrustFabric {
  issuer: PassportIssuer;
  verifier: PassportVerifier;
  registry: PassportRegistry;
  revocations: RevocationList;
  collections: { passport: import('@cxtrust/core').AgentPassport; registration: AgentRegistration };
  refund: { passport: import('@cxtrust/core').AgentPassport; registration: AgentRegistration };
}

let fabric: DemoTrustFabric | undefined;

/** Lazily build the demo fabric (single issuer key, deterministic cert ids). */
export function buildDemoTrustFabric(): DemoTrustFabric {
  if (fabric) return fabric;
  const issuer = new PassportIssuer(DEMO_ISSUER_ID);
  const keyId = issuer.createSigningKey(`${DEMO_ISSUER_ID}-key-1`);

  const collectionsReg = {
    agentId: 'ACME-COLLECTIONS-AGENT-145',
    organizationId: 'org-acme',
    permittedActions: ['CUSTOMER_LOOKUP', 'PAYMENT_ARRANGEMENT'],
    approvedTools: ['customer.lookup', 'payment.arrangement'],
    maxTransactionLimit: 5000,
  } as AgentRegistration;
  const collectionsFull: AgentRegistration = {
    ...ACME_REFUND_AGENT_REGISTRATION,
    agentId: collectionsReg.agentId,
    name: 'Acme Collections Agent',
    owner: 'collections-eng@acme.example.com',
    purpose: 'Collections',
    approvedTools: collectionsReg.approvedTools,
    permittedActions: collectionsReg.permittedActions,
    maxTransactionLimit: collectionsReg.maxTransactionLimit,
    riskClassification: 'MEDIUM',
    humanEscalationPolicy: 'transfer-supervisor-on-dispute',
    deploymentVersion: '2.1.0',
  };
  const collectionsIssued = issuer.issue(collectionsFull, {
    validFrom: DEMO_VALID_FROM,
    validTo: DEMO_VALID_TO,
    keyId,
    certificateId: 'cert-acme-collections-145',
  });

  const refundIssued = issuer.issue(ACME_REFUND_AGENT_REGISTRATION, {
    validFrom: DEMO_VALID_FROM,
    validTo: DEMO_VALID_TO,
    keyId,
    certificateId: DEMO_REFUND_CERT_ID,
  });

  const revocations = new RevocationList();
  revocations.revoke(DEMO_REFUND_CERT_ID);
  const verifier = new PassportVerifier(issuer, revocations);
  const registry = new PassportRegistry(issuer, revocations);
  registry.register(collectionsIssued.passport, collectionsFull);
  registry.register(refundIssued.passport, ACME_REFUND_AGENT_REGISTRATION);

  fabric = {
    issuer,
    verifier,
    registry,
    revocations,
    collections: { passport: collectionsIssued.passport, registration: collectionsFull },
    refund: { passport: refundIssued.passport, registration: ACME_REFUND_AGENT_REGISTRATION },
  };
  return fabric;
}

export { assertAgentAuthorized, type AuthorizedRegistration };
