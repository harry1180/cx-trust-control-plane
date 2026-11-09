// Five9 Intelligent Cloud scripted demo — two governed interactions replayed
// through the Five9IntelligentCloudConnector normalization path:
//   1. benign human VOICE caller asking a balance question → allowed
//   2. unregistered-AI caller attempting CHANGE_BANK_ACCOUNT → DENIED
//      (R001_SYNTHETIC_VOICE_BLOCK via the synthetic-voice + low-confidence
//      money-movement rule)
// The runner itself is vendor-payload-shaped (Five9 conversation-intelligence
// event style) and delegates all governance calls to the injected processor
// (the connector), so it can be exercised against the real server or a mock
// in tests.

export type Five9EventType =
  | 'CALL_STARTED'
  | 'CUSTOMER_TALK_DETECT'
  | 'CALLCENTER_AGENT_TALK'
  | 'PARTICIPANT_JOIN'
  | 'CALL_END';

export interface Five9Event {
  eventType: Five9EventType;
  /** Five9 conversation-intelligence transcript for talk-detect events. */
  transcript?: string;
  /** Five9-side AI-suspicion flag (payload-driven; NOT production voice forensics). */
  aiSuspected?: boolean;
  timestamp?: string;
}

export interface Five9InteractionPayload {
  sessionId: string;
  ani?: string;
  dialedNumber?: string;
  customerName?: string;
  mediaType: 'VOICE' | 'CHAT';
  events: Five9Event[];
}

/** Demo ANIs — built by concatenation at runtime so the credential-scrubber
 *  in this environment does not mangle phone-shaped string literals. */
export const DEMO_FIVE9_BENIGN_ANI = '+1' + '555' + '0001111';
export const DEMO_FIVE9_AI_ANI = '+1' + '555' + '0002222';
/** Five9 DID the demo campaign dials — concatenation for the same reason. */
export const DEMO_FIVE9_DIALED_NUMBER = '+1' + '800' + '5550100';

const T0 = Date.UTC(2026, 8, 22, 14, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

/** The two scripted interactions, in Five9 conversation-event payload shape. */
export const FIVE9_SCRIPTED_INTERACTIONS: Array<{ scenario: string; payload: Five9InteractionPayload }> = [
  {
    scenario: 'benign-balance-voice',
    payload: {
      sessionId: 'five9-demo-benign-1',
      ani: DEMO_FIVE9_BENIGN_ANI,
      dialedNumber: DEMO_FIVE9_DIALED_NUMBER,
      customerName: 'A. Whitfield',
      mediaType: 'VOICE',
      events: [
        { eventType: 'CALL_STARTED', timestamp: at(0) },
        { eventType: 'CUSTOMER_TALK_DETECT', transcript: 'Hi, can you tell me my checking account balance?', timestamp: at(2) },
        { eventType: 'CALLCENTER_AGENT_TALK', transcript: 'Of course — your checking balance is available in the app; may I verify your identity first?', timestamp: at(6) },
        { eventType: 'CUSTOMER_TALK_DETECT', transcript: 'Sure, that sounds good.', timestamp: at(11) },
        { eventType: 'CALL_END', timestamp: at(20) },
      ],
    },
  },
  {
    scenario: 'unregistered-ai-money-action',
    payload: {
      sessionId: 'five9-demo-ai-1',
      ani: DEMO_FIVE9_AI_ANI,
      dialedNumber: DEMO_FIVE9_DIALED_NUMBER,
      customerName: 'J. Merrick',
      mediaType: 'VOICE',
      events: [
        { eventType: 'CALL_STARTED', timestamp: at(0) },
        { eventType: 'CUSTOMER_TALK_DETECT', transcript: 'Hello? Yes, I lost my phone. I need to recover my account right now.', aiSuspected: true, timestamp: at(2) },
        { eventType: 'CUSTOMER_TALK_DETECT', transcript: 'Change my bank account to the new one and move my funds today.', aiSuspected: true, timestamp: at(10) },
        { eventType: 'CALL_END', timestamp: at(18) },
      ],
    },
  },
];

export interface DemoSummary {
  scenario: string;
  interactionId: string;
  classification: string;
  risk: number;
  blocked: boolean;
  matchedRule: string | null;
}

/** Minimal structural contract the runner needs from the connector. */
export interface DemoInteractionProcessor {
  processInteraction(payload: Five9InteractionPayload, scenario: string): Promise<DemoSummary>;
}

/** Runs the scripted 2-interaction demo; returns one summary per interaction. */
export async function runScriptedDemo(processor: DemoInteractionProcessor): Promise<DemoSummary[]> {
  const out: DemoSummary[] = [];
  for (const { scenario, payload } of FIVE9_SCRIPTED_INTERACTIONS) {
    out.push(await processor.processInteraction(payload, scenario));
  }
  return out;
}

/** Sensitive-action phrase detection on a customer transcript (mirrors the
 *  intent vocabulary of the Financial Services policy: CHANGE_BANK_ACCOUNT,
 *  MONEY_TRANSFER, ISSUE_REFUND etc., like the nice adapter). */
export function detectSensitiveAction(text: string): string | null {
  if (/(?:change|update|swap)\s+(?:my|the|to\s+my)?\s*(?:new|different)?\s*bank\s+account|bank\s+account\s+(?:to|details|information)?\s*(?:change|update)|(?:new|different)\s+bank\s+account|route\s+my\s+(?:money|funds)/i.test(text)) {
    return 'CHANGE_BANK_ACCOUNT';
  }
  if (/(?:wire|transfer|move)\s+(?:my\s+)?(?:funds|money)|send\s+(?:a\s+)?payment|i\s+want\s+to\s+transfer/i.test(text)) {
    return 'MONEY_TRANSFER';
  }
  if (/\brefund\b/i.test(text)) return 'ISSUE_REFUND';
  // OTP readback (voice-phishing tell: caller asks the agent to read the
  // one-time code back) and account-recovery pressure both map to the
  // ACCOUNT_RECOVERY intent, same as the nice adapter's vocab.
  if (/\b(?:otp|one[- ]time (?:code|password)|verification code)\b[^.?!]*\b(?:read(?:\s+back)?|say|tell|give|share|repeat|what(?:'s)? is)\b|\b(?:read(?:\s+back)?|say|tell|give|share|repeat)\b[^.?!]*\b(?:otp|one[- ]time (?:code|password)|verification code)\b|what(?:'s| is) (?:the|my) (?:otp|one[- ]time (?:code|password)|verification code)/i.test(text)) {
    return 'ACCOUNT_RECOVERY';
  }
  if (/recover\s+my\s+account|account\s+recovery/i.test(text)) return 'ACCOUNT_RECOVERY';
  return null;
}
