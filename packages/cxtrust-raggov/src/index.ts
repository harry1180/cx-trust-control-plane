// RAG governance — retrieval events, grounding verification, retrieval
// poisoning detection, citation integrity. Same hook-injection pattern as
// cxtrust-tools: pure functions + an engine class, core stays dependency-free.
//
// The platform must distinguish MODEL-GENERATED knowledge from
// ENTERPRISE-RETRIEVED evidence. Grounding = every factual claim in the
// agent's response maps to a retrieved source with adequate similarity.

import type { Detection, EvidenceItem } from '@cxtrust/core';

// ---------- Retrieval events ----------

export interface RetrievedSource {
  sourceId: string;
  /** e.g. 'kb://policy/refund-v3' or 'doc:contracts/acme-2024.pdf#p12' */
  uri: string;
  title?: string;
  /** similarity/rerank score 0..1 */
  score: number;
  /** tenant permission class for this source */
  permission: 'PUBLIC' | 'INTERNAL' | 'RESTRICTED' | 'CONFIDENTIAL';
  /** ISO date of the source content */
  publishedAt?: string;
  /** raw snippet used as evidence (may carry injected instructions!) */
  snippet?: string;
  tenantId?: string;
}

export interface RetrievalEvent {
  retrievalId: string;
  interactionId: string;
  /** the query sent to the retriever */
  query: string;
  sources: RetrievedSource[];
  latencyMs?: number;
  providerId?: string;
  ts: string;
  offsetS: number;
}

// ---------- Retrieval poisoning detection ----------

const POISON_PATTERNS: { code: string; re: RegExp; title: string; weight: number }[] = [
  { code: 'rag_injection', title: 'Instruction injection hidden in retrieved document', weight: 22,
    re: /\b(ignore (all |any |your )?(previous|prior|above) instructions|disregard (your|the) (rules|instructions)|you are now|reveal (your )?(system prompt|instructions)|execute (this|the following) (command|instruction))\b/i },
  { code: 'rag_exfiltration_directive', title: 'Retrieved document directs data exfiltration', weight: 24,
    re: /\b(send|email|post|upload) (this|the )?(conversation|customer (data|record|details)|all data) (to|at) (https?:\/\/|the following (url|address))\b/i },
  { code: 'rag_tool_directive', title: 'Retrieved document attempts to trigger privileged tools', weight: 20,
    re: /\b(call|invoke|execute) (the )?(refund|transfer|payment|delete|admin) (tool|function|api|endpoint)\b/i },
];

/** Scan retrieved snippets for hidden instructions (retrieval poisoning). */
export function scanRetrievalEvent(ev: RetrievalEvent): Detection[] {
  const out: Detection[] = [];
  for (const src of ev.sources) {
    if (!src.snippet) continue;
    for (const p of POISON_PATTERNS) {
      if (p.re.test(src.snippet)) {
        out.push({
          detectionId: `det-${ev.interactionId}-${p.code}-${ev.offsetS}-${Math.floor(Math.random() * 1e6)}`,
          interactionId: ev.interactionId,
          category: 'PROMPT_INJECTION',
          code: p.code,
          title: p.title,
          confidence: 0.9,
          weight: p.weight,
          ts: ev.ts,
          offsetS: ev.offsetS,
          evidence: [
            { kind: 'metadata', text: `Source ${src.uri} contains instruction-like content — snippet redacted in evidence store`, locator: `retrieval:${ev.retrievalId}:${src.sourceId}` } as EvidenceItem,
          ],
          providerId: 'internal-raggov-v1',
        });
        break; // one finding per source is enough
      }
    }
  }
  return out;
}

// ---------- Source permission / freshness checks ----------

export interface SourceAccessPolicy {
  /** highest permission class the requester may read */
  maxPermission: 'PUBLIC' | 'INTERNAL' | 'RESTRICTED' | 'CONFIDENTIAL';
  /** sources older than this many days are stale */
  maxAgeDays?: number;
  now?: Date;
}

const PERM_RANK = { PUBLIC: 0, INTERNAL: 1, RESTRICTED: 2, CONFIDENTIAL: 3 } as const;

export interface SourceFinding {
  sourceId: string;
  uri: string;
  kind: 'PERMISSION_VIOLATION' | 'STALE_SOURCE' | 'LOW_RELEVANCE';
  detail: string;
  detection?: Detection;
}

export function checkSources(
  ev: RetrievalEvent,
  policy: SourceAccessPolicy,
  opts: { minScore?: number; interactionIdForDetection?: string } = {},
): SourceFinding[] {
  const findings: SourceFinding[] = [];
  const now = policy.now ?? new Date();
  const callerRank = PERM_RANK[policy.maxPermission];
  for (const src of ev.sources) {
    if (PERM_RANK[src.permission] > callerRank) {
      const f: SourceFinding = {
        sourceId: src.sourceId, uri: src.uri, kind: 'PERMISSION_VIOLATION',
        detail: `source permission ${src.permission} exceeds caller allowance ${policy.maxPermission}`,
      };
      f.detection = mkDetection(ev, src, 'rag_permission_violation', 'Retrieved a source above caller permission', 26, f.detail);
      findings.push(f);
    }
    if (policy.maxAgeDays !== undefined && src.publishedAt) {
      const ageDays = (now.getTime() - new Date(src.publishedAt).getTime()) / 86_400_000;
      if (ageDays > policy.maxAgeDays) {
        const f: SourceFinding = {
          sourceId: src.sourceId, uri: src.uri, kind: 'STALE_SOURCE',
          detail: `source published ${Math.round(ageDays)}d ago (limit ${policy.maxAgeDays}d)`,
        };
        f.detection = mkDetection(ev, src, 'rag_stale_source', 'Stale source retrieved', 8, f.detail);
        findings.push(f);
      }
    }
    const minScore = opts.minScore ?? 0.3;
    if (src.score < minScore) {
      const f: SourceFinding = {
        sourceId: src.sourceId, uri: src.uri, kind: 'LOW_RELEVANCE',
        detail: `retrieval score ${src.score.toFixed(2)} below floor ${minScore}`,
      };
      f.detection = mkDetection(ev, src, 'rag_low_relevance', 'Low-relevance retrieval', 4, f.detail);
      findings.push(f);
    }
  }
  return findings;
}

