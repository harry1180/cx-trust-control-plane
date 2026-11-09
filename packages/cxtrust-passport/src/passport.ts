
/**
 * Agent Trust Passport — cryptographically verifiable agent identities.
 *
 * A passport is a signed document binding an agent identity (subjectAgentId)
 * to a snapshot of its AgentRegistration governance fields. Signatures are
 * Ed25519 over the SHA-256 digest of the canonical JSON serialization of the
 * unsigned document (detached, base64). Pure node:crypto.
 */
import {
  generateKeyPairSync,
  createHash,
  sign,
  verify,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import type { AgentPassport, AgentRegistration } from '@cxtrust/core';

export const SIGNATURE_ALG = 'ed25519';

/** Stable, deterministic JSON serialization: keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** SHA-256 digest (hex) of the canonical JSON form. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Everything about a passport except the signature — the signed payload. */
export interface EmbeddedRegistrationSnapshot {
  agentId: string;
  organizationId: string;
  permittedActions: string[];
  approvedTools: string[];
  maxTransactionLimit: number;
}

export type PassportPayload = Omit<AgentPassport, 'signature'> & {
  issuerKeyId: string;
  registration: EmbeddedRegistrationSnapshot;
};

export interface IssuedPassport {
  passport: AgentPassport;
  issuerKeyId: string;
  issuerPublicKey: string;
}

/** Internal registry entry for one issuer signing key. */
interface IssuerKey {
  keyId: string;
  publicKeyPem: string;
  privateKey: KeyObject;
}

/**
 * PassportIssuer — mints Ed25519-signed AgentPassport documents and keeps a
 * registry of its signing public keys (key id -> PEM) so verifiers can resolve
 * the key that produced a detached signature.
 */
export class PassportIssuer {
  readonly issuerId: string;
  readonly registry = new Map<string, IssuerKey>();

  constructor(issuerId: string) {
    this.issuerId = issuerId;
  }

  /** Generate a new Ed25519 keypair, register it, return its id. */
  createSigningKey(keyId?: string): string {
    const id = keyId ?? `${this.issuerId}-${randomUUID()}`;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    this.registry.set(id, {
      keyId: id,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey,
    });
    return id;
  }

  /** PEM public key for an issuer key id (or undefined). */
  publicKeyPem(keyId: string): string | undefined {
    return this.registry.get(keyId)?.publicKeyPem;
  }

  /**
   * Issue a passport for an agent. The passport embeds a snapshot of the
   * governance-relevant registration fields so verifiers can detect drift.
   */
  issue(
    registration: AgentRegistration,
    opts: { validFrom: string; validTo: string; keyId?: string; certificateId?: string },
  ): IssuedPassport {
    const keyId = opts.keyId ?? this.createSigningKey();
    const key = this.registry.get(keyId);
    if (!key) throw new Error(`unknown issuer key: ${keyId}`);

    const payload: PassportPayload = {
      certificateId: opts.certificateId ?? `cert-${registration.agentId.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      subjectAgentId: registration.agentId,
      issuer: this.issuerId,
      issuerKeyId: keyId,
      validFrom: opts.validFrom,
      validTo: opts.validTo,
      signatureAlg: SIGNATURE_ALG,
      registration: {
        agentId: registration.agentId,
        organizationId: registration.organizationId,
        permittedActions: [...registration.permittedActions],
        approvedTools: [...registration.approvedTools],
        maxTransactionLimit: registration.maxTransactionLimit,
      },
    };

    const digest = canonicalDigest(payload);
    const signature = sign(null, Buffer.from(digest, 'utf8'), key.privateKey).toString('base64');

    const passport: AgentPassport = { ...payload, signature };
    return { passport, issuerKeyId: keyId, issuerPublicKey: key.publicKeyPem };
  }

  /** Verify a detached signature against a registered issuer key. */
  verifySignature(passport: AgentPassport): { ok: boolean; reason?: string } {
    const keyId = (passport as PassportPayload).issuerKeyId;
    if (!keyId) return { ok: false, reason: 'missing issuer key id' };
    const key = this.registry.get(keyId);
    if (!key) return { ok: false, reason: `unknown issuer key: ${keyId}` };
    return verifyWithPem(passport, key.publicKeyPem);
  }
}

/** Detached Ed25519 verification over the canonical digest with an explicit public key. */
export function verifyWithPem(passport: AgentPassport, publicKeyPem: string): { ok: boolean; reason?: string } {
  if (!passport.signature) return { ok: false, reason: 'missing signature' };
  const sig = passport.signature as string;
  const payload: Record<string, unknown> = { ...passport };
  delete payload.signature;
  const digest = canonicalDigest(payload);
  const ok = verify(null, Buffer.from(digest, 'utf8'), publicKeyPem, Buffer.from(sig, 'base64'));
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/** In-memory revocation list with import/export of revoked certificateIds. */
export class RevocationList {
  private revoked = new Set<string>();

  revoke(certificateId: string): void {
    this.revoked.add(certificateId);
  }
  reinstate(certificateId: string): void {
    this.revoked.delete(certificateId);
  }
  isRevoked(certificateId: string): boolean {
    return this.revoked.has(certificateId);
  }
  export(): string[] {
    return [...this.revoked].sort();
  }
  import(ids: string[]): void {
    for (const id of ids) this.revoked.add(id);
  }
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  passport: AgentPassport;
}

/**
 * PassportVerifier — recompute canonical JSON, verify the detached Ed25519
 * signature with the issuer public key, check the validity window (against
 * `now` or the current time), and check revocation.
 */
export class PassportVerifier {
  constructor(
    privateKeysSource: PassportIssuer | PassportIssuer[],
    revocations: RevocationList = new RevocationList(),
  ) {
    for (const issuer of Array.isArray(privateKeysSource) ? privateKeysSource : [privateKeysSource]) {
      for (const [keyId, key] of issuer.registry) {
        this.publicKeys.set(keyId, key.publicKeyPem);
      }
    }
    this.revocationList = revocations;
  }

  readonly publicKeys = new Map<string, string>();
  private revocationList: RevocationList;

  get revocations(): RevocationList {
    return this.revocationList;
  }

  verify(passport: AgentPassport, now: string | Date = new Date()): VerifyResult {
    const fail = (reason: string): VerifyResult => ({ valid: false, reason, passport });
    const p = passport as AgentPassport & { issuerKeyId?: string };

    if (p.signatureAlg !== SIGNATURE_ALG) return fail(`unsupported signature algorithm: ${p.signatureAlg}`);
    if (!p.issuerKeyId) return fail('missing issuer key id');
    const pem = this.publicKeys.get(p.issuerKeyId);
    if (!pem) return fail(`unknown issuer key: ${p.issuerKeyId}`);

    const sig = verifyWithPem(passport, pem);
    if (!sig.ok) return fail(sig.reason ?? 'signature mismatch');

    if (this.revocationList.isRevoked(p.certificateId)) return fail('revoked');

    const t = typeof now === 'string' ? new Date(now) : now;
    if (Number.isNaN(t.getTime())) return fail('invalid now timestamp');
    const from = new Date(p.validFrom);
    const to = new Date(p.validTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return fail('invalid validity window');
    if (t < from) return fail('not yet valid');
    if (t > to) return fail('expired');

    return { valid: true, passport };
  }
}
