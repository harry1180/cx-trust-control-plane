// Policy Simulator — replay demo scenarios against candidate policies (what-if),
// diff decisions against the baseline (seed) policy, and estimate false positives.
// Library-only: no endpoints, no writes to the live policy store.

import {
  SimulatedVoiceConnector,
  DEMO_AGENTS,
  GovernanceSession,
  runScenario,
  FINANCIAL_SERVICES_POLICY_V4,
} from '@cxtrust/core';
import type { AgentRegistration, InteractionEnvelope, Policy, PolicyDecision } from '@cxtrust/core';
import type { ScenarioDef, GovernanceSnapshot, GovernanceSession as GovernanceSessionType } from '@cxtrust/core';

export interface DecisionDiff {
  stepAt: number;
  baselineRule: string;
  candidateRule: string;
  baselineAllowed: boolean;
  candidateAllowed: boolean;
  changed: boolean;
  action: string;
  amount?: number;
}

export interface ScenarioReplaySummary {
  totalActions: number;
  baselineBlocked: number;
  candidateBlocked: number;
  newlyBlocked: number;
  newlyAllowed: number;
  /**
   * Estimated false positives: NEWLY BLOCKED decisions in scenarios that are
   * known-benign references (scenario ids 'normal-customer' and
   * 'verified-agent-passport'). Newly-allowed decisions count 0 — they are
   * loosening, not false positives. HEURISTIC: benign scenario ids are the
   * demo corpus's labeled-benign stand-in; real FP rates need a labeled
   * benign/malicious corpus.
   */
  falsePositiveEstimate: number;
}

export interface ScenarioReplayResult {
  scenarioId: string;
  baselineDecisions: PolicyDecision[];
  candidateDecisions: PolicyDecision[];
  diff: DecisionDiff[];
  summary: ScenarioReplaySummary;
}

/** Scenario ids whose interactions are known-benign in the demo corpus (FP reference). */
export const BENIGN_SCENARIO_IDS = new Set(['normal-customer', 'verified-agent-passport']);

type Step = ScenarioDef['steps'][number];
type ActionStep = Extract<Step, { t: 'action' }>;

function actionDecisions(snap: GovernanceSnapshot): PolicyDecision[] {
  return snap.decisions.filter(d => d.subject.type === 'AGENT_ACTION');
}

function simulated(synthetic: boolean, replay?: boolean) {
  return {
    syntheticProbability: synthetic ? 0.97 : 0.02,
    replayProbability: replay ? 0.93 : 0.01,
    impersonationProbability: synthetic ? 0.9 : 0.05,
  };
}

/**
 * Drive the same step loop as runScenario, but with an optionally injected
 * policy. With `policy` undefined this is exactly the baseline (seed) path;
 * the baseline run itself goes through the plain runScenario() so the two
 * paths provably share one implementation.
 */
function replayWithPolicy(
  def: ScenarioDef,
  agents: AgentRegistration[],
  policy?: Policy,
): GovernanceSnapshot {
  if (!policy) return runScenario(def, () => {}).snapshot;

  let snap: GovernanceSnapshot | undefined;
  const events = { onSnapshot: (s: GovernanceSnapshot) => { snap = s; } };
  const connector = new SimulatedVoiceConnector('connect-sim-1', 'amazon-connect', events);
  const interaction: InteractionEnvelope = {
    interactionId: `sim-${def.id}-${Math.floor(Math.random() * 1e9)}`,
    organizationId: 'org-demo',
    channel: 'voice',
    platform: 'amazon-connect',
    startedAt: new Date().toISOString(),
    metadata: { organizationId: 'org-demo', scenario: def.id, label: def.title },
  };
  const session = new GovernanceSession(interaction, agents, events, [policy]);
  // SimulatedVoiceConnector only creates its own session in startInteraction();
  // for the candidate run we attach a session constructed with the candidate
  // policy via the connector's internal seam (private fields, set reflectively).
  const c = connector as unknown as { session?: GovernanceSessionType; interaction?: InteractionEnvelope };
  c.session = session;
  c.interaction = interaction;
  for (const step of def.steps) {
    switch (step.t) {
      case 'participant': session.registerParticipant(step.participant); break;
      case 'voice':
        connector.streamAudio({ isSynthetic: step.synthetic, isReplay: step.replay });
        session.applyVoiceAnalysis(step.participantId, simulated(step.synthetic, step.replay));
        break;
      case 'turn': connector.emitTurn({ participantId: step.participantId, text: step.text, offsetS: step.at, partial: false }); break;
      case 'action': session.evaluateAction({ requestedAction: step.action, participantId: step.participantId, amount: step.amount, resource: step.resource, intent: step.intent }); break;
      case 'auth': session.authenticate(step.participantId, step.result, step.level); break;
      case 'end': connector.stopInteraction(); break;
    }
  }
  return snap ?? session.snapshot();
}

function diffDecisions(
  baseline: PolicyDecision[],
  candidate: PolicyDecision[],
  steps: Step[],
): { diff: DecisionDiff[]; baselineBlocked: number; candidateBlocked: number } {
  const actionSteps = steps.filter(s => s.t === 'action') as ActionStep[];
  const diff: DecisionDiff[] = [];
  let baselineBlocked = 0;
  let candidateBlocked = 0;
  for (let i = 0; i < actionSteps.length; i++) {
    const step = actionSteps[i];
    const b = baseline[i];
    const c = candidate[i];
    const changed = !!b && !!c && (b.matchedRule !== c.matchedRule || b.allowed !== c.allowed);
    const bBlocked = b ? !b.allowed : false;
    const cBlocked = c ? !c.allowed : false;
    if (bBlocked) baselineBlocked++;
    if (cBlocked) candidateBlocked++;
    diff.push({
      stepAt: step.at,
      baselineRule: b?.matchedRule ?? 'NONE',
      candidateRule: c?.matchedRule ?? 'NONE',
      baselineAllowed: b?.allowed ?? true,
      candidateAllowed: c?.allowed ?? true,
      changed,
      action: step.action,
      ...(step.amount !== undefined ? { amount: step.amount } : {}),
    });
  }
  return { diff, baselineBlocked, candidateBlocked };
}

/**
 * Replay each scenario twice — once with the seed policy, once with the
 * candidate policy — and diff the AGENT_ACTION decisions by position
 * (action steps are deterministic, so position == requested action+amount).
 */
export function runSimulation(defs: ScenarioDef[], candidatePolicy: Policy): ScenarioReplayResult[] {
  const agents = DEMO_AGENTS;
  return defs.map(def => {
    const baselineSnap = replayWithPolicy(def, agents);
    const candidateSnap = replayWithPolicy(def, agents, candidatePolicy);
    const baseline = actionDecisions(baselineSnap);
    const candidate = actionDecisions(candidateSnap);
    const { diff, baselineBlocked, candidateBlocked } = diffDecisions(baseline, candidate, def.steps);
    const changed = diff.filter(d => d.changed);
    const newlyBlocked = changed.filter(d => d.baselineAllowed && !d.candidateAllowed).length;
    const newlyAllowed = changed.filter(d => !d.baselineAllowed && d.candidateAllowed).length;
    const falsePositiveEstimate = BENIGN_SCENARIO_IDS.has(def.id) ? newlyBlocked : 0;
    return {
      scenarioId: def.id,
      baselineDecisions: baseline,
      candidateDecisions: candidate,
      diff,
      summary: {
        totalActions: diff.length,
        baselineBlocked,
        candidateBlocked,
        newlyBlocked,
        newlyAllowed,
        falsePositiveEstimate,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Demo candidate policies derived from FINANCIAL_SERVICES_POLICY_V4
// ---------------------------------------------------------------------------

function variant(
  policyId: string,
  name: string,
  version: number,
  mutate: (rules: Policy['rules']) => Policy['rules'],
): Policy {
  return {
    policyId,
    name,
    version,
    failMode: FINANCIAL_SERVICES_POLICY_V4.failMode,
    rules: mutate(structuredClone(FINANCIAL_SERVICES_POLICY_V4.rules)),
  };
}

/**
 * Demo candidate policies for what-if analysis. Each is derived from
 * FINANCIAL_SERVICES_POLICY_V4 by threshold/mutation — they are NOT live policies.
 */
export const DEMO_CANDIDATE_POLICIES: Record<string, Policy> = {
  /** Stricter: lower synthetic-voice threshold (0.85 → 0.7) and registered agents with synthetic voice are denied (R007). */
  stricter: variant('FINANCIAL_ACCOUNT_POLICY_STRICTER', 'Financial Services — Stricter variant (demo)', 5, rules => {
    const synthetic = rules.find(r => r.id === 'R001_SYNTHETIC_VOICE_BLOCK');
    if (synthetic) {
      const c = synthetic.conditions.find(x => x.field === 'syntheticVoiceProbability');
      if (c) c.value = 0.7;
    }
    // New strict rule, ordered after R001 so it only fires when R001 did not:
    // any registered agent speaking with a synthetic voice is denied — this
    // newly blocks the benign passport-agent scenario (verifiable FP source).
    const r007 = {
      id: 'R007_SYNTHETIC_AGENT_VOICE',
      description: 'Registered agent speaking with synthetic voice: deny and hand off',
      match: 'ALL' as const,
      conditions: [
        { field: 'syntheticVoiceProbability', op: 'gt' as const, value: 0.7 },
        { field: 'agent.agentId', op: 'exists' as const, value: true },
      ],
      actions: ['DENY', 'HANDOFF_TO_HUMAN'] as Policy['rules'][number]['actions'],
      severity: 'CRITICAL' as const,
    };
    rules.splice(1, 0, r007);
    return rules;
  }),
  /** Looser: higher synthetic-voice threshold (0.85 → 0.98) and prompt-injection quarantine removed. */
  looser: variant('FINANCIAL_ACCOUNT_POLICY_LOOSER', 'Financial Services — Looser variant (demo)', 5, rules => {
    const synthetic = rules.find(r => r.id === 'R001_SYNTHETIC_VOICE_BLOCK');
    if (synthetic) {
      const c = synthetic.conditions.find(x => x.field === 'syntheticVoiceProbability');
      if (c) c.value = 0.98;
    }
    return rules.filter(r => r.id !== 'R002_PROMPT_INJECTION_ISOLATE');
  }),
};
