// Trust Network shared types + the privacy validator.
//
// CRITICAL PRIVACY RULE: a TrustSignal's `fingerprint` is an opaque hash or
// short opaque token identifying an agent/bot/campaign — NEVER raw customer
// data. Phone numbers, email addresses, names, transcripts or any free text
// are rejected at validation time, both locally and on every outbound sync.

export type TrustSignalKind =
  | 'MALICIOUS_AGENT'
  | 'FRAUD_CAMPAIGN'
  | 'SYNTHETIC_VOICE_FINGERPRINT'
  | 'KNOWN_BOT'
  | 'TRUSTED_AGENT'
  | 'ATTACK_TECHNIQUE';

export const TRUST_SIGNAL_KINDS: readonly TrustSignalKind[] = [
  'MALICIOUS_AGENT',
  'FRAUD_CAMPAIGN',
  'SYNTHETIC_VOICE_FINGERPRINT',
  'KNOWN_BOT',
  'TRUSTED_AGENT',
  'ATTACK_TECHNIQUE',
];

export interface TrustSignal {
  signalId: string;
  kind: TrustSignalKind;
  organizationId: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** 0..1 impact severity. */
  severity: number;
  /** Opaque hash / short token. NEVER raw customer data (see validateSignal). */
  fingerprint: string;
  description: string;
  /** 0..1 reporter confidence. */
  confidence: number;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

// --- PII detectors (fingerprint field must never contain these) ---

// Phone-like: optional +, then digits separated only by spaces/dashes/dots/
// parens, at least 7 digits total.
const PHONE_RE = /^\+?[\d][\d\s().-]{5,}\d$/;
// Email-like.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Fingerprint charset: hashes and short opaque tokens only (no spaces, no
// free text). Max 64 chars.
const FINGERPRINT_RE = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,63}$/;

/** Rejects any signal whose fingerprint looks like raw PII or free text. */
export function validateSignal(signal: unknown): ValidationResult {
  if (!signal || typeof signal !== 'object') return { ok: false, reason: 'signal must be an object' };
  const s = signal as Record<string, unknown>;
  if (typeof s.signalId !== 'string' || s.signalId.length === 0) return { ok: false, reason: 'signalId required' };
  if (typeof s.kind !== 'string' || !TRUST_SIGNAL_KINDS.includes(s.kind as TrustSignalKind)) {
    return { ok: false, reason: `kind must be one of ${TRUST_SIGNAL_KINDS.join('|')}` };
  }
  if (typeof s.organizationId !== 'string' || s.organizationId.length === 0) return { ok: false, reason: 'organizationId required' };
  if (typeof s.createdAt !== 'string' || Number.isNaN(Date.parse(s.createdAt))) return { ok: false, reason: 'createdAt must be ISO-8601' };
  if (typeof s.severity !== 'number' || !(s.severity >= 0 && s.severity <= 1)) return { ok: false, reason: 'severity must be 0..1' };
  if (typeof s.confidence !== 'number' || !(s.confidence >= 0 && s.confidence <= 1)) return { ok: false, reason: 'confidence must be 0..1' };
  if (typeof s.description !== 'string') return { ok: false, reason: 'description must be a string' };

  const fp = s.fingerprint;
  if (typeof fp !== 'string' || fp.length === 0) return { ok: false, reason: 'fingerprint required' };
  if (fp.length > 64) return { ok: false, reason: 'fingerprint >64 chars — looks like free text, not a hash' };
  if (EMAIL_RE.test(fp)) return { ok: false, reason: 'fingerprint looks like an email address — raw PII is forbidden' };
  if (PHONE_RE.test(fp)) return { ok: false, reason: 'fingerprint looks like a phone number — raw PII is forbidden' };
  if (/\s/.test(fp)) return { ok: false, reason: 'fingerprint contains whitespace — free text is forbidden' };
  if (!FINGERPRINT_RE.test(fp)) return { ok: false, reason: 'fingerprint must be a hash/short opaque token ([A-Za-z0-9:_./-])' };
  return { ok: true };
}

/** Validate a batch; returns the valid subset and per-signal rejection reasons. */
export function validateSignals(signals: unknown): {
  accepted: TrustSignal[];
  rejected: { signal: unknown; reason: string }[];
} {
  const accepted: TrustSignal[] = [];
  const rejected: { signal: unknown; reason: string }[] = [];
  if (!Array.isArray(signals)) return { accepted, rejected: [{ signal: signals, reason: 'signals must be an array' }] };
  for (const s of signals) {
    const r = validateSignal(s);
    if (r.ok) accepted.push(s as TrustSignal);
    else rejected.push({ signal: s, reason: r.reason ?? 'invalid' });
  }
  return { accepted, rejected };
}
