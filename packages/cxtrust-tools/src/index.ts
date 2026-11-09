// Tool governance + Authority Verification — the charter differentiator:
// verify WHAT THE AI SAID against WHAT THE AI ACTUALLY DID.
//
// Shape (mirrors the biometrics hook-injection pattern — core stays
// dependency-free; this package plugs into the server and the session via
// additive fields):
//
//   ToolCall record: who invoked what, with what, authorized?, result?
//   AuthorityVerificationEngine: claim(text) + toolCall → CLAIM_MATCH |
//     CLAIM_MISMATCH | CLAIM_UNVERIFIABLE, each with reasons + a Detection
//     the session can ingest.

import type { Detection, EvidenceItem } from '@cxtrust/core';

// ---------- Tool risk classification ----------

export type ToolRiskCategory =
  | 'READ_ONLY' | 'LOW_RISK_WRITE' | 'PROFILE_CHANGE' | 'ACCOUNT_CHANGE'
  | 'FINANCIAL' | 'IDENTITY' | 'HEALTH' | 'LEGAL' | 'HIGH_IMPACT' | 'CUSTOM';

export const TOOL_RISK: Record<string, ToolRiskCategory> = {
  GET_BALANCE: 'READ_ONLY',
  GET_ACCOUNT: 'READ_ONLY',
  SEARCH_FAQ: 'READ_ONLY',
  UPDATE_ADDRESS: 'PROFILE_CHANGE',
  UPDATE_CONTACT: 'PROFILE_CHANGE',
  UPDATE_EMAIL: 'PROFILE_CHANGE',
  CHANGE_BANK_ACCOUNT: 'ACCOUNT_CHANGE',
  UPDATE_BENEFICIARY: 'ACCOUNT_CHANGE',
  MONEY_TRANSFER: 'FINANCIAL',
  PAYMENT: 'FINANCIAL',
  REFUND: 'FINANCIAL',
  VERIFY_IDENTITY: 'IDENTITY',
  RESET_CREDENTIALS: 'IDENTITY',
  ACCESS_MEDICAL_RECORD: 'HEALTH',
  SUBMIT_CLAIM: 'LEGAL',
  CANCEL_POLICY: 'LEGAL',
  DELETE_RECORD: 'HIGH_IMPACT',
};

/** Authentication floor per risk category (NONE/LOW/MEDIUM/HIGH). */
export const REQUIRED_AUTH_LEVEL: Record<ToolRiskCategory, 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'> = {
  READ_ONLY: 'NONE',
  LOW_RISK_WRITE: 'LOW',
  PROFILE_CHANGE: 'MEDIUM',
  ACCOUNT_CHANGE: 'HIGH',
  FINANCIAL: 'HIGH',
  IDENTITY: 'HIGH',
  HEALTH: 'HIGH',
  LEGAL: 'MEDIUM',
  HIGH_IMPACT: 'HIGH',
  CUSTOM: 'MEDIUM',
};

const AUTH_RANK = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

export function authSufficient(actual: string | undefined, required: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'): boolean {
  return (AUTH_RANK[(actual ?? 'NONE') as keyof typeof AUTH_RANK] ?? 0) >= AUTH_RANK[required];
}

// ---------- ToolCall record ----------

export interface ToolCall {
  toolCallId: string;
  interactionId: string;
  participantId?: string;
  agentId?: string;
  tool: string;
  args?: Record<string, unknown>;
  /** authentication level at invocation time */
  authLevel: string;
  /** did the pre-execution policy gate allow it? */
  policyAllowed: boolean;
  policyDecisionId?: string;
  riskCategory: ToolRiskCategory;
  /** execution outcome reported by the tool adapter */
  status: 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'NOT_EXECUTED';
  resultSummary?: string;
  error?: string;
  latencyMs?: number;
  /** seconds into the interaction when the call happened (conversation timeline) */
  offsetS: number;
  ts: string;
}

export function classifyTool(tool: string): ToolRiskCategory {
  return TOOL_RISK[tool.toUpperCase()] ?? 'CUSTOM';
}

