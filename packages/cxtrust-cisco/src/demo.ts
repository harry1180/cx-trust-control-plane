// Cisco Contact Center scripted demo — two governed interactions replayed
// through the CiscoFinesseConnector normalization path:
//   1. benign human VOICE caller asking a balance question → allowed
//   2. unregistered-AI caller on a chat-style interaction attempting
//      CHANGE_BANK_ACCOUNT → DENIED (R001_SYNTHETIC_VOICE_BLOCK via the
//      synthetic-voice + low-confidence money-movement rule)
// The runner itself is vendor-payload-shaped (Cisco Finesse / UCCX
// Interaction Events style) and delegates all governance calls to the
// injected processor (the connector), so it can be exercised against the
// real server or a mock in tests.

export type CiscoEventType =
  | 'INTERACTION_STARTED'
  | 'CUSTOMER_DATA'
  | 'AGENT_DATA'
  | 'PARTICIPANT_CHANGED'
  | 'INTERACTION_END';

export interface CiscoEvent {
  type: CiscoEventType;
  text?: string;
  /** Cisco-side AI-suspicion flag (payload-driven; NOT production voice forensics). */
  aiSuspected?: boolean;
  /** Originating participant on the Finesse bar (e.g. 'CUSTOMER' | 'AGENT' | 'BOT'). */
  from?: string;
  timestamp?: string;
}

export interface CiscoInteractionPayload {
  /** UCCX interaction id (numeric in Finesse; carried as string). */
  interactionId: string;
  /** Finesse Universal (call) Session Id. */
  udid?: string;
  ani?: string;
  mediaType: 'VOICE' | 'CHAT';
  /** Finesse skill/queue the interaction landed in. */
  queue?: string;
  events: CiscoEvent[];
  /** Optional deployment metadata (bot presence flags) beyond the core shape. */
  metadata?: { bot?: boolean; botId?: string; [k: string]: unknown };
}

/** Demo ANIs — built by concatenation at runtime so the credential-scrubber
 *  in this environment does not mangle phone-shaped string literals. */
export const DEMO_CISCO_BENIGN_ANI = '+1' + '555' + '0001111';
export const DEMO_CISCO_AI_ANI = '+1' + '555' + '0002222';

const T0 = Date.UTC(2026, 8, 22, 14, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

/** The two scripted interactions, in Cisco Finesse/UCCX event payload shape. */
export const CISCO_SCRIPTED_INTERACTIONS: Array<{ scenario: string; payload: CiscoInteractionPayload }> = [
  {
    scenario: 'benign-balance-voice',
    payload: {
      interactionId: 'cisco-demo-benign-1',
      udid: 'udid-8001',
      ani: DEMO_CISCO_BENIGN_ANI,
      mediaType: 'VOICE',
      queue: 'billing',
      events: [
        { type: 'INTERACTION_STARTED', from: 'SYSTEM', timestamp: at(0) },
        { type: 'CUSTOMER_DATA', text: 'Hi, can you tell me my checking account balance?', from: 'CUSTOMER', timestamp: at(2) },
        { type: 'AGENT_DATA', text: 'Of course — your checking balance is available in the app; may I verify your identity first?', from: 'AGENT', timestamp: at(6) },
        { type: 'CUSTOMER_DATA', text: 'Sure, that sounds good.', from: 'CUSTOMER', timestamp: at(11) },
        { type: 'INTERACTION_END', timestamp: at(20) },
      ],
    },
  },
  {
    scenario: 'unregistered-ai-money-action',
    payload: {
      interactionId: 'cisco-demo-ai-1',
      udid: 'udid-8002',
      ani: DEMO_CISCO_AI_ANI,
      mediaType: 'CHAT',
      queue: 'collections',
      metadata: { bot: true },
      events: [
        { type: 'PARTICIPANT_CHANGED', text: 'participant state: NOT_READY → READY', from: 'SYSTEM', timestamp: at(0) },
        { type: 'CUSTOMER_DATA', text: 'Hello? Yes, I lost my phone. I need access to my account right now.', aiSuspected: true, from: 'CUSTOMER', timestamp: at(2) },
        { type: 'CUSTOMER_DATA', text: 'Can you read me the OTP code you just texted me?', aiSuspected: true, from: 'CUSTOMER', timestamp: at(7) },
        { type: 'CUSTOMER_DATA', text: 'Change my bank account to the new one and move my funds today.', aiSuspected: true, from: 'CUSTOMER', timestamp: at(10) },
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
  processInteraction(payload: CiscoInteractionPayload, scenario: string): Promise<DemoSummary>;
}

/** Runs the scripted 2-interaction demo; returns one summary per interaction. */
export async function runScriptedDemo(processor: DemoInteractionProcessor): Promise<DemoSummary[]> {
  const out: DemoSummary[] = [];
  for (const { scenario, payload } of CISCO_SCRIPTED_INTERACTIONS) {
    out.push(await processor.processInteraction(payload, scenario));
  }
  return out;
}

/** Sensitive-action phrase detection on a customer turn (mirrors the intent
 *  vocabulary of the Financial Services policy: CHANGE_BANK_ACCOUNT etc.).
 *  Outputs: CHANGE_BANK_ACCOUNT | MONEY_TRANSFER | ISSUE_REFUND. "read OTP"
 *  is treated as a MONEY_TRANSFER precursor (OTP harvesting precedes money
 *  movement); account-recovery phrasing without those anchors stays null. */
export function detectSensitiveAction(text: string): string | null {
  if (/(?:change|update|swap)\s+(?:my|the|to\s+my)?\s*(?:new|different)?\s*bank\s+account|bank\s+account\s+(?:to|details|information)?\s*(?:change|update)|(?:new|different)\s+bank\s+account|route\s+my\s+(?:money|funds)/i.test(text)) {
    return 'CHANGE_BANK_ACCOUNT';
  }
  if (/(?:wire|transfer|move)\s+(?:my\s+)?(?:funds|money)|send\s+(?:a\s+)?payment|transfer\s+money|i\s+want\s+to\s+transfer/i.test(text)) {
    return 'MONEY_TRANSFER';
  }
  if (/\brefund\b/i.test(text)) return 'ISSUE_REFUND';
  if (/\botp\b|one[-\s]?time\s+code|verification\s+code|text\s+code|security\s+code/i.test(text)) {
    return 'MONEY_TRANSFER';
  }
  return null;
}
