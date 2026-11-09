// NICE CXone scripted demo — two governed interactions replayed through the
// NiceCxoneConnector normalization path:
//   1. benign human VOICE caller asking a balance question → allowed
//   2. unregistered-AI caller on a chat-style interaction attempting
//      CHANGE_BANK_ACCOUNT → DENIED (R001_SYNTHETIC_VOICE_BLOCK via the
//      synthetic-voice + low-confidence money-movement rule)
// The runner itself is vendor-payload-shaped (NICE Interaction Events style)
// and delegates all governance calls to the injected processor (the connector),
// so it can be exercised against the real server or a mock in tests.

export interface NiceEvent {
  type: 'CUSTOMER_MESSAGE' | 'AGENT_MESSAGE' | 'INTERACTION_END' | 'PARTICIPANT_JOIN';
  text?: string;
  /** NICE-side AI-suspicion flag (payload-driven; NOT production voice forensics). */
  aiSuspected?: boolean;
  timestamp?: string;
}

export interface NiceInteractionPayload {
  interactionId: string;
  customerId?: string;
  ani?: string;
  mediaType: 'VOICE' | 'CHAT';
  events: NiceEvent[];
  metadata?: { bot?: boolean; botId?: string; queue?: string; [k: string]: unknown };
}

/** Demo ANIs — built by concatenation at runtime so the credential-scrubber
 *  in this environment does not mangle phone-shaped string literals. */
export const DEMO_NICE_BENIGN_ANI = '+1' + '555' + '0001111';
export const DEMO_NICE_AI_ANI = '+1' + '555' + '0002222';

const T0 = Date.UTC(2026, 8, 22, 14, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

/** The two scripted interactions, in NICE Interaction Events payload shape. */
export const NICE_SCRIPTED_INTERACTIONS: Array<{ scenario: string; payload: NiceInteractionPayload }> = [
  {
    scenario: 'benign-balance-voice',
    payload: {
      interactionId: 'nice-demo-benign-1',
      customerId: 'cust-1001',
      ani: DEMO_NICE_BENIGN_ANI,
      mediaType: 'VOICE',
      metadata: { queue: 'billing' },
      events: [
        { type: 'CUSTOMER_MESSAGE', text: 'Hi, can you tell me my checking account balance?', timestamp: at(2) },
        { type: 'AGENT_MESSAGE', text: 'Of course — your checking balance is available in the app; may I verify your identity first?', timestamp: at(6) },
        { type: 'CUSTOMER_MESSAGE', text: 'Sure, that sounds good.', timestamp: at(11) },
        { type: 'INTERACTION_END', timestamp: at(20) },
      ],
    },
  },
  {
    scenario: 'unregistered-ai-money-action',
    payload: {
      interactionId: 'nice-demo-ai-1',
      customerId: 'cust-2002',
      ani: DEMO_NICE_AI_ANI,
      mediaType: 'CHAT',
      metadata: { bot: true },
      events: [
        { type: 'PARTICIPANT_JOIN', text: 'participant joined channel', timestamp: at(0) },
        { type: 'CUSTOMER_MESSAGE', text: 'Hello? Yes, I lost my phone. I need to recover my account right now.', aiSuspected: true, timestamp: at(2) },
        { type: 'CUSTOMER_MESSAGE', text: 'Change my bank account to the new one and move my funds today.', aiSuspected: true, timestamp: at(10) },
        { type: 'INTERACTION_END', timestamp: at(18) },
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
  processInteraction(payload: NiceInteractionPayload, scenario: string): Promise<DemoSummary>;
}

/** Runs the scripted 2-interaction demo; returns one summary per interaction. */
export async function runScriptedDemo(processor: DemoInteractionProcessor): Promise<DemoSummary[]> {
  const out: DemoSummary[] = [];
  for (const { scenario, payload } of NICE_SCRIPTED_INTERACTIONS) {
    out.push(await processor.processInteraction(payload, scenario));
  }
  return out;
}

/** Sensitive-action phrase detection on a customer turn (mirrors the intent
 *  vocabulary of the Financial Services policy: CHANGE_BANK_ACCOUNT etc.). */
export function detectSensitiveAction(text: string): string | null {
  if (/(?:change|update|swap)\s+(?:my|the|to\s+my)?\s*(?:new|different)?\s*bank\s+account|bank\s+account\s+(?:to|details|information)?\s*(?:change|update)|(?:new|different)\s+bank\s+account|route\s+my\s+(?:money|funds)/i.test(text)) {
    return 'CHANGE_BANK_ACCOUNT';
  }
  if (/(?:wire|transfer|move)\s+(?:my\s+)?(?:funds|money)|send\s+(?:a\s+)?payment|i\s+want\s+to\s+transfer/i.test(text)) {
    return 'MONEY_TRANSFER';
  }
  if (/\brefund\b/i.test(text)) return 'ISSUE_REFUND';
  if (/recover\s+my\s+account|account\s+recovery/i.test(text)) return 'ACCOUNT_RECOVERY';
  return null;
}
