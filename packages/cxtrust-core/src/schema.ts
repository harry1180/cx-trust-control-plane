// Normalized Interaction Event Schema — the contract every adapter emits.
// No downstream module may reference a vendor (Connect/Genesys/Twilio/SIP);
// adapters normalize vendor payloads into these types only.

export type InteractionEventType =
  | 'interaction.started'
  | 'participant.joined'
  | 'participant.changed'
  | 'audio.received'
  | 'transcript.partial'
  | 'transcript.final'
  | 'agent.action.requested'
  | 'agent.action.executed'
  | 'tool.called'
  | 'authentication.requested'
  | 'authentication.completed'
  | 'policy.triggered'
  | 'risk.updated'
  | 'detection.raised'
  | 'enforcement.executed'
  | 'interaction.ended';

export type Channel = 'voice' | 'chat' | 'email' | 'video' | 'api';

export interface EventBase {
  eventId: string;
  type: InteractionEventType;
  /** ISO-8601 wall-clock time of the event */
  ts: string;
  /** seconds into the interaction */
  offsetS: number;
  interactionId: string;
  /** id of the emitting connector instance, e.g. "connect-sim-1" */
  sourceConnector: string;
  /** participant this event concerns, if any */
  participantId?: string;
  /** free-form vendor-neutral payload; consumers must not require vendor keys */
  payload: Record<string, unknown>;
}

/** InteractionEnvelope: one governed interaction from started to ended. */
export interface InteractionEnvelope {
  interactionId: string;
  organizationId: string;
  channel: Channel;
  /** which connector produced it, normalized */
  platform: string; // e.g. 'amazon-connect', 'websocket-voice-ai', 'twilio'
  startedAt: string;
  endedAt?: string;
  /** ANI/destination/etc lives in events, not here — privacy by default */
  metadata: Record<string, unknown>;
}

// ---------- Participants ----------

export type ParticipantKind =
  | 'CUSTOMER'
  | 'AGENT'
  | 'ENTERPRISE_AI'
  | 'THIRD_PARTY_AI'
  | 'EXTERNAL_AI'
  | 'SUPERVISOR';

export type TrustClassification =
  | 'HUMAN_VERIFIED'
  | 'HUMAN_UNKNOWN'
  | 'HUMAN_SUSPECTED'
  | 'HUMAN_IMPERSONATION_RISK'
  | 'AUTHORIZED_ENTERPRISE_AI'
  | 'VERIFIED_THIRD_PARTY_AI'
  | 'KNOWN_EXTERNAL_AI'
  | 'UNKNOWN_AI'
  | 'MALICIOUS_AUTOMATION'
  | 'SYNTHETIC_IDENTITY'
  | 'REPLAYED_AUDIO'
  | 'UNKNOWN_PARTICIPANT';

export type AuthLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface Participant {
  participantId: string;
  interactionId: string;
  organizationId: string;
  kind: ParticipantKind;
  classification: TrustClassification;
  /** 0..1 */
  identityConfidence: number;
  /** set only for registered agents */
  agentId?: string;
  /** audio/telephony-derived profile hash (not raw audio) */
  voiceSignatureHash?: string;
  authLevel: AuthLevel;
  /** joined mid-interaction, speaker change, etc. */
  joinedAtOffsetS: number;
  leftAtOffsetS?: number;
  riskState: ParticipantRiskState;
  /** set by the GovernanceSession when a passportCheck hook verified the agent (additive) */
  passportVerified?: boolean;
  /** reasons reported by the passportCheck hook (additive) */
  passportReasons?: string[];
}

export interface ParticipantRiskState {
  syntheticVoiceProbability?: number;
  replayProbability?: number;
  impersonationProbability?: number;
  callerReputation?: 'LOW' | 'MEDIUM' | 'HIGH';
  telephonyAnomaly?: boolean;
}

// ---------- Detections ----------

export type DetectionCategory =
  | 'VOICE_TRUST'
  | 'CONVERSATION'
  | 'PROMPT_INJECTION'
  | 'DATA_EXPOSURE'
  | 'TELEPHONY'
  | 'AGENT_BEHAVIOR'
  | 'FRAUD';

export interface Detection {
  detectionId: string;
  interactionId: string;
  participantId?: string;
  category: DetectionCategory;
  /** stable identifier, e.g. "synthetic_voice", "otp_harvesting", "prompt_injection" */
  code: string;
  title: string;
  /** 0..1 provider/model confidence */
  confidence: number;
  /** 0..100 contribution weight applied by risk fusion */
  weight: number;
  ts: string;
  offsetS: number;
  evidence: EvidenceItem[];
  /** which engine produced it */
  providerId: string;
}

export interface EvidenceItem {
  kind: 'transcript' | 'audio_signal' | 'metadata' | 'policy' | 'behavior';
  text: string;
  /** quoted span reference or signal reading */
  locator?: string;
}

