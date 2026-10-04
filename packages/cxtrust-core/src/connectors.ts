// Adapter framework: standardized connector interface + demo connectors.
// A real Amazon Connect / Twilio / Genesys adapter implements Connector and
// emits the same normalized events; core never sees vendor payloads.

import type { InteractionEnvelope, Channel } from './schema.ts';
import { GovernanceSession, type SessionEvents } from './session.ts';
import type { TurnInput } from './detections.ts';

export interface Connector {
  id: string;
  platform: string;
  register(): Promise<void>;
  startInteraction(init: { channel: Channel; metadata: Record<string, unknown> }): InteractionEnvelope;
  streamAudio(sig: { isSynthetic?: boolean; isReplay?: boolean }): void;
  emitTurn(turn: TurnInput): void;
  executeAction(action: string, params: Record<string, unknown>): Promise<{ ok: boolean; blockedBy?: string }>;
  stopInteraction(): void;
}

export class SimulatedVoiceConnector implements Connector {
  readonly id: string;
  readonly platform: string;
  private session?: GovernanceSession;
  private interaction?: InteractionEnvelope;
  private events: SessionEvents;

  constructor(id: string, platform: string, events: SessionEvents = {}) {
    this.id = id;
    this.platform = platform;
    this.events = events;
  }

  async register() { /* demo adapter: no external handshake needed */ }

  startInteraction(init: { channel: Channel; metadata: Record<string, unknown> }): InteractionEnvelope {
    this.interaction = {
      interactionId: `INT-${Date.now()}-${Math.floor(Math.random() * 1e5)}`,
      organizationId: init.metadata.organizationId as string ?? 'org-demo',
      channel: init.channel,
      platform: this.platform,
      startedAt: new Date().toISOString(),
      metadata: init.metadata,
    };
    this.session = new GovernanceSession(this.interaction, DEMO_AGENTS, this.events);
    return this.interaction;
  }

  streamAudio(sig: { isSynthetic?: boolean; isReplay?: boolean }) {
    void sig;
  }

  emitTurn(turn: TurnInput) {
    this.session?.addTurn(turn);
  }

  async executeAction(action: string, params: Record<string, unknown>) {
    const decision = this.session?.evaluateAction({
      requestedAction: action,
      participantId: String(params.participantId ?? ''),
      amount: params.amount as number | undefined,
      resource: params.resource as string | undefined,
      intent: params.intent as string | undefined,
    });
    const allowed = !!decision?.allowed;
    return { ok: allowed, blockedBy: allowed ? undefined : decision?.matchedRule };
  }

  stopInteraction() {
    this.session?.end();
  }

  getSession() { return this.session; }
}

export const DEMO_AGENTS: import('./schema.ts').AgentRegistration[] = [
  {
    agentId: 'ACME-COLLECTIONS-AGENT-145',
    name: 'Acme Collections Agent',
    organizationId: 'org-acme',
    owner: 'collections-eng@acme.example.com',
    environment: 'PROD',
    modelProvider: 'internal',
    model: 'acme-voice-2',
    purpose: 'Collections',
    approvedVoice: 'voice-pool-a',
    approvedChannels: ['voice'],
    approvedTools: ['customer.lookup', 'payment.arrangement'],
    approvedDomains: ['acme.example.com'],
    permittedDataClasses: ['INTERNAL'],
    permittedActions: ['CUSTOMER_LOOKUP', 'PAYMENT_ARRANGEMENT'],
    maxTransactionLimit: 5000,
    riskClassification: 'MEDIUM',
    humanEscalationPolicy: 'transfer-supervisor-on-dispute',
    jurisdiction: 'US',
    policyVersion: 4,
    deploymentVersion: '2.1.0',
    lastAttestationAt: new Date().toISOString(),
    passport: {
      certificateId: 'cert-acme-145', subjectAgentId: 'ACME-COLLECTIONS-AGENT-145',
      issuer: 'cxtrust-demo-ca', validFrom: '2026-01-01T00:00:00Z',
      validTo: '2027-01-01T00:00:00Z', signatureAlg: 'ed25519',
    },
  },
  {
    agentId: 'AGENT-TWILIO-BOT-9',
    name: 'Twilio Outbound Bot',
    organizationId: 'org-demo',
    owner: 'growth@demo.example.com',
    environment: 'STAGING',
    modelProvider: 'external',
    model: 'generic-tts-bot',
    purpose: 'Outbound notifications',
    approvedChannels: ['voice'],
    approvedTools: [],
    approvedDomains: [],
    permittedDataClasses: ['PUBLIC'],
    permittedActions: ['NOTIFY'],
    maxTransactionLimit: 0,
    riskClassification: 'LOW',
    humanEscalationPolicy: 'disconnect',
    jurisdiction: 'US',
    policyVersion: 4,
    deploymentVersion: '1.0.3',
  },
];
