// Detection engines: pluggable provider interface + internal implementations.
// External vendor adapters (Pindrop-like, Reality Defender-like) implement the
// same VoiceDetectionProvider seam; fusion is weighted-confidence based.

import type {
  Detection, DetectionCategory, EvidenceItem, Participant, TrustClassification,
} from './schema.ts';

export interface DetectionProvider {
  id: string;
  category: DetectionCategory;
  /** Evaluate a stream of turns/events; returns detections as of this turn. */
  evaluate(ctx: EvaluationContext): Detection[];
}

export interface EvaluationContext {
  interactionId: string;
  organizationId: string;
  now: string;
  offsetS: number;
  /** final transcript lines so far, [{speaker, text, offsetS}] */
  transcript: { speaker: string; text: string; offsetS: number }[];
  participants: Participant[];
  /** partial audio analysis results (from voice engine) */
  audio?: { syntheticProbability?: number; replayProbability?: number };
}

export interface Turn {
  speaker: string; // participantId
  text: string;
  offsetS: number;
  partial: boolean;
}

export interface TurnInput {
  participantId: string;
  text: string;
  offsetS: number;
  partial: boolean;
}

// ---------- Voice trust engine (simulated provider; real provider plugs here) ----------

export interface VoiceDetectionProvider {
  id: string;
  analyze(input: {
    participantId: string;
    /** demo adapter passes synthetic signal descriptors; real adapter passes audio features */
    signal: { isSynthetic?: boolean; isReplay?: boolean; clonedFrom?: string };
  }): { syntheticProbability: number; replayProbability: number; impersonationProbability: number };
}

export const simulatedVoiceProvider: VoiceDetectionProvider = {
  id: 'internal-simulated-voice-v1',
  analyze({ signal }) {
    return {
      syntheticProbability: signal.isSynthetic ? 0.97 : 0.02,
      replayProbability: signal.isReplay ? 0.93 : 0.01,
      impersonationProbability: signal.clonedFrom ? 0.9 : 0.05,
    };
  },
};

/** Maps voice-provider output + participant state to a trust classification. */
export function classifyParticipant(p: {
  declaredKind?: Participant['kind'];
  isRegisteredAgent?: boolean;
  voice?: { syntheticProbability: number; replayProbability: number; impersonationProbability: number };
  authLevel?: string;
}): TrustClassification {
  if (p.isRegisteredAgent && p.declaredKind === 'ENTERPRISE_AI') {
    return 'AUTHORIZED_ENTERPRISE_AI';
  }
  if (p.voice) {
    if (p.voice.replayProbability > 0.8) return 'REPLAYED_AUDIO';
    if (p.voice.syntheticProbability > 0.85) {
      return p.isRegisteredAgent ? 'KNOWN_EXTERNAL_AI' : 'UNKNOWN_AI';
    }
  }
  if (p.authLevel === 'HIGH') return 'HUMAN_VERIFIED';
  if (p.authLevel === 'MEDIUM') return 'HUMAN_VERIFIED';
  if (p.voice && p.voice.syntheticProbability > 0.5) return 'HUMAN_SUSPECTED';
  return 'HUMAN_UNKNOWN';
}

export function voiceDetections(
  ctx: EvaluationContext, provider: VoiceDetectionProvider,
): Detection[] {
  const out: Detection[] = [];
  for (const part of ctx.participants) {
    if (!part.riskState.syntheticVoiceProbability) continue;
    if (part.riskState.syntheticVoiceProbability > 0.85) {
      out.push(mk(ctx, 'VOICE_TRUST', 'synthetic_voice', 'Synthetic voice detected',
        part.riskState.syntheticVoiceProbability, 22, part.participantId, [
          { kind: 'audio_signal', text: `synthetic voice probability ${Math.round(part.riskState.syntheticVoiceProbability * 100)}%`, locator: 'voice-provider:vocoder-artifacts' },
          { kind: 'audio_signal', text: 'formant transition anomalies consistent with TTS render', locator: 'voice-provider:formants' },
        ]));
    }
    if (part.riskState.replayProbability !== undefined && part.riskState.replayProbability > 0.8) {
      out.push(mk(ctx, 'VOICE_TRUST', 'replay_audio', 'Audio replay suspected',
        part.riskState.replayProbability, 20, part.participantId, [
          { kind: 'audio_signal', text: 'packet jitter + codec fingerprints identical to earlier session', locator: 'voice-provider:rtp' },
        ]));
    }
    if (part.riskState.telephonyAnomaly) {
      out.push(mk(ctx, 'TELEPHONY', 'telephony_anomaly', 'Telephony origination anomaly',
        0.7, 10, part.participantId, [
          { kind: 'metadata', text: 'ANI/carrier combination inconsistent with claimed geography', locator: 'telephony-provider:ani' },
        ]));
    }
  }
  return out;
}

