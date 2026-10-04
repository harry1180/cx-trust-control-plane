// Interaction Governance Session — the vertical-slice engine that ties
// gateway → detections → risk fusion → policy → enforcement → evidence chain.

import type {
  AgentRegistration, Detection, EvidenceRecord, Incident,
  InteractionEnvelope, Participant, PolicyDecision, RiskDimension, RiskState,
} from './schema.ts';
import type { TurnInput } from './detections.ts';
import { fuseRisk } from './risk.ts';
import { conversationDetections, voiceDetections, simulatedVoiceProvider, classifyParticipant } from './detections.ts';
import { compilePolicy, evaluateAction, evaluateStandingRules, FINANCIAL_SERVICES_POLICY_V4, type CompiledRule, type Policy } from './policy.ts';
import { createHash } from 'node:crypto';
import { MemorySpanRecorder, newTraceId, type Span, type SpanRecorder } from './trace.ts';
import { flagEnabled } from './flags.ts';


const POLICIES: Policy[] = [FINANCIAL_SERVICES_POLICY_V4];

export interface TimelineEntry {
  offsetS: number;
  kind: 'TRANSCRIPT' | 'DETECTION' | 'RISK' | 'POLICY' | 'ENFORCEMENT' | 'INCIDENT' | 'AUTH' | 'VOICE';
  label: string;
  detail?: string;
  refId?: string;
  risk?: number;
}

export interface GovernanceSnapshot {
  interaction: InteractionEnvelope;
  participants: Participant[];
  risk: RiskState;
  timeline: TimelineEntry[];
  decisions: PolicyDecision[];
  detections: Detection[];
  incidents: Incident[];
  evidence: EvidenceRecord[];
}

export interface SessionEvents {
  onSnapshot?(s: GovernanceSnapshot): void;
  onDecision?(d: PolicyDecision): void;
  onIncident?(i: Incident): void;
}

/** Result shape returned by the passportCheck hook. */
export interface PassportCheckOutcome {
  trusted: boolean;
  reasons: string[];
}

/**
 * Optional behavioral + passport seams. Core stays dependency-free: the
 * biometrics and passport packages inject pure functions here; omitting the
 * hooks keeps behavior byte-for-byte identical to the pre-hook engine.
 */
export interface SessionHooks {
  /** Behavioral biometrics: receives the final-turn list so far (whole conversation). */
  behavioral?: (turns: { participantId: string; text: string; offsetS: number }[]) => Detection[];
  /** Trust passport verification for a matched agent registration. */
  passportCheck?: (agentRegistration: AgentRegistration) => PassportCheckOutcome;
}

let seqCounter = 0;

/**
 * Framework mapping for a policy rule. These are CONTROL MAPPINGS for
 * evidence/audit purposes — never a claim of certification.
 */
export function frameworkMapForRule(ruleId: string): string[] {
  const map: Record<string, string[]> = {
    R001_SYNTHETIC_VOICE_BLOCK: ['NIST-AI-RMF:MAP', 'NIST-CSF:PR', 'OWASP-LLM:LLM01', 'MITRE-ATLAS:T0043'],
    R002_PROMPT_INJECTION_ISOLATE: ['OWASP-LLM:LLM01', 'NIST-AI-RMF:MANAGE', 'MITRE-ATLAS:T0005'],
    R003_TRANSACTION_LIMIT: ['NIST-AI-RMF:GOVERN', 'PCI-DSS:6.4.2', 'ISO-27001:A.8.24'],
    R004_UNKNOWN_AI: ['NIST-AI-RMF:MAP', 'ISO-42001:7.2', 'EU-AI-ACT:Art.14'],
    R005_AGENT_SCOPE: ['ISO-42001:7.2', 'NIST-AI-RMF:GOVERN', 'SOC2:CC6.1'],
    R006_PCI_MASK: ['PCI-DSS:3.3', 'GDPR:Art.32', 'SOC2:CC6.7'],
    R007_PASSPORT_REQUIRED: ['ISO-42001:7.2', 'NIST-AI-RMF:GOVERN', 'EU-AI-ACT:Art.14'],
  };
  return map[ruleId] ?? ['NIST-AI-RMF:MANAGE'];
}

