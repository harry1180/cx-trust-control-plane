// Official TypeScript SDK — wraps the CX Trust REST API.
// Python SDK follows the same surface (see sdk/python/cxtrust/).

export interface CxTrustClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface Decision {
  decisionId: string;
  allowed: boolean;
  actions: string[];
  matchedRule: string;
  reasons: string[];
  latencyMs: number;
}

export class CxTrustClient {
  private f: typeof fetch;
  private base: string;
  private key?: string;

  constructor(opts: CxTrustClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.key = opts.apiKey;
    this.f = opts.fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.key ? { 'x-api-key': this.key } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`cxtrust ${method} ${path} → ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  startSession(init: {
    interactionId?: string; organizationId?: string; platform?: string;
    channel?: 'voice' | 'chat' | 'email' | 'video' | 'api'; metadata?: Record<string, unknown>;
  }) {
    return this.req('POST', '/v1/interactions', init);
  }

  registerParticipant(interactionId: string, participant: Record<string, unknown>) {
    return this.req('POST', `/v1/interactions/${interactionId}/participant`, participant);
  }

  /** Feed a transcript turn. */
  streamTranscript(interactionId: string, turn: { participantId: string; text: string; offsetS: number; partial?: boolean }) {
    return this.req('POST', `/v1/interactions/${interactionId}/turns`, turn);
  }

  /** Submit voice-provider analysis for a participant. */
  streamVoiceAnalysis(interactionId: string, analysis: {
    participantId: string; syntheticProbability: number;
    replayProbability: number; impersonationProbability: number;
  }) {
    return this.req('POST', `/v1/interactions/${interactionId}/voice`, analysis);
  }

  /** Report a step-up authentication outcome. */
  authentication(interactionId: string, result: { participantId: string; result: 'SUCCESS' | 'FAILURE'; level: 'MEDIUM' | 'HIGH' }) {
    return this.req('POST', `/v1/interactions/${interactionId}/auth`, result);
  }

  /** Evaluate a proposed action — the governance gate before executing anything. */
  evaluateAction(interactionId: string, action: {
    requestedAction: string; participantId: string;
    amount?: number; resource?: string; intent?: string; tool?: string;
  }): Promise<{ decision: Decision; snapshot: unknown }> {
    return this.req('POST', `/v1/interactions/${interactionId}/actions`, action);
  }

  endSession(interactionId: string) {
    return this.req('POST', `/v1/interactions/${interactionId}/end`);
  }

  getInteraction(interactionId: string) {
    return this.req('GET', `/v1/interactions/${interactionId}`);
  }

  getTimeline(interactionId: string) {
    return this.req('GET', `/v1/interactions/${interactionId}/timeline`);
  }

  getEvidence(interactionId: string): Promise<{ evidence: unknown[]; chainValid: boolean }> {
    return this.req('GET', `/v1/interactions/${interactionId}/evidence`);
  }

  getDecisions(interactionId: string) {
    return this.req('GET', `/v1/interactions/${interactionId}/decisions`);
  }

  listIncidents() {
    return this.req('GET', '/v1/incidents');
  }

  listAgents() {
    return this.req('GET', '/v1/agents');
  }

  usage(organizationId: string) {
    return this.req('GET', `/v1/usage/${organizationId}`);
  }
}

/** Developer-facing guard pattern:
 *
 *  const d = await trust.evaluateAction(id, { requestedAction: 'ISSUE_REFUND', participantId, amount: 25000 });
 *  if (d.decision.allowed) await execute();
 *  else await enforce(d.decision); // REQUIRE_APPROVAL → queue; DENY → refuse
 */