// ---------- Conversation threat engine ----------

interface ThreatRule {
  code: string;
  title: string;
  category: DetectionCategory;
  weight: number;
  patterns: RegExp[];
  evidenceText: string;
}

const THREAT_RULES: ThreatRule[] = [
  { code: 'otp_harvesting', title: 'OTP extraction behavior', category: 'FRAUD', weight: 16,
    patterns: [/\b(read|give|tell) me the (code|otp|one[- ]time (code|password)|verification code)\b/i, /\bwhat('| i)?s the code (i|we) (just )?sent\b/i],
    evidenceText: 'Caller requested a one-time code be read aloud' },
  { code: 'pin_password_request', title: 'PIN or password request', category: 'FRAUD', weight: 14,
    patterns: [/\b(what|confirm) (is|was) your (pin|password|passphrase|security answer)\b/i],
    evidenceText: 'Caller requested PIN/password disclosure' },
  { code: 'account_takeover_pattern', title: 'Account takeover pattern', category: 'FRAUD', weight: 18,
    patterns: [/\b(change|move) (my |the )?(money|funds|balance).{0,40}\b(new|different|other) account\b/i, /\bchange my (bank )?account\b/i],
    evidenceText: 'Request to move funds to a different account' },
  { code: 'urgency_coercion', title: 'Manipulative urgency', category: 'CONVERSATION', weight: 10,
    patterns: [/\b(right now|immediately|in the next (5|10) minutes|before (someone|the police)|or else)\b/i],
    evidenceText: 'Language designed to force immediate action' },
  { code: 'authority_impersonation', title: 'Authority impersonation', category: 'CONVERSATION', weight: 14,
    patterns: [/\b(I('| a)m (calling )?(from|with) )?(the )?(IRS|police|federal|FBI|fraud department|head office|CEO'?s office)\b/i],
    evidenceText: 'Caller claimed authority affiliation' },
  { code: 'gift_card_scam', title: 'Gift card payment request', category: 'FRAUD', weight: 16,
    patterns: [/\b(google play|apple|itunes|amazon) gift card/i],
    evidenceText: 'Gift-card payment request' },
  { code: 'wire_transfer_pressure', title: 'Wire transfer pressure', category: 'FRAUD', weight: 15,
    patterns: [/\bwire (the )?(money|funds|transfer)\b/i, /\b(international )?wire\b.{0,30}\b(today|now|immediately)\b/i],
    evidenceText: 'Urgent wire transfer instruction' },
  { code: 'credential_harvesting', title: 'Credential harvesting', category: 'FRAUD', weight: 16,
    patterns: [/\b(sso|login|username).{0,30}(link|url|site)\b/i, /\bgo to (this )?(link|website).{0,30}(login|verify|confirm)\b/i],
    evidenceText: 'Caller directed victim to a credential-capture flow' },
  { code: 'reconnaissance', title: 'Knowledge probing', category: 'CONVERSATION', weight: 8,
    patterns: [/\b(how many|which) (agents|customers|accounts|employees)\b.{0,30}\?\s*$/i, /\bwhat (other )?(systems|databases|tools) (do you|can you)\b/i],
    evidenceText: 'Enumerating internal systems or records' },
];

const INJECTION_RULES: { code: string; weight: number; patterns: RegExp[]; text: string }[] = [
  { code: 'prompt_injection', weight: 20,
    patterns: [/\b(ignore (all |your |any )?(previous|prior|above) (instructions|prompts|rules)|disregard your (instructions|rules))\b/i,
      /\byou are now\b.{0,20}\b(no longer|instead|free)\b/i, /\b(system|developer) (prompt|message|mode)\b/i,
      /\benter (developer|debug|admin) mode\b/i, /\breveal (your )?(system prompt|instructions|initial prompt)\b/i],
    text: 'Attempt to override or extract agent instructions' },
  { code: 'tool_abuse', weight: 12,
    patterns: [/\b(call|invoke|use) the (refund|transfer|payment|delete|admin) (tool|function|api)\b/i],
    text: 'Caller attempted to trigger a privileged tool directly' },
  { code: 'data_exfiltration', weight: 14,
    patterns: [/\b(send|email|text|post) (me |it |the (full|entire) )?(record|details|statement|list|customer data|all data|customer record)\b.{0,60}\b(to my|to the|external|outside|personal)\b/i,
      /\b(send|email|text|post|upload).{0,30}\b(full|entire)\b.{0,20}\b(record|statement|list|data|file).{0,40}\b(personal|outside|external)\b/i],
    text: 'Attempt to move internal data out of band' },
];

const PCI_PATTERNS: { code: string; label: string; re: RegExp; weight: number }[] = [
  { code: 'pci_digits', label: 'Payment card number spoken', re: /\b(four|five|six|three|seven)? ?(zero|one|two|three|four|five|six|seven|eight|nine|\d)[\s-]*(zero|one|two|three|four|five|six|seven|eight|nine|\d)[\s-]*[\dzeroone-twoeight -]{9,}[\dzeroone-twoeight]\b/i, weight: 12 },
  { code: 'cvv_spoken', label: 'CVV/security code spoken', re: /\b(cvv|cvc|security code) (is|:?) ?\d{3,4}\b/i, weight: 10 },
  { code: 'ssn_spoken', label: 'SSN spoken', re: /\b(social security|ssn) (number is|is|:?) ?\d{3}-?\d{2}-?\d{4}\b/i, weight: 10 },
  { code: 'pii_email', label: 'Email address spoken', re: /\b[\w.+-]+@[\w-]+\.(com|net|org|io)\b/i, weight: 4 },
  { code: 'pii_phone', label: 'Phone number spoken', re: /\b\(?(\d{3})\)?[- .]\d{3}[- .]\d{4}\b/, weight: 3 },
];

function mk(ctx: EvaluationContext, category: DetectionCategory, code: string,
  title: string, confidence: number, weight: number, participantId: string | undefined,
  evidence: EvidenceItem[], providerId = 'internal-rules-v1'): Detection {
  return {
    detectionId: `det-${ctx.interactionId}-${code}-${ctx.offsetS}-${Math.floor(Math.random() * 1e6)}`,
    interactionId: ctx.interactionId,
    participantId,
    category, code, title,
    confidence, weight,
    ts: ctx.now, offsetS: ctx.offsetS,
    evidence, providerId,
  };
}

export function conversationDetections(ctx: EvaluationContext): Detection[] {
  const out: Detection[] = [];
  const finals = ctx.transcript.filter(t => !('partial' in t && (t as unknown as { partial?: boolean }).partial === true));
  const speakerMap = new Map(ctx.participants.map(p => [p.participantId, p]));
  for (const turn of finals) {
    const p = speakerMap.get(turn.speaker);
    // only flag customer/caller-side speech for fraud/injection; agent-side PCI still flags
    const isCustomer = !p || p.kind === 'CUSTOMER' || p.kind === 'EXTERNAL_AI';
    for (const r of THREAT_RULES) {
      for (const re of r.patterns) {
        const m = turn.text.match(re);
        if (m) {
          out.push(mk(ctx, r.category, r.code, r.title, 0.8, r.weight, turn.speaker, [
            { kind: 'transcript', text: r.evidenceText, locator: `t+${turn.offsetS}s: "${trim(turn.text, 90)}"` },
          ]));
          break;
        }
      }
    }
    if (isCustomer) {
      for (const r of INJECTION_RULES) {
        const hit = r.patterns.some(re => re.test(turn.text));
        if (hit) {
          out.push(mk(ctx, 'PROMPT_INJECTION', r.code, r.text, 0.85, r.weight, turn.speaker, [
            { kind: 'transcript', text: r.text, locator: `t+${turn.offsetS}s: "${trim(turn.text, 90)}"` },
          ], 'internal-ai-security-v1'));
        }
      }
    }
    for (const r of PCI_PATTERNS) {
      if (r.re.test(turn.text)) {
        out.push(mk(ctx, 'DATA_EXPOSURE', r.code, r.label, 0.9, r.weight, turn.speaker, [
          { kind: 'transcript', text: `${r.label} — matched pattern redacted in evidence store`, locator: `t+${turn.offsetS}s: [REDACTED ${r.code}]` },
        ]));
      }
    }
  }
  return out;
}

function trim(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
