/**
 * @cxtrust/passport — cryptographically verifiable agent identities.
 */
export {
  PassportIssuer,
  PassportVerifier,
  RevocationList,
  canonicalJson,
  canonicalDigest,
  verifyWithPem,
  SIGNATURE_ALG,
  type IssuedPassport,
  type PassportPayload,
  type PassportPayload as PassportPayloadDocument,
  type VerifyResult,
} from './passport.ts';
export {
  PassportRegistry,
  assertAgentAuthorized,
  type AuthorizedRegistration,
  type AuthorizationResult,
  type RegistryEntry,
} from './registry.ts';
export {
  buildDemoTrustFabric,
  DEMO_ISSUER_ID,
  DEMO_VALID_FROM,
  DEMO_VALID_TO,
  DEMO_REFUND_CERT_ID,
  ACME_REFUND_AGENT_REGISTRATION,
  type DemoTrustFabric,
} from './demo.ts';

// ---------- Governance glue ----------

import type { AgentRegistration } from '@cxtrust/core';
import { PassportVerifier, RevocationList } from './passport.ts';
import { assertAgentAuthorized } from './registry.ts';
import { buildDemoTrustFabric } from './demo.ts';

export interface PassportCheckOptions {
  issuer?: import('./passport.ts').PassportIssuer;
  revocations?: RevocationList;
  now?: string | Date;
}

export interface PassportCheckResult {
  trusted: boolean;
  reasons: string[];
}

/**
 * Compact governance-glue check for the policy layer: verifies the passport
 * attached to a registration (signature, validity window, revocation, and
 * registration-snapshot drift) and returns { trusted, reasons }.
 */
export function passportCheck(registration: AgentRegistration, opts: PassportCheckOptions = {}): PassportCheckResult {
  const reasons: string[] = [];
  const passport = registration.passport;
  if (!passport) return { trusted: false, reasons: ['no passport attached to registration'] };

  const fabric = buildDemoTrustFabric();
  const verifier = new PassportVerifier(
    opts.issuer ?? fabric.issuer,
    opts.revocations ?? (opts.issuer ? new RevocationList() : fabric.revocations),
  );
  const result = assertAgentAuthorized(passport, registration, verifier, opts.now ?? new Date());
  if (!result.authorized) reasons.push(result.reason);
  return { trusted: result.authorized, reasons };
}