// ---------- Claim extraction ----------

export interface AgentClaim {
  /** action the agent asserted as done, normalized to a tool name when possible */
  assertedAction: string;
  /** raw quote from the agent's speech */
  quote: string;
  /** offset in the conversation */
  offsetS: number;
}

const CLAIM_PATTERNS: { re: RegExp; tool: string }[] = [
  { re: /\b(?:your|the) (?:payment|bill) (?:has|was|is|has been|was been)? ?(?:been )?(?:processed|completed|paid|made)\b/i, tool: 'PAYMENT' },
  { re: /\b(?:I'?ve|I have|I)? ?(?:processed|completed|paid) (?:your )?payment\b/i, tool: 'PAYMENT' },
  { re: /\b(?:your|the|my) (?:address|mailing address) (?:has|was|is|has been|was been)? ?(?:been )?(?:updated|changed)\b/i, tool: 'UPDATE_ADDRESS' },
  { re: /\b(?:I'?ve|I have|I)? ?(?:updated|changed) (?:your )?(?:address|mailing address)\b/i, tool: 'UPDATE_ADDRESS' },
  { re: /\b(?:money|funds|\$?[\d,.]+) (?:has|was|have|were)? ?(?:been )?(?:transferred|sent|moved)\b/i, tool: 'MONEY_TRANSFER' },
  { re: /\b(?:I'?ve|I have|I)? ?(?:transferred|sent|moved) (?:the )?(?:money|funds)\b/i, tool: 'MONEY_TRANSFER' },
  { re: /\b(?:your|the) (?:bank|account) (?:details|account) (?:has|was|is|has been|was been)? ?(?:been )?(?:updated|changed|saved)\b/i, tool: 'CHANGE_BANK_ACCOUNT' },
  { re: /\b(?:refund|refunds) (?:has|was|have|were)? ?(?:been )?(?:issued|processed|approved)\b/i, tool: 'REFUND' },
  { re: /\b(?:I'?ve|I have|I)? ?(?:cancelled|canceled) (?:your )?(?:policy|subscription|account)\b/i, tool: 'CANCEL_POLICY' },
];

/** Extract completion claims from an agent's spoken turn. */
export function extractClaims(agentText: string, offsetS: number): AgentClaim[] {
  const out: AgentClaim[] = [];
  for (const p of CLAIM_PATTERNS) {
    const m = agentText.match(p.re);
    if (m) out.push({ assertedAction: p.tool, quote: m[0], offsetS });
  }
  return out;
}

// ---------- Authority / action verification ----------

export type ClaimVerdict = 'CLAIM_MATCH' | 'CLAIM_MISMATCH' | 'CLAIM_UNVERIFIABLE';

export interface VerificationResult {
  verdict: ClaimVerdict;
  claim: AgentClaim;
  matchedToolCall?: ToolCall;
  reasons: string[];
  /** Detection ready for GovernanceSession.ingestDetection (set for MISMATCH) */
  detection?: Detection;
}

export interface AuthorityVerificationEngineOptions {
  /** how far back (seconds) a matching tool call may precede the claim */
  windowS?: number;
  /** default 'internal-authority-v1' provider id on raised detections */
  providerId?: string;
}

/**
 * Verifies agent claims against actual tool executions for one interaction.
 * Call `verifyClaims(agentText, offsetS)` after each agent turn; the engine
 * matches each claim against the most recent successful ToolCall of the same
 * tool within the window.
 */
export class AuthorityVerificationEngine {
  private interactionId: string;
  private calls: ToolCall[] = [];
  private windowS: number;
  private providerId: string;

  constructor(interactionId: string, opts: AuthorityVerificationEngineOptions = {}) {
    this.interactionId = interactionId;
    this.windowS = opts.windowS ?? 120;
    this.providerId = opts.providerId ?? 'internal-authority-v1';
  }

  recordToolCall(call: Omit<ToolCall, 'toolCallId' | 'ts' | 'riskCategory'> & { riskCategory?: ToolRiskCategory; ts?: string }): ToolCall {
    const full: ToolCall = {
      ...call,
      riskCategory: call.riskCategory ?? classifyTool(call.tool),
      toolCallId: `tc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      ts: call.ts ?? new Date().toISOString(),
    };
    this.calls.push(full);
    return full;
  }

  listToolCalls(): ToolCall[] { return [...this.calls]; }

  /**
   * Verify an agent's turn for completion claims. CLAIM_MISMATCH produces a
   * Detection (category AGENT_BEHAVIOR, code 'authority_claim_mismatch') that
   * the session ingests — risk fuses, policy may block.
   */
  verifyClaims(agentText: string, participantId: string | undefined, offsetS: number): VerificationResult[] {
    const claims = extractClaims(agentText, offsetS);
    const results: VerificationResult[] = [];
    for (const claim of claims) {
      const candidates = this.calls
        .filter(c => c.tool.toUpperCase() === claim.assertedAction
          && (offsetS - c.offsetS) >= -2 // allow the call to be at/just after the same turn
          && (offsetS - c.offsetS) <= this.windowS)
        .sort((a, b) => b.offsetS - a.offsetS);
      const matched = candidates[0];
      if (!matched) {
        results.push({
          verdict: 'CLAIM_UNVERIFIABLE', claim,
          reasons: [`no recorded tool call for ${claim.assertedAction} within ${this.windowS}s of the claim`],
        });
        continue;
      }
      if (matched.status === 'SUCCESS' && matched.policyAllowed) {
        results.push({
          verdict: 'CLAIM_MATCH', claim, matchedToolCall: matched,
          reasons: [`tool ${matched.tool} executed successfully (policy allowed)`],
        });
        continue;
      }
      const reasons: string[] = [];
      if (matched.status !== 'SUCCESS') reasons.push(`tool ${matched.tool} did NOT succeed (status ${matched.status})`);
      else reasons.push(`tool ${matched.tool} succeeded but the policy gate had NOT allowed it`);
      const detection: Detection = {
        detectionId: `det-${this.interactionId}-authority_claim_mismatch-${offsetS}-${Math.floor(Math.random() * 1e6)}`,
        interactionId: this.interactionId,
        participantId,
        category: 'AGENT_BEHAVIOR',
        code: 'authority_claim_mismatch',
        title: `Agent claimed ${claim.assertedAction} but the tool did not confirm it`,
        confidence: 0.95,
        weight: 25,
        ts: new Date().toISOString(),
        offsetS,
        evidence: [
          { kind: 'transcript', text: `Agent claim: "${claim.quote}"`, locator: `t+${claim.offsetS}s` } as EvidenceItem,
          { kind: 'metadata', text: `Tool result: ${matched.tool} status=${matched.status} policyAllowed=${matched.policyAllowed}`, locator: `toolcall:${matched.toolCallId}` } as EvidenceItem,
        ],
        providerId: this.providerId,
      };
      results.push({ verdict: 'CLAIM_MISMATCH', claim, matchedToolCall: matched, reasons, detection });
    }
    return results;
  }
}

/** Pre-execution gate: can this tool be invoked at all (auth floor)? */
export function canInvokeTool(call: {
  tool: string; authLevel: string; policyAllowed: boolean;
}): { ok: boolean; reason?: string; riskCategory: ToolRiskCategory; requiredAuth: string } {
  const riskCategory = classifyTool(call.tool);
  const requiredAuth = REQUIRED_AUTH_LEVEL[riskCategory];
  if (!authSufficient(call.authLevel, requiredAuth)) {
    return { ok: false, reason: `tool ${call.tool} (${riskCategory}) requires auth level ${requiredAuth}; caller had ${call.authLevel}`, riskCategory, requiredAuth };
  }
  if (!call.policyAllowed) return { ok: false, reason: `policy gate denied ${call.tool}`, riskCategory, requiredAuth };
  return { ok: true, riskCategory, requiredAuth };
}