// Session hooks glue: wires the standalone biometrics + passport packages
// into GovernanceSession instances created by the API server. Pure
// function-injection — core has no dependency on these packages.

import type { AgentRegistration, Detection } from '@cxtrust/core';
import { DEMO_AGENTS } from '@cxtrust/core';
import { analyzeBehavior } from '@cxtrust/biometrics';
import { buildDemoTrustFabric, passportCheck } from '@cxtrust/passport';

const fabric = buildDemoTrustFabric();

/**
 * Agents for server-created sessions: the passport fabric's SIGNED
 * registrations (a valid one and a revoked one) replace the unsigned display
 * copies for any agent the fabric knows; everything else passes through.
 * Unsigned-passport agents verify against nothing and must not masquerade as
 * verified — that is the zero-trust story the fabric demonstrates.
 */
export function registryAgents(): AgentRegistration[] {
  const known = new Set([
    fabric.collections.registration.agentId,
    fabric.refund.registration.agentId,
  ]);
  return [
    { ...fabric.collections.registration, passport: fabric.collections.passport },
    { ...fabric.refund.registration, passport: fabric.refund.passport },
    ...DEMO_AGENTS.filter(a => !known.has(a.agentId)),
  ];
}

interface HookCtx { interactionId: string; turnSeq: () => number }

/** Build the opt-in hooks for one live session. */
export function sessionHooks(ctx: HookCtx) {
  return {
    behavioral: (turns: { participantId: string; text: string; offsetS: number }[]): Detection[] => {
      try {
        const now = new Date().toISOString();
        const offsetS = turns[turns.length - 1]?.offsetS ?? 0;
        // biometrics returns a partial Detection (caller completes it per core schema)
        return analyzeBehavior(turns, {
          interactionId: ctx.interactionId,
          now,
          offsetS,
          seq: ctx.turnSeq(),
        }).map(d => ({
          ...d,
          interactionId: ctx.interactionId,
          category: 'AGENT_BEHAVIOR' as const,
          ts: now,
          offsetS,
          evidence: d.evidence.map(e => ({ kind: 'behavior' as const, text: e.text, locator: e.locator })),
        }));
      } catch {
        return []; // behavior analysis must never break the governance loop
      }
    },
    passportCheck: (registration: AgentRegistration) =>
      // registrations from registryAgents() carry the fabric's SIGNED passport;
      // any other agentId must present its own passport or verify fails
      passportCheck(registration),
  };
}
