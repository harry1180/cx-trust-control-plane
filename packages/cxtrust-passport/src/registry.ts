
/**
 * PassportRegistry — binds passports to agent registrations and gates entry
 * into governed sessions. An agent is only accepted when its passport
 * signature, validity window, revocation status, and registration snapshot
 * all check out.
 */
import type { AgentPassport, AgentRegistration } from '@cxtrust/core';
import { PassportIssuer, PassportVerifier, RevocationList, type VerifyResult } from './passport.ts';

export interface AuthorizedRegistration extends AgentRegistration {
  passportVerified: true;
  passportVerifiedAt: string;
}

export type AuthorizationResult =
  | { authorized: true; registration: AuthorizedRegistration; verify: VerifyResult }
  | { authorized: false; reason: string; verify: VerifyResult };

/**
 * Core authorization check. Verifies the passport and requires that the
 * live AgentRegistration MATCHES the snapshot embedded at issuance:
 * agentId, organizationId, permittedActions, approvedTools, and
 * maxTransactionLimit must all agree — any drift is rejected.
 */
export function assertAgentAuthorized(
  passport: AgentPassport,
  registration: AgentRegistration,
  verifier: PassportVerifier,
  now: string | Date = new Date(),
): AuthorizationResult {
  const verify = verifier.verify(passport, now);
  if (!verify.valid) return { authorized: false, reason: verify.reason ?? 'invalid passport', verify };
  if (verify.passport.subjectAgentId !== registration.agentId) {
    return {
      authorized: false,
      reason: `subject mismatch: passport subject ${verify.passport.subjectAgentId} != registration agentId ${registration.agentId}`,
      verify,
    };
  }
  const snapshot = (passport as { registration?: Record<string, unknown> }).registration;
  if (!snapshot) return { authorized: false, reason: 'passport has no embedded registration snapshot', verify };

  const drift: string[] = [];
  const check = (field: string, live: unknown, embedded: unknown) => {
    const same =
      Array.isArray(live) && Array.isArray(embedded)
        ? live.length === embedded.length && live.every((v, i) => v === embedded[i])
        : live === embedded;
    if (!same) drift.push(field);
  };
  check('agentId', registration.agentId, snapshot.agentId);
  check('organizationId', registration.organizationId, snapshot.organizationId);
  check('permittedActions', registration.permittedActions, snapshot.permittedActions);
  check('approvedTools', registration.approvedTools, snapshot.approvedTools);
  check('maxTransactionLimit', registration.maxTransactionLimit, snapshot.maxTransactionLimit);

  if (drift.length > 0) {
    return {
      authorized: false,
      reason: `registration drift vs passport snapshot: ${drift.join(', ')}`,
      verify,
    };
  }

  return {
    authorized: true,
    verify,
    registration: {
      ...registration,
      passport: verify.passport,
      passportVerified: true,
      passportVerifiedAt: new Date(now instanceof Date ? now : new Date(now)).toISOString(),
    },
  };
}

/** Registry entry: one agent's passport + live registration. */
export interface RegistryEntry {
  agentId: string;
  passport: AgentPassport;
  registration: AgentRegistration;
  revoked: boolean;
}

/**
 * PassportRegistry — register passports together with their agent
 * registrations, revoke certificates, and admit agents into governed
 * sessions only after full verification.
 */
export class PassportRegistry {
  readonly verifier: PassportVerifier;
  readonly issuer: PassportIssuer;
  private entries = new Map<string, RegistryEntry>();

  constructor(
    issuer: PassportIssuer,
    revocations: RevocationList = new RevocationList(),
  ) {
    this.issuer = issuer;
    this.verifier = new PassportVerifier(issuer, revocations);
  }

  get revocations(): RevocationList {
    return this.verifier.revocations;
  }

  /** Register a passport + registration pair (verified at admission time). */
  register(passport: AgentPassport, registration: AgentRegistration): RegistryEntry {
    if (passport.subjectAgentId !== registration.agentId) {
      throw new Error(
        `subject mismatch: passport subject ${passport.subjectAgentId} != registration agentId ${registration.agentId}`,
      );
    }
    const entry: RegistryEntry = {
      agentId: registration.agentId,
      passport,
      registration,
      revoked: false,
    };
    this.entries.set(registration.agentId, entry);
    return entry;
  }

  revoke(certificateId: string): void {
    this.revocations.revoke(certificateId);
    for (const entry of this.entries.values()) {
      if (entry.passport.certificateId === certificateId) entry.revoked = true;
    }
  }

  get(agentId: string): RegistryEntry | undefined {
    return this.entries.get(agentId);
  }

  /** Admission gate into a governed session. Throws on any failure. */
  assertAdmissible(agentId: string, now: string | Date = new Date()): AuthorizedRegistration {
    const entry = this.entries.get(agentId);
    if (!entry) throw new Error(`agent not registered: ${agentId}`);
    const result = assertAgentAuthorized(entry.passport, entry.registration, this.verifier, now);
    if (!result.authorized) throw new Error(`agent ${agentId} not authorized: ${result.reason}`);
    return result.registration;
  }
}
