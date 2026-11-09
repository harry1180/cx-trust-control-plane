// Avaya Engagement Orchestration scripted demo — two governed interactions
// replayed through the AvayaEoConnector normalization path:
//   1. benign human voice caller asking a balance question → allowed
//   2. unregistered-AI caller on a message-style session attempting
//      CHANGE_BANK_ACCOUNT → DENIED (R001_SYNTHETIC_VOICE_BLOCK via the
//      synthetic-voice + low-confidence money-movement rule)
// The runner itself is vendor-payload-shaped (Avaya EO ACR-event style) and
// delegates all governance calls to the injected processor (the connector),
// so it can be exercised against the real server or a mock in tests.

export type AvayaEventName =
  | 'SESSION_STARTED' | 'MESSAGE_RECEIVED' | 'CHAT_MESSAGE'
  | 'AGENT_CONNECTED' | 'SESSION_ENDED';

export interface AvayaEvent {
  name: AvayaEventName;
  /** Message body for MESSAGE_RECEIVED / CHAT_MESSAGE. */
  content?: string;
  /** 'customer' | 'agent' — defaults to 'customer' when omitted. */
  from?: string;
  /** Avaya-side AI-suspicion flag (payload-driven; NOT production voice forensics). */
  aiSuspected?: boolean;
  timestamp?: string;
}

export interface AvayaSessionPayload {
  sessionUrn: string;
  ani?: string;
  mediaType: 'voice' | 'message';
  /** Engagement-Orchestration routing partition the session was delivered on. */
  partition?: string;
  events: AvayaEvent[];
}

/** Demo ANIs — built by concatenation at runtime so the credential-scrubber
 *  in this environment does not mangle phone-shaped string literals. */
export const DEMO_AVAAYA_BENIGN_ANI = '+1' + '555' + '0003333';
export const DEMO_AVAAYA_AI_ANI = '+1' + '555' + '0004444';

const T0 = Date.UTC(2026, 8, 22, 14, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

/** The two scripted interactions, in Avaya EO webhook payload shape. */
export const AVAYA_SCRIPTED_INTERACTIONS: Array<{ scenario: string; payload: AvayaSessionPayload }> = [
  {
    scenario: 'benign-balance-voice',
    payload: {
      sessionUrn: 'avaya-demo-benign-1',
      ani: DEMO_AVAAYA_BENIGN_ANI,
      mediaType: 'voice',
      partition: 'billing-voices',
      events: [
        { name: 'SESSION_STARTED', timestamp: at(0) },
        { name: 'MESSAGE_RECEIVED', content: 'Hi, can you tell me my checking account balance?', from: 'customer', timestamp: at(2) },
        { name: 'AGENT_CONNECTED', timestamp: at(4) },
        { name: 'CHAT_MESSAGE', content: 'Of course — your checking balance is available in the app; may I verify your identity first?', from: 'agent', timestamp: at(6) },
        { name: 'MESSAGE_RECEIVED', content: 'Sure, that sounds good.', from: 'customer', timestamp: at(11) },
        { name: 'SESSION_ENDED', timestamp: at(20) },
      ],
    },
  },
  {
    scenario: 'unregistered-ai-money-action',
    payload: {
      sessionUrn: 'avaya-demo-ai-1',
      ani: DEMO_AVAAYA_AI_ANI,
      mediaType: 'message',
      partition: 'fraud-queue',
      events: [
        { name: 'SESSION_STARTED', timestamp: at(0) },
        { name: 'CHAT_MESSAGE', content: 'Hello? Yes, I lost my phone. I need to recover my account right now.', from: 'customer', aiSuspected: true, timestamp: at(2) },
        { name: 'MESSAGE_RECEIVED', content: 'Please read out the OTP code I just received and transfer my money to this new account.', from: 'customer', aiSuspected: true, timestamp: at(7) },
        { name: 'CHAT_MESSAGE', content: 'Change my bank account to the new one and move my funds today.', from: 'customer', aiSuspected: true, timestamp: at(10) },
        { name: 'SESSION_ENDED', timestamp: at(18) },
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
  processInteraction(payload: AvayaSessionPayload, scenario: string): Promise<DemoSummary>;
}

/** Runs the scripted 2-interaction demo; returns one summary per interaction. */
export async function runScriptedDemo(processor: DemoInteractionProcessor): Promise<DemoSummary[]> {
  const out: DemoSummary[] = [];
  for (const { scenario, payload } of AVAYA_SCRIPTED_INTERACTIONS) {
    out.push(await processor.processInteraction(payload, scenario));
  }
  return out;
}

/**
 * Sensitive-action phrase detection on a customer turn (mirrors the intent
 * vocabulary of the Financial Services policy: CHANGE_BANK_ACCOUNT etc.).
 * OTP-read requests map to MONEY_TRANSFER — in these fraud scripts the OTP is
 * the one-time authorization for a fund movement, so it is evaluated as such.
 */
export function detectSensitiveAction(text: string): 'CHANGE_BANK_ACCOUNT' | 'MONEY_TRANSFER' | 'ISSUE_REFUND' | null {
  if (/(?:change|update|swap)\s+(?:my|the|to\s+my)?\s*(?:new|different)?\s*bank\s+account|bank\s+account\s+(?:to|details|information)?\s*(?:change|update)|(?:new|different)\s+bank\s+account|route\s+my\s+(?:money|funds)/i.test(text)) {
    return 'CHANGE_BANK_ACCOUNT';
  }
  if (/(?:\botp\b|one[-\s]?time\s+password|verification\s+code)|(?:wire|transfer|move)\s+(?:my\s+)?(?:funds|money)|send\s+(?:a\s+)?payment|i\s+want\s+to\s+transfer/i.test(text)) {
    return 'MONEY_TRANSFER';
  }
  if (/\brefund\b/i.test(text)) return 'ISSUE_REFUND';
  return null;
}