function mkDetection(ev: RetrievalEvent, src: RetrievedSource, code: string, title: string, weight: number, detail: string): Detection {
  return {
    detectionId: `det-${ev.interactionId}-${code}-${ev.offsetS}-${Math.floor(Math.random() * 1e6)}`,
    interactionId: ev.interactionId,
    category: code === 'rag_permission_violation' ? 'DATA_EXPOSURE' : 'CONVERSATION',
    code, title,
    confidence: 0.85, weight,
    ts: ev.ts, offsetS: ev.offsetS,
    evidence: [
      { kind: 'metadata', text: detail, locator: `retrieval:${ev.retrievalId}:${src.sourceId}` } as EvidenceItem,
    ],
    providerId: 'internal-raggov-v1',
  };
}

// ---------- Grounding verification ----------

export interface GroundingResult {
  grounded: boolean;
  /** fraction of claims with source support */
  supportRatio: number;
  reasons: string[];
  /** Detection when the answer is materially unsupported */
  detection?: Detection;
}

export interface GroundingCheckInput {
  interactionId: string;
  /** the agent's spoken answer */
  answer: string;
  /** sources actually retrieved for this answer (may be empty) */
  sources: RetrievedSource[];
  offsetS: number;
  participantId?: string;
  /** token-overlap floor for a claim→source match */
  minOverlap?: number;
}

/**
 * Lexical grounding check (deterministic fast path): split the answer into
 * sentences, require each factual sentence to overlap a retrieved source
 * snippet. Full semantic grounding is a future provider-seam upgrade — this
 * version never claims more than it does.
 */
export function checkGrounding(input: GroundingCheckInput): GroundingResult {
  const minOverlap = input.minOverlap ?? 0.35;
  const sentences = input.answer
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20); // skip greetings/acknowledgements
  if (sentences.length === 0) return { grounded: true, supportRatio: 1, reasons: ['no substantive claims to ground'] };
  if (input.sources.length === 0) {
    const r: GroundingResult = {
      grounded: false, supportRatio: 0,
      reasons: ['agent made substantive claims with NO retrieved sources'],
    };
    r.detection = mkGroundingDetection(input, r, 20);
    return r;
  }
  const bag = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
  const sourceBags = input.sources
    .filter(s => s.snippet)
    .map(s => bag(s.snippet!));
  let supported = 0;
  const unsupported: string[] = [];
  for (const sentence of sentences) {
    const sb = bag(sentence);
    if (sourceBags.some(b => overlap(sb, b) >= minOverlap)) supported++;
    else unsupported.push(sentence.slice(0, 60));
  }
  const supportRatio = supported / sentences.length;
  // Strictly more than half of claims must map to sources; an answer where
  // half the claims float free is treated as materially unsupported.
  const grounded = supportRatio > 0.5;
  const reasons = grounded
    ? [`${supported}/${sentences.length} claims map to retrieved sources`]
    : [`${sentences.length - supported}/${sentences.length} claims unsupported: ${unsupported.join(' | ')}`];
  const r: GroundingResult = { grounded, supportRatio, reasons };
  if (!grounded) r.detection = mkGroundingDetection(input, r, 18);
  return r;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}

function mkGroundingDetection(input: GroundingCheckInput, r: GroundingResult, weight: number): Detection {
  return {
    detectionId: `det-${input.interactionId}-unsupported_claim-${input.offsetS}-${Math.floor(Math.random() * 1e6)}`,
    interactionId: input.interactionId,
    participantId: input.participantId,
    category: 'CONVERSATION',
    code: 'unsupported_claim',
    title: 'Agent response not grounded in retrieved evidence',
    confidence: 0.8, weight,
    ts: new Date().toISOString(), offsetS: input.offsetS,
    evidence: [{ kind: 'transcript', text: r.reasons.join('; ').slice(0, 200), locator: `t+${input.offsetS}s` } as EvidenceItem],
    providerId: 'internal-raggov-v1',
  };
}

// ---------- Runtime wrapper ----------

export class RagGovernanceEngine {
  private interactionId: string;
  private events: RetrievalEvent[] = [];
  constructor(interactionId: string) { this.interactionId = interactionId; }
  get interaction(): string { return this.interactionId; }

  recordRetrieval(ev: Omit<RetrievalEvent, 'retrievalId' | 'ts'> & { ts?: string }): { event: RetrievalEvent; poison: Detection[] } {
    const full: RetrievalEvent = {
      ...ev,
      retrievalId: `ret-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      ts: ev.ts ?? new Date().toISOString(),
    };
    this.events.push(full);
    return { event: full, poison: scanRetrievalEvent(full) };
  }

  listRetrievals(): RetrievalEvent[] { return [...this.events]; }
}