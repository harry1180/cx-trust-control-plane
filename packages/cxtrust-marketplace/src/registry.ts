/**
 * @cxtrust/marketplace — third-party plugin discovery, trust verification,
 * and installation.
 *
 * PluginManifest is a signed document: the signature is a detached Ed25519
 * signature (base64) over the canonical JSON of the manifest WITHOUT the
 * signature block (same canonical-JSON + SHA-256-digest scheme as
 * @cxtrust/passport; this package depends on @cxtrust/passport for the
 * canonical-JSON helpers instead of duplicating the crypto).
 */
import { canonicalJson, PassportIssuer } from '@cxtrust/passport';
import { createHash, sign, verify, type KeyObject } from 'node:crypto';

export type PluginKind = 'connector' | 'threat-pack' | 'voice-analyzer' | 'alert-router' | 'policy-pack';

export type PluginPermission =
  | 'audio-access'
  | 'network-egress'
  | 'incident-write'
  | 'policy-evaluate'
  | 'pii-tokenize';

export interface PluginSignature {
  issuerKeyId: string;
  algorithm: 'ed25519';
  /** base64 detached signature over the canonical JSON of the manifest minus `signature`. */
  detachedSignature: string;
}

export interface PluginManifest {
  pluginId: string;
  name: string;
  version: string;
  kind: PluginKind;
  author: { name: string; organizationId: string };
  description: string;
  homepage: string;
  /** package ref like '@scope/pkg' or a './local/path' */
  entrypoint: string;
  permissions: PluginPermission[];
  signature?: PluginSignature;
  license: string;
  cxtrustMinVersion: string;
}

export type PluginStatus = 'unverified' | 'verified' | 'rejected';

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

export interface PluginEntry {
  manifest: PluginManifest;
  status: PluginStatus;
  publishedAt: string;
  reason?: string;
}

/** Keys the registry trusts for detached plugin signatures (keyId -> PEM). */
export class MarketplaceKeyring {
  readonly publicKeys = new Map<string, string>();

  /** Import every signing key from a passport issuer. */
  addIssuer(issuer: PassportIssuer): void {
    for (const [keyId, key] of issuer.registry) {
      this.publicKeys.set(keyId, key.publicKeyPem);
    }
  }

  /** Register a raw public key PEM under a key id. */
  addKey(keyId: string, publicKeyPem: string): void {
    this.publicKeys.set(keyId, publicKeyPem);
  }

  pem(keyId: string): string | undefined {
    return this.publicKeys.get(keyId);
  }
}

/** The canonical signed payload: manifest minus its signature block. */
export function unsignedManifest(manifest: PluginManifest): Record<string, unknown> {
  const m: Record<string, unknown> = { ...manifest };
  delete m.signature;
  return m;
}

/** SHA-256 (hex) over the canonical JSON of the unsigned manifest. */
export function manifestDigest(manifest: PluginManifest): string {
  return createHash('sha256')
    .update(canonicalJson(unsignedManifest(manifest)), 'utf8')
    .digest('hex');
}

/**
 * MarketplaceRegistry — in-memory plugin catalog.
 *
 * publish() NEVER auto-installs: unsigned plugins land in 'unverified' and
 * stay un-installable; signed plugins are verified against the keyring and
 * are either 'verified' or 'rejected' with a reason.
 */
export class MarketplaceRegistry {
  private entries = new Map<string, PluginEntry>();

  readonly keyring: MarketplaceKeyring;

  constructor(keyring: MarketplaceKeyring = new MarketplaceKeyring()) {
    this.keyring = keyring;
  }

  publish(manifest: PluginManifest): PluginEntry {
    if (!manifest.signature) {
      const entry: PluginEntry = {
        manifest,
        status: 'unverified',
        publishedAt: new Date().toISOString(),
        reason: 'unsigned manifest — signature required for verification',
      };
      this.entries.set(manifest.pluginId, entry);
      return entry;
    }
    const result = this.verifyPlugin(manifest);
    const entry: PluginEntry = {
      manifest,
      status: result.valid ? 'verified' : 'rejected',
      publishedAt: new Date().toISOString(),
      reason: result.reason,
    };
    this.entries.set(manifest.pluginId, entry);
    return entry;
  }

  /**
   * Verify the detached Ed25519 signature over the canonical manifest.
   * Mirrors the passport verifier pattern: canonical JSON -> sha256 digest ->
   * Ed25519 verify with the issuer public key resolved from the keyring.
   */
  verifyPlugin(manifest: PluginManifest): VerifyResult {
    const sig = manifest.signature;
    if (!sig) return { valid: false, reason: 'missing signature' };
    if (sig.algorithm !== 'ed25519') {
      return { valid: false, reason: `unsupported signature algorithm: ${sig.algorithm}` };
    }
    const pem = this.keyring.pem(sig.issuerKeyId);
    if (!pem) return { valid: false, reason: `unknown issuer key: ${sig.issuerKeyId}` };
    const digest = manifestDigest(manifest);
    const ok = verify(null, Buffer.from(digest, 'utf8'), pem, Buffer.from(sig.detachedSignature, 'base64'));
    return ok ? { valid: true } : { valid: false, reason: 'signature mismatch' };
  }

  get(pluginId: string): PluginEntry | undefined {
    return this.entries.get(pluginId);
  }

  list(): PluginEntry[] {
    return [...this.entries.values()];
  }
}

/** Sign a manifest with an issuer key from a PassportIssuer (Ed25519, base64). */
export function signManifest(
  manifest: Omit<PluginManifest, 'signature'>,
  issuer: PassportIssuer,
  keyId: string,
): PluginManifest {
  const unsigned = manifest as PluginManifest;
  const digest = manifestDigest(unsigned);
  const key = issuer.registry.get(keyId) as { privateKey: KeyObject } | undefined;
  if (!key) throw new Error(`unknown issuer key: ${keyId}`);
  const detachedSignature = sign(null, Buffer.from(digest, 'utf8'), key.privateKey).toString('base64');
  return { ...unsigned, signature: { issuerKeyId: keyId, algorithm: 'ed25519', detachedSignature } };
}