// ---------- Risk ----------

export type RiskDimension =
  | 'IDENTITY_RISK'
  | 'VOICE_RISK'
  | 'TELEPHONY_RISK'
  | 'FRAUD_RISK'
  | 'CONVERSATION_RISK'
  | 'CYBER_RISK'
  | 'AI_AGENT_RISK'
  | 'DATA_RISK'
  | 'COMPLIANCE_RISK'
  | 'TRANSACTION_RISK'
  | 'BEHAVIORAL_RISK';

export interface RiskState {
  overall: number; // 0..100
  dimensions: Record<RiskDimension, number>;
  reasons: RiskReason[];
  asOfOffsetS: number;
}

export interface RiskReason {
  points: number;
  label: string;
  source: string; // detection id / policy id
}

// ---------- Policy / decisions ----------

export type EnforcementAction =
  | 'ALLOW'
  | 'ALLOW_WITH_MONITORING'
  | 'WARN'
  | 'REDACT'
  | 'MASK'
  | 'CHALLENGE'
  | 'STEP_UP_AUTH'
  | 'REQUIRE_APPROVAL'
  | 'HANDOFF_TO_HUMAN'
  | 'QUARANTINE'
  | 'DENY'
  | 'TERMINATE';

export interface PolicyDecision {
  decisionId: string;
  interactionId: string;
  /** what was being evaluated: the requested action, or a standing rule */
  subject: {
    type: 'AGENT_ACTION' | 'STANDING_RULE';
    requestedAction?: string;
    resource?: string;
    amount?: number;
    participantId?: string;
  };
  allowed: boolean;
  actions: EnforcementAction[];
  policyId: string;
  policyVersion: number;
  matchedRule: string;
  reasons: string[];
  latencyMs: number;
  decidedAt: string;
  /** SHADOW: decision recorded + would-be actions shown, nothing blocked. */
  execution: 'shadow' | 'enforce';
  /** Non-empty in shadow mode: the enforcement actions that WOULD have applied. */
  wouldEnforceActions?: EnforcementAction[];
}

// ---------- Agent Registry ----------

export type DataClass =
  | 'PUBLIC' | 'INTERNAL' | 'PII' | 'PCI' | 'PHI' | 'CREDENTIALS';

export interface AgentRegistration {
  agentId: string;
  name: string;
  organizationId: string;
  owner: string;
  environment: 'DEV' | 'STAGING' | 'PROD';
  modelProvider: string;
  model: string;
  purpose: string;
  approvedVoice?: string;
  approvedChannels: Channel[];
  approvedTools: string[];
  approvedDomains: string[];
  permittedDataClasses: DataClass[];
  permittedActions: string[];
  maxTransactionLimit: number;
  riskClassification: 'LOW' | 'MEDIUM' | 'HIGH';
  humanEscalationPolicy: string;
  jurisdiction: string;
  policyVersion: number;
  deploymentVersion: string;
  lastAttestationAt?: string;
  // Trust Passport (Phase 3 design seam)
  passport?: AgentPassport;
}

/** Design seam — cryptographically verifiable agent identity (Phase 3). */
export interface AgentPassport {
  certificateId: string;
  subjectAgentId: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  signatureAlg: string;
  /** detached signature over canonical registration JSON; verification ships in Phase 3 */
  signature?: string;
}

// ---------- Incidents / evidence ----------

export type IncidentStatus =
  | 'OPEN' | 'ACKNOWLEDGED' | 'CONTAINED' | 'RESOLVED' | 'FALSE_POSITIVE';

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Incident {
  incidentId: string;
  organizationId: string;
  interactionId: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  openedAt: string;
  summary: string;
  detections: string[];
  enforcementActions: EnforcementAction[];
  /** Was the triggering decision enforced, or shadowed (detected only)? */
  executed?: boolean;
  /** Investigation fields (additive): assigned owner identity. */
  owner?: string;
  /** Investigation fields: what the investigation concluded caused the event. */
  rootCause?: string;
  /** Investigation fields: recommended fix / control to add. */
  remediation?: string;
  /** Framework mapping entries (e.g. "OWASP-LLM01", "NIST-AI-RMF:MAP"). Never a certification claim. */
  frameworkMap?: string[];
}

/** Append-only, hash-chained evidence record (tamper-evident). */
export interface EvidenceRecord {
  sequence: number;
  recordId: string;
  interactionId: string;
  ts: string;
  kind:
    | 'EVENT' | 'DETECTION' | 'POLICY_DECISION' | 'RISK_UPDATE'
    | 'ENFORCEMENT' | 'INCIDENT' | 'AUTH_EVENT';
  refId: string;
  /** sha-256 hex of canonical serialization */
  payloadHash: string;
  /** sha-256 hex of previous record's chain hash ('' for genesis) */
  prevChainHash: string;
  chainHash: string;
}

export type TrustEvent = EventBase;