export class GovernanceSession {
  readonly interactionId: string;
  /** Stable per-interaction trace id for the span/waterfall layer. */
  readonly traceId: string;
  private spans: SpanRecorder;
  private transcript: { speaker: string; text: string; offsetS: number }[] = [];
  /** final (non-partial) turns only — the input for the behavioral seam */
  private finalTurns: { participantId: string; text: string; offsetS: number }[] = [];
  private participants = new Map<string, Participant>();
  private risk: RiskState | undefined;
  private timeline: TimelineEntry[] = [];
  private decisions: PolicyDecision[] = [];
  private detections: Detection[] = [];
  private incidents: Incident[] = [];
  private evidence: EvidenceRecord[] = [];
  private prevChain = '';
  private compiled: { policy: Policy; compiled: CompiledRule[] }[];
  private events: SessionEvents;
  private hooks: SessionHooks;
  /** fire-once keys for behavioral detections: `${code}::${participantId}` */
  private emittedBehavioralKeys = new Set<string>();
  /** participants whose passport has already been checked (once) */
  private passportCheckedFor = new Set<string>();
  readonly interaction: InteractionEnvelope;
  readonly agents: AgentRegistration[];

  constructor(
    interaction: InteractionEnvelope,
    agents: AgentRegistration[],
    events: SessionEvents = {},
    /** Optional policy injection for simulators/what-if analysis. Omit for the seed policy set (identical default behavior). */
    policies?: Policy[],
    /** Optional behavioral + passport hooks (pure function-injection; default off). */
    opts: SessionHooks = {},
  ) {
    this.interaction = interaction;
    this.agents = agents;
    this.interactionId = interaction.interactionId;
    this.traceId = (interaction.metadata?.traceId as string) ?? newTraceId();
    this.spans = new MemorySpanRecorder();
    this.compiled = (policies ?? POLICIES).map(compilePolicy);
    this.events = events;
    this.hooks = opts;
    this.pushEvidence('EVENT', interaction.interactionId, new Date(interaction.startedAt).toISOString());
  }

  registerParticipant(p: Participant) {
    this.participants.set(p.participantId, p);
    this.timeline.push({ offsetS: p.joinedAtOffsetS, kind: 'TRANSCRIPT', label: `Participant joined: ${p.kind} → ${p.classification}`, refId: p.participantId });
    if (p.agentId && this.hooks.passportCheck && !this.passportCheckedFor.has(p.participantId)) {
      const registration = this.agents.find(a => a.agentId === p.agentId);
      if (registration) {
        this.passportCheckedFor.add(p.participantId);
        this.applyPassportResult(p, registration);
      }
    }
  }

  /** Zero-trust passport glue: unverified ENTERPRISE_AI/THIRD_PARTY_AI → UNKNOWN_AI. */
  private applyPassportResult(p: Participant, registration: AgentRegistration) {
    const result = this.hooks.passportCheck!(registration);
    p.passportVerified = result.trusted;
    p.passportReasons = [...result.reasons];
    if (result.trusted) {
      this.timeline.push({
        offsetS: p.joinedAtOffsetS, kind: 'AUTH',
        label: `Agent passport verified for ${p.participantId}`,
        detail: registration.agentId, refId: p.participantId,
      });
      return;
    }
    if (p.kind === 'ENTERPRISE_AI' || p.kind === 'THIRD_PARTY_AI') {
      p.classification = 'UNKNOWN_AI';
      this.timeline.push({
        offsetS: p.joinedAtOffsetS, kind: 'DETECTION',
        label: 'Unverified agent passport → UNKNOWN_AI',
        detail: result.reasons.join(' · ') || 'passport check failed',
        refId: p.participantId,
      });
      this.contextBoost('IDENTITY_RISK', 15, 'unverified agent passport', 'passport-check');
    }
  }

