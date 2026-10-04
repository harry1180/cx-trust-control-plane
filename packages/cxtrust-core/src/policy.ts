// Universal Policy Engine — policy-as-code, deterministic, millisecond-fast.
// Compiled rule set; no LLM on the decision path.

import type {
  AgentRegistration, EnforcementAction, Participant, PolicyDecision, RiskState,
  TrustClassification, DataClass,
} from './schema.ts';

export interface PolicyCondition {
  field: string; // dot path into eval context
  op: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'contains' | 'exists';
  value: unknown;
}

export interface PolicyRule {
  id: string;
  description: string;
  conditions: PolicyCondition[];
  /** 'ALL' = every condition must hold */
  match: 'ALL' | 'ANY';
  actions: EnforcementAction[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface Policy {
  policyId: string;
  name: string;
  version: number;
  rules: PolicyRule[];
  failMode: 'OPEN' | 'CLOSED' | 'RESTRICTED';
  /**
   * SHADOW = detect/score/log + record wouldEnforceActions, never block.
   * ENFORCE = decisions actually block. Default: env GOVERNANCE_MODE
   * (localhost default 'shadow'), overridable per-policy.
   */
  execution?: 'shadow' | 'enforce';
}

/** Effective execution mode for a policy: explicit field > env > default.
 * Default is ENFORCE (preserves the pre-shadow-mode blocking behavior of the
 * seed policy and every existing test); SHADOW is opt-in via
 * GOVERNANCE_MODE=shadow or per-policy execution:'shadow'. */
export function policyExecutionMode(p: Policy): 'shadow' | 'enforce' {
  if (p.execution) return p.execution;
  const env = typeof process !== 'undefined' ? process.env?.GOVERNANCE_MODE : undefined;
  return env === 'shadow' ? 'shadow' : 'enforce';
}

export interface PolicyEvalContext {
  participant?: Participant;
  classification?: TrustClassification;
  risk?: RiskState;
  requestedAction?: string;
  resource?: string;
  amount?: number;
  dataClass?: DataClass;
  agent?: AgentRegistration;
  tool?: string;
  intent?: string;
  syntheticVoiceProbability?: number;
  promptInjectionDetected?: boolean;
}

export interface CompiledRule {
  rule: PolicyRule;
  getters: { field: string; get: (ctx: PolicyEvalContext) => unknown; op: PolicyCondition['op']; value: unknown }[];
}

export function compilePolicy(p: Policy): { policy: Policy; compiled: CompiledRule[] } {
  const compiled = p.rules.map(rule => ({
    rule,
    getters: rule.conditions.map(c => ({
      field: c.field,
      get: (ctx: PolicyEvalContext) => dotGet(ctx, c.field),
      op: c.op,
      value: c.value,
    })),
  }));
  return { policy: p, compiled };
}

function dotGet(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) =>
    o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined, obj);
}

function testCond(op: PolicyCondition['op'], actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return Number(actual) > Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'in': return Array.isArray(expected) && expected.includes(actual as never);
    case 'contains': return Array.isArray(actual) ? actual.includes(expected as never)
      : typeof actual === 'string' ? actual.includes(String(expected)) : false;
    case 'exists': return actual !== undefined;
  }
}

export function evaluateAction(
  compiled: CompiledRule[],
  policy: Policy,
  ctx: PolicyEvalContext,
): PolicyDecision {
  const t0 = performance.now();
  let matched: CompiledRule | undefined;
  for (const cr of compiled) {
    const results = cr.getters.map(g => testCond(g.op, g.get(ctx), g.value));
    const ok = cr.rule.match === 'ALL' ? results.every(Boolean) : results.some(Boolean);
    if (ok) { matched = cr; break; } // first match wins; rules ordered by severity
  }
  const allowed = matched ? matched.rule.actions.every(a => a === 'ALLOW' || a === 'ALLOW_WITH_MONITORING' || a === 'WARN') : true;
  const actions: EnforcementAction[] = matched ? matched.rule.actions : ['ALLOW'];
  const shadow = policyExecutionMode(policy) === 'shadow' && !allowed;
  const decision: PolicyDecision = {
    decisionId: `pol-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    interactionId: '',
    subject: {
      type: 'AGENT_ACTION',
      requestedAction: ctx.requestedAction,
      resource: ctx.resource,
      amount: ctx.amount,
      participantId: ctx.participant?.participantId,
    },
    allowed: shadow ? true : allowed,
    actions: shadow ? ['ALLOW_WITH_MONITORING'] : actions,
    policyId: policy.policyId,
    policyVersion: policy.version,
    matchedRule: matched?.rule.id ?? 'DEFAULT_ALLOW',
    reasons: matched
      ? [matched.rule.description, ...describeMatch(matched, ctx)]
      : ['No rule matched; default allow with monitoring'],
    latencyMs: Math.round((performance.now() - t0) * 100) / 100,
    decidedAt: new Date().toISOString(),
    execution: shadow ? 'shadow' : 'enforce',
    ...(shadow ? { wouldEnforceActions: actions } : {}),
  };
  return decision;
}

function describeMatch(cr: CompiledRule, ctx: PolicyEvalContext): string[] {
  return cr.getters.map(g => {
    const actual = g.get(ctx);
    return `condition ${g.field} ${g.op} ${JSON.stringify(g.value)} — actual ${JSON.stringify(actual)}`;
  });
}

/** Standing rules evaluated every turn (not tied to a requested action). */
export function evaluateStandingRules(
  compiled: CompiledRule[], policy: Policy, ctx: PolicyEvalContext, now: string, interactionId: string,
): PolicyDecision[] {
  const out: PolicyDecision[] = [];
  for (const cr of compiled) {
    const results = cr.getters.map(g => testCond(g.op, g.get(ctx), g.value));
    const ok = cr.rule.match === 'ALL' ? results.every(Boolean) : results.some(Boolean);
    if (!ok) continue;
    const allowed = cr.rule.actions.every(a => a === 'ALLOW' || a === 'ALLOW_WITH_MONITORING' || a === 'WARN');
    const shadow = policyExecutionMode(policy) === 'shadow' && !allowed;
    out.push({
      decisionId: `pol-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      interactionId,
      subject: { type: 'STANDING_RULE', participantId: ctx.participant?.participantId },
      allowed: shadow ? true : allowed,
      actions: shadow ? ['ALLOW_WITH_MONITORING'] : cr.rule.actions,
      policyId: policy.policyId,
      policyVersion: policy.version,
      matchedRule: cr.rule.id,
      reasons: [cr.rule.description],
      latencyMs: 0,
      decidedAt: now,
      execution: shadow ? 'shadow' : 'enforce',
      ...(shadow ? { wouldEnforceActions: cr.rule.actions } : {}),
    });
  }
  return out;
}

