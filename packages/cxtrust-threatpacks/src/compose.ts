// Pack composition + detection evaluation.
// composePack merges a pack's policy rules with an optional base policy —
// pack rules come FIRST (higher priority; the core engine is first-match-wins).
// evaluatePack mirrors conversationDetections semantics from @cxtrust/core.

import type { Policy, PolicyEvalContext, PolicyRule } from '@cxtrust/core/src/policy.ts';
import { compilePolicy, evaluateAction } from '@cxtrust/core/src/policy.ts';
import type { Detection, EvidenceItem, Participant } from '@cxtrust/core/src/schema.ts';
import type { EvaluationContext } from '@cxtrust/core/src/detections.ts';
import type { PackDetectionRule, ThreatPack } from './packs.ts';

/** Merge pack rules with an optional base policy. Pack rules are higher priority (first). */
export function composePack(pack: ThreatPack, basePolicy?: Policy): Policy {
  const packRules: PolicyRule[] = pack.policyRules;
  const baseRules: PolicyRule[] = basePolicy ? basePolicy.rules : [];
  const rules = [...packRules, ...baseRules];

  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) {
      throw new Error(`composePack: duplicate policy rule id '${r.id}'`);
    }
    seen.add(r.id);
  }

  if (basePolicy) {
    return { ...basePolicy, rules };
  }
  return {
    policyId: pack.packId,
    name: pack.name,
    version: 1,
    rules,
    failMode: 'CLOSED',
  };
}

/** Compile + evaluate a composed pack policy against a policy context. */
export function evaluatePackPolicy(pack: ThreatPack, ctx: PolicyEvalContext, basePolicy?: Policy) {
  const policy = composePack(pack, basePolicy);
  const { compiled } = compilePolicy(policy);
  return evaluateAction(compiled, policy, ctx);
}

export type { PackDetectionRule, ThreatPack };

function mkDetection(
  ctx: Pick<EvaluationContext, 'interactionId' | 'offsetS' | 'now'>,
  r: PackDetectionRule,
  participantId: string | undefined,
  turnText: string,
): Detection {
  const evidence: EvidenceItem[] = [
    { kind: 'transcript', text: r.evidenceText, locator: `t+${ctx.offsetS}s: "${trim(turnText, 90)}"` },
  ];
  return {
    detectionId: `det-${ctx.interactionId}-${r.code}-${ctx.offsetS}-${Math.floor(Math.random() * 1e6)}`,
    interactionId: ctx.interactionId,
    participantId,
    category: r.category,
    code: r.code,
    title: r.title,
    confidence: 0.8,
    weight: r.weight,
    ts: ctx.now,
    offsetS: ctx.offsetS,
    evidence,
    providerId: 'threatpacks-v1',
  };
}

function trim(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/**
 * Evaluate a pack's detection rules over a transcript turn (mirrors
 * conversationDetections semantics in @cxtrust/core: last final turn of the
 * transcript, or the provided single turn).
 */
export function evaluatePack(
  pack: ThreatPack,
  ctx: EvaluationContext,
  turn?: { speaker: string; text: string; offsetS: number },
): Detection[] {
  const out: Detection[] = [];
  const speakerMap = new Map<string, Participant>(ctx.participants.map(p => [p.participantId, p]));
  const turns = turn
    ? [turn]
    : [ctx.transcript.filter(t => !('partial' in t && (t as unknown as { partial?: boolean }).partial === true)).at(-1)]
        .filter((t): t is { speaker: string; text: string; offsetS: number } => !!t);
  for (const t of turns) {
    for (const r of pack.detectionRules) {
      if (r.patterns.some(re => re.test(t.text))) {
        const p = speakerMap.get(t.speaker);
        out.push(mkDetection(ctx, r, (!p || p.kind === 'CUSTOMER' || p.kind === 'EXTERNAL_AI') ? t.speaker : undefined, t.text));
      }
    }
  }
  return out;
}

/** Convenience: evaluate every final turn in the transcript. */
export function evaluatePackTranscript(pack: ThreatPack, ctx: EvaluationContext): Detection[] {
  const out: Detection[] = [];
  for (const t of ctx.transcript) {
    if ('partial' in t && (t as unknown as { partial?: boolean }).partial === true) continue;
    out.push(...evaluatePack(pack, ctx, t));
  }
  return out;
}

export type { Policy, PolicyRule };