  /** Called by the voice-trust seam when provider output arrives. */
  applyVoiceAnalysis(participantId: string, analysis: { syntheticProbability: number; replayProbability: number; impersonationProbability: number }, source?: string) {
    const p = this.participants.get(participantId);
    if (!p) return;
    const prev = {
      synthetic: p.riskState.syntheticVoiceProbability,
      replay: p.riskState.replayProbability,
      impersonation: p.riskState.impersonationProbability,
    };
    p.riskState.syntheticVoiceProbability = analysis.syntheticProbability;
    p.riskState.replayProbability = analysis.replayProbability;
    p.riskState.impersonationProbability = analysis.impersonationProbability;
    // Timeline the analysis when it first arrives or the scores move —
    // participant riskState dies with the live session, so the timeline is
    // what the Investigation console (and anyone reading the store later)
    // sees. Zeros are an honest result too: they prove the analyzer ran.
    if (prev.synthetic !== analysis.syntheticProbability
      || prev.replay !== analysis.replayProbability
      || prev.impersonation !== analysis.impersonationProbability) {
      this.timeline.push({
        offsetS: this.nowOffset(),
        kind: 'VOICE',
        label: `Voice analysis: synthetic ${Math.round(analysis.syntheticProbability * 100)}% · replay ${Math.round(analysis.replayProbability * 100)}% · impersonation ${Math.round(analysis.impersonationProbability * 100)}%`,
        detail: source ?? undefined,
        refId: participantId,
      });
    }
    const newCls = classifyParticipant({
      declaredKind: p.kind,
      isRegisteredAgent: !!p.agentId,
      voice: analysis,
      authLevel: p.authLevel,
    });
    if (newCls !== p.classification) {
      p.classification = newCls;
      this.timeline.push({ offsetS: 0, kind: 'DETECTION', label: `Classification updated → ${newCls}`, refId: participantId });
    }
    // identity risk context boost
    if (analysis.syntheticProbability > 0.85 && p.kind === 'CUSTOMER') {
      this.contextBoost('IDENTITY_RISK', 24, 'Unknown AI caller (participant not registered)', 'voice-provider');
    }
  }

  contextBoost(dimension: RiskDimension, points: number, label: string, source: string, offsetS?: number) {
    this.risk = fuseRisk(this.risk, [], [{ dimension, points, label, source, offsetS: offsetS ?? this.nowOffset() }]);
    const prev = this.risk!;
    this.timeline.push({ offsetS: this.nowOffset(), kind: 'RISK', label, detail: `risk → ${prev.overall}`, risk: prev.overall });
    this.pushEvidence('RISK_UPDATE', `risk-${this.risk.overall}-${this.risk.asOfOffsetS}`, JSON.stringify(this.risk.dimensions));
    this.events.onSnapshot?.(this.snapshot());
  }

  private nowOffset() {
    return this.transcript.length ? this.transcript[this.transcript.length - 1].offsetS : 0;
  }

  /** Feed a transcript turn: detections → risk → standing policy → enforcement. */
  addTurn(turn: TurnInput) {
    this.transcript.push({ speaker: turn.participantId, text: turn.text, offsetS: turn.offsetS });
    if (!turn.partial) {
      this.finalTurns.push({ participantId: turn.participantId, text: turn.text, offsetS: turn.offsetS });
      this.timeline.push({ offsetS: turn.offsetS, kind: 'TRANSCRIPT', label: `${turn.participantId}: "${turn.text.slice(0, 80)}"` });
      const ctx = {
        interactionId: this.interactionId, organizationId: this.interaction.organizationId,
        now: new Date().toISOString(), offsetS: turn.offsetS,
        // evaluate ONLY the new turn so already-flagged speech is not re-scored
        transcript: [{ speaker: turn.participantId, text: turn.text, offsetS: turn.offsetS }],
        participants: [...this.participants.values()],
        audio: undefined,
      };
      const tDetect0 = performance.now();
      const dets = [
        // Feature-flagged detector groups: PII/PCI and prompt-injection can be
        // disabled without code changes (safe defaults remain ON).
        ...(flagEnabled('ENABLE_PII_GOVERNANCE') ? conversationDetections(ctx).filter(d => d.category === 'DATA_EXPOSURE') : []),
        ...(flagEnabled('ENABLE_PROMPT_INJECTION') ? conversationDetections(ctx).filter(d => d.category !== 'DATA_EXPOSURE') : []),
        ...voiceDetections(ctx, simulatedVoiceProvider),
      ].filter(d => d.category !== 'DATA_EXPOSURE' || flagEnabled('ENABLE_PII_GOVERNANCE'));
      this.recordSpan('DETECT', 'turn-detections', tDetect0, { detections: dets.length, offsetS: turn.offsetS });
      for (const d of dets) this.ingestDetection(d);
      // behavioral biometrics seam: whole-conversation final turns so far;
      // cadence signals fire once per (code, participant) — never re-scored.
      if (this.hooks.behavioral) {
        const turns = this.transcript.map(t => ({ participantId: t.speaker, text: t.text, offsetS: t.offsetS }));
        for (const d of this.hooks.behavioral(turns)) {
          const key = `${d.code}::${d.participantId ?? ''}`;
          if (this.emittedBehavioralKeys.has(key)) continue;
          this.emittedBehavioralKeys.add(key);
          this.ingestDetection(d);
        }
      }
      // standing policy evaluation
      const tPolicy0 = performance.now();
      const promptInjection = dets.some(d => d.category === 'PROMPT_INJECTION');
      const pci = dets.find(d => d.code.startsWith('pci') || d.code.startsWith('cvv') || d.code.startsWith('ssn'));
      for (const { policy, compiled } of this.compiled) {
        const standing = evaluateStandingRules(compiled, policy, {
          promptInjectionDetected: promptInjection,
          dataClass: pci ? 'PCI' : undefined,
          risk: this.risk,
        }, new Date().toISOString(), this.interactionId);
        for (const d of standing) this.ingestDecision(d);
      }
      this.recordSpan('POLICY', 'standing-rules', tPolicy0, { decisions: this.decisions.length });
      this.events.onSnapshot?.(this.snapshot());
    }
  }