/** Seed enterprise policy used by the demo + as the authoring template. */
export const FINANCIAL_SERVICES_POLICY_V4: Policy = {
  policyId: 'FINANCIAL_ACCOUNT_POLICY',
  name: 'Financial Services — Account & Transaction Protection',
  version: 4,
  failMode: 'CLOSED',
  rules: [
    {
      id: 'R001_SYNTHETIC_VOICE_BLOCK',
      description: 'Synthetic voice + low identity confidence on money movement: block and force step-up auth',
      match: 'ALL',
      conditions: [
        { field: 'syntheticVoiceProbability', op: 'gt', value: 0.85 },
        { field: 'participant.identityConfidence', op: 'lt', value: 0.5 },
        { field: 'intent', op: 'in', value: ['MONEY_TRANSFER', 'CHANGE_BANK_ACCOUNT', 'ACCOUNT_RECOVERY'] },
      ],
      actions: ['DENY', 'STEP_UP_AUTH', 'HANDOFF_TO_HUMAN'],
      severity: 'CRITICAL',
    },
    {
      id: 'R002_PROMPT_INJECTION_ISOLATE',
      description: 'Prompt injection detected: disable external tools and reduce agent permissions',
      match: 'ALL',
      conditions: [{ field: 'promptInjectionDetected', op: 'eq', value: true }],
      actions: ['DENY', 'QUARANTINE'],
      severity: 'CRITICAL',
    },
    {
      id: 'R003_AGENT_TX_LIMIT',
      description: 'AI agent transaction over limit requires human approval',
      match: 'ALL',
      conditions: [
        { field: 'agent.agentId', op: 'exists', value: true },
        { field: 'amount', op: 'gt', value: 5000 },
      ],
      actions: ['REQUIRE_APPROVAL', 'ALLOW_WITH_MONITORING'],
      severity: 'HIGH',
    },
    {
      id: 'R004_UNKNOWN_AI_READ_ONLY',
      description: 'Unregistered AI participant: read-only access',
      match: 'ANY',
      conditions: [
        { field: 'classification', op: 'in', value: ['UNKNOWN_AI', 'MALICIOUS_AUTOMATION', 'SYNTHETIC_IDENTITY', 'UNKNOWN_PARTICIPANT'] },
      ],
      actions: ['DENY', 'HANDOFF_TO_HUMAN'],
      severity: 'HIGH',
    },
    {
      id: 'R005_UNREGISTERED_AGENT_NO_SENSITIVE',
      description: 'Registered agent requesting action outside permitted set',
      match: 'ALL',
      conditions: [
        { field: 'agent.agentId', op: 'exists', value: true },
        { field: 'requestedAction', op: 'in', value: ['CHANGE_BANK_ACCOUNT', 'ISSUE_REFUND', 'MONEY_TRANSFER', 'CREDIT_DECISION'] },
      ],
      actions: ['DENY', 'REQUIRE_APPROVAL'],
      severity: 'HIGH',
    },
    {
      // Zero-trust passport gate for AI money actions. Ordered AFTER R003/R005
      // so their specific verdicts (tx limit, permitted-action set) still win
      // first-match; R007 only newly catches AI-kind money actions that fell
      // through (unregistered agentId or missing/failed passport verification).
      id: 'R007_PASSPORT_REQUIRED',
      description: 'AI agent performing money actions must present a verified passport',
      match: 'ALL',
      conditions: [
        { field: 'participant.kind', op: 'in', value: ['ENTERPRISE_AI', 'THIRD_PARTY_AI'] },
        { field: 'requestedAction', op: 'in', value: ['CHANGE_BANK_ACCOUNT', 'ISSUE_REFUND', 'MONEY_TRANSFER'] },
        { field: 'participant.passportVerified', op: 'ne', value: true },
      ],
      actions: ['DENY', 'REQUIRE_APPROVAL'],
      severity: 'HIGH',
    },
    {
      id: 'R006_PCI_SPOKEN',
      description: 'Payment card data spoken in channel: mask + alert compliance',
      match: 'ALL',
      conditions: [{ field: 'dataClass', op: 'eq', value: 'PCI' }],
      actions: ['MASK', 'REDACT', 'WARN'],
      severity: 'MEDIUM',
    },
  ],
};