  ingestDetection(d: Detection) {
    this.detections.push(d);
    this.risk = fuseRisk(this.risk, [d], []);
    const r = this.risk!;
    this.timeline.push({ offsetS: d.offsetS, kind: 'DETECTION', label: `${d.title} (+${d.weight})`, detail: `confidence ${Math.round(d.confidence * 100)}%`, refId: d.detectionId });
    this.timeline.push({ offsetS: d.offsetS, kind: 'RISK', label: `Risk update → ${r.overall}`, risk: r.overall });
    this.pushEvidence('DETECTION', d.detectionId, JSON.stringify({ code: d.code, evidence: d.evidence }));
  }

  ingestDecision(d: PolicyDecision) {
    d.interactionId = this.interactionId;
    this.decisions.push(d);
    this.timeline.push({
      offsetS: this.nowOffset(), kind: 'POLICY',
      label: `${d.matchedRule} → ${d.actions.join(', ')}`,
      detail: d.matchedRule, refId: d.decisionId,
    });
    for (const a of d.actions) {
      this.timeline.push({ offsetS: this.nowOffset(), kind: 'ENFORCEMENT', label: `Enforcement: ${a}`, refId: d.decisionId });
    }
    this.pushEvidence('POLICY_DECISION', d.decisionId, JSON.stringify({ rule: d.matchedRule, actions: d.actions, reasons: d.reasons }));
    if (d.actions.some(a => !['ALLOW', 'ALLOW_WITH_MONITORING', 'WARN'].includes(a)) && !this.incidents.some(i => i.interactionId === this.interactionId && i.status === 'OPEN')) {
      const severity = d.actions.includes('DENY') || d.actions.includes('TERMINATE') || d.actions.includes('QUARANTINE') ? 'CRITICAL' : 'HIGH';
      const inc: Incident = {
        incidentId: `inc-${this.interactionId}-${this.incidents.length + 1}`,
        organizationId: this.interaction.organizationId,
        interactionId: this.interactionId,
        title: d.execution === 'shadow' ? `Shadow detection: ${d.matchedRule}` : `Enforcement: ${d.matchedRule}`,
        severity,
        status: 'OPEN',
        openedAt: new Date().toISOString(),
        summary: d.reasons.join(' · '),
        detections: this.detections.slice(-3).map(x => x.detectionId),
        enforcementActions: d.actions,
        executed: d.execution !== 'shadow',
        frameworkMap: frameworkMapForRule(d.matchedRule),
      };
      this.incidents.push(inc);
      this.timeline.push({ offsetS: this.nowOffset(), kind: 'INCIDENT', label: `Incident opened: ${inc.incidentId} (${severity})`, refId: inc.incidentId });
      this.pushEvidence('INCIDENT', inc.incidentId, inc.title);
      this.events.onIncident?.(inc);
    }
    this.events.onDecision?.(d);
    this.events.onSnapshot?.(this.snapshot());
  }

  /** Evaluate a proposed agent action through the policy fast-path. */
  evaluateAction(input: {
    requestedAction: string; resource?: string; amount?: number;
    participantId: string; tool?: string; intent?: string;
  }): PolicyDecision {
    const tAction0 = performance.now();
    const p = this.participants.get(input.participantId);
    const agent = p?.agentId ? this.agents.find(a => a.agentId === p.agentId) : undefined;
    const decision = evaluateAction(this.compiled[0].compiled, this.compiled[0].policy, {
      participant: p,
      classification: p?.classification,
      risk: this.risk,
      requestedAction: input.requestedAction,
      resource: input.resource,
      amount: input.amount,
      agent,
      tool: input.tool,
      intent: input.intent,
      syntheticVoiceProbability: p?.riskState.syntheticVoiceProbability,
      promptInjectionDetected: this.detections.some(d => d.category === 'PROMPT_INJECTION'),
    });
    this.recordSpan('POLICY', 'evaluate-action', tAction0, {
      action: input.requestedAction, allowed: decision.allowed, execution: decision.execution,
    });
    this.ingestDecision(decision);
    return decision;
  }

  /** Record a governance-stage span (waterfall/observability layer). */
  recordSpan(stage: Span['stage'], name: string, t0: number, attrs?: Record<string, string | number | boolean>) {
    this.spans.record({
      spanId: Math.floor(Math.random() * 0xffffffffffffffff).toString(16).padStart(16, '0'),
      traceId: this.traceId,
      interactionId: this.interactionId,
      stage, name,
      startedAt: new Date().toISOString(),
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
      ...(attrs ? { attrs } : {}),
    });
  }

  /** Spans recorded so far (waterfall view). */
  spanList(): Span[] { return this.spans.spans(); }

  authenticate(participantId: string, result: 'SUCCESS' | 'FAILURE', level: 'MEDIUM' | 'HIGH') {
    const p = this.participants.get(participantId);
    if (!p) return;
    this.timeline.push({ offsetS: this.nowOffset(), kind: 'AUTH', label: `Step-up authentication ${result} for ${participantId}` });
    this.pushEvidence('AUTH_EVENT', `auth-${participantId}-${result}`, level);
    if (result === 'SUCCESS') {
      p.authLevel = level;
      p.identityConfidence = level === 'HIGH' ? 0.95 : 0.8;
      p.classification = 'HUMAN_VERIFIED';
    } else if (this.risk) {
      this.contextBoost('IDENTITY_RISK', 20, 'Step-up authentication failed', 'auth-provider');
      p.classification = 'HUMAN_IMPERSONATION_RISK';
    }
    this.events.onSnapshot?.(this.snapshot());
  }

  end(endedAt?: string) {
    this.interaction.endedAt = endedAt ?? new Date().toISOString();
    this.pushEvidence('EVENT', 'interaction.ended', this.interaction.endedAt);
  }

  private pushEvidence(kind: EvidenceRecord['kind'], refId: string, payload: string) {
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    const chain = createHash('sha256').update(this.prevChain + payloadHash).digest('hex');
    const rec: EvidenceRecord = {
      sequence: ++seqCounter, recordId: `ev-${seqCounter}-${refId}`,
      interactionId: this.interactionId, ts: new Date().toISOString(),
      kind, refId, payloadHash, prevChainHash: this.prevChain, chainHash: chain,
    };
    this.evidence.push(rec);
    this.prevChain = chain;
  }

  verifyChain(): boolean {
    let prev = '';
    for (const r of this.evidence) {
      const expect = createHash('sha256').update(prev + r.payloadHash).digest('hex');
      if (r.prevChainHash !== prev || r.chainHash !== expect) return false;
      prev = r.chainHash;
    }
    return true;
  }

  snapshot(): GovernanceSnapshot {
    return {
      interaction: this.interaction,
      participants: [...this.participants.values()],
      risk: this.risk ?? { overall: 0, dimensions: {} as RiskState['dimensions'], reasons: [], asOfOffsetS: 0 },
      timeline: [...this.timeline],
      decisions: [...this.decisions],
      detections: [...this.detections],
      incidents: [...this.incidents],
      evidence: [...this.evidence],
    };
  }
}
