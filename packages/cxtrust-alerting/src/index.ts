// CX Trust alerting — SOC/SIEM + team-channel alert dispatch.
// Zero-dep: node:crypto + fetch. Types come from @cxtrust/core.

import { createHmac } from 'node:crypto';

// ---------- Alert model ----------

export type AlertType =
  | 'INCIDENT_OPENED' | 'HIGH_RISK_INTERACTION' | 'POLICY_BLOCK' | 'EVIDENCE_TAMPER';

export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Alert {
  alertId: string;
  alertType: AlertType;
  severity: AlertSeverity;
  organizationId: string;
  title: string;
  summary: string;
  interactionId?: string;
  incidentId?: string;
  riskScore?: number;
  createdAt: string;
  /** Full machine-readable context for the downstream system. */
  payload: Record<string, unknown>;
}

export interface RouteResult {
  delivered: boolean;
  detail?: string;
}

export interface AlertRouter {
  id: string;
  route(alert: Alert): Promise<RouteResult>;
}

export const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3,
};

export function severityAtLeast(severity: AlertSeverity, threshold: AlertSeverity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

// ---------- HTTP plumbing shared by routers ----------

export interface HttpPostResult {
  ok: boolean;
  status: number;
  body: string;
}

/** POST JSON with a 5s AbortController timeout (configurable). */
export async function postJson(opts: {
  url: string;
  body: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<HttpPostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5_000);
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
  } finally {
    clearTimeout(timer);
  }
}

/** HMAC-SHA256 hex of the exact serialized body using CXTRUST_ALERT_SIGNING_SECRET. */
export function alertSignature(body: string): string | undefined {
  const secret = process.env.CXTRUST_ALERT_SIGNING_SECRET;
  if (!secret) return undefined;
  return createHmac('sha256', secret).update(body).digest('hex');
}

// ---------- Routers ----------

/** Generic JSON webhook. Env: CXTRUST_ALERT_WEBHOOK_URL (read at request time). */
export class WebhookRouter implements AlertRouter {
  id: string;

  constructor(id = 'webhook') {
    this.id = id;
  }

  async route(alert: Alert): Promise<RouteResult> {
    const url = process.env.CXTRUST_ALERT_WEBHOOK_URL;
    if (!url) return { delivered: false, detail: 'CXTRUST_ALERT_WEBHOOK_URL not set' };
    const body = JSON.stringify(alert);
    const sig = alertSignature(body);
    const headers: Record<string, string> = {};
    if (sig) headers['x-cxtrust-signature'] = sig;
    try {
      const r = await postJson({ url, body, headers });
      if (!r.ok) return { delivered: false, detail: `webhook HTTP ${r.status}` };
      return { delivered: true, detail: sig ? 'signed' : 'unsigned (no CXTRUST_ALERT_SIGNING_SECRET)' };
    } catch (err) {
      return { delivered: false, detail: `webhook error: ${(err as Error).message}` };
    }
  }
}

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  LOW: '#2eb67d', MEDIUM: '#ecb22e', HIGH: '#e01e5a', CRITICAL: '#9d0000',
};

function interactionLink(alert: Alert): string {
  const base = process.env.CXTRUST_CONSOLE_URL ?? 'https://console.example.com';
  if (!alert.interactionId) return '_no interaction_';
  return `<${base}/interactions/${alert.interactionId}|${alert.interactionId}>`;
}

/** Slack incoming-webhook, Block Kit payload. Env: CXTRUST_SLACK_WEBHOOK_URL. */
export class SlackRouter implements AlertRouter {
  id: string;

  constructor(id = 'slack') {
    this.id = id;
  }

  slackPayload(alert: Alert): Record<string, unknown> {
    return {
      text: `[${alert.severity}] ${alert.title}`,
      attachments: [{
        color: SEVERITY_COLORS[alert.severity],
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: `[${alert.severity}] ${alert.title}` } },
          { type: 'section', text: { type: 'mrkdwn', text: alert.summary } },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Type:* ${alert.alertType}` },
              { type: 'mrkdwn', text: `*Org:* ${alert.organizationId}` },
              { type: 'mrkdwn', text: `*Interaction:* ${interactionLink(alert)}` },
              { type: 'mrkdwn', text: `*Alert:* ${alert.alertId}` },
            ],
          },
        ],
      }],
    };
  }

  async route(alert: Alert): Promise<RouteResult> {
    const url = process.env.CXTRUST_SLACK_WEBHOOK_URL;
    if (!url) return { delivered: false, detail: 'CXTRUST_SLACK_WEBHOOK_URL not set' };
    try {
      const r = await postJson({ url, body: JSON.stringify(this.slackPayload(alert)) });
      if (!r.ok) return { delivered: false, detail: `slack HTTP ${r.status}` };
      return { delivered: true, detail: `slack HTTP ${r.status}` };
    } catch (err) {
      return { delivered: false, detail: `slack error: ${(err as Error).message}` };
    }
  }
}

/** MS Teams incoming-webhook MessageCard. Env: CXTRUST_TEAMS_WEBHOOK_URL. */
export class TeamsRouter implements AlertRouter {
  id: string;

  constructor(id = 'teams') {
    this.id = id;
  }

  teamsPayload(alert: Alert): Record<string, unknown> {
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `[${alert.severity}] ${alert.title}`,
      themeColor: SEVERITY_COLORS[alert.severity],
      title: `[${alert.severity}] ${alert.title}`,
      text: alert.summary,
      sections: [{
        facts: [
          { name: 'Alert type', value: alert.alertType },
          { name: 'Organization', value: alert.organizationId },
          { name: 'Interaction', value: alert.interactionId ?? 'n/a' },
          { name: 'Incident', value: alert.incidentId ?? 'n/a' },
          { name: 'Risk score', value: alert.riskScore !== undefined ? String(alert.riskScore) : 'n/a' },
          { name: 'Alert ID', value: alert.alertId },
        ],
        markdown: `Interaction: ${interactionLink(alert)}`,
      }],
      potentialAction: [{
        '@type': 'OpenUri',
        name: 'View interaction',
        targets: alert.interactionId
          ? [{ os: 'default', uri: `${process.env.CXTRUST_CONSOLE_URL ?? 'https://console.example.com'}/interactions/${alert.interactionId}` }]
          : [],
      }],
    };
  }

  async route(alert: Alert): Promise<RouteResult> {
    const url = process.env.CXTRUST_TEAMS_WEBHOOK_URL;
    if (!url) return { delivered: false, detail: 'CXTRUST_TEAMS_WEBHOOK_URL not set' };
    try {
      const r = await postJson({ url, body: JSON.stringify(this.teamsPayload(alert)) });
      if (!r.ok) return { delivered: false, detail: `teams HTTP ${r.status}` };
      return { delivered: true, detail: `teams HTTP ${r.status}` };
    } catch (err) {
      return { delivered: false, detail: `teams error: ${(err as Error).message}` };
    }
  }
}

/**
 * Generic SIEM/HEC router — posts one NDJSON line per alert for
 * Splunk HEC / QRadar-style endpoints.
 * Env: CXTRUST_SIEM_URL (required at request time), CXTRUST_SIEM_TOKEN (optional).
 */
export class SiemRouter implements AlertRouter {
  id: string;

  constructor(id = 'siem') {
    this.id = id;
  }

  /** One NDJSON line per alert (trailing newline included). */
  ndjsonLine(alert: Alert): string {
    return JSON.stringify({ ...alert, body: JSON.stringify(alert) }) + '\n';
  }

  async route(alert: Alert): Promise<RouteResult> {
    const url = process.env.CXTRUST_SIEM_URL;
    if (!url) return { delivered: false, detail: 'CXTRUST_SIEM_URL not set' };
    const headers: Record<string, string> = {};
    const token = process.env.CXTRUST_SIEM_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const r = await postJson({ url, body: this.ndjsonLine(alert), headers });
      if (!r.ok) return { delivered: false, detail: `siem HTTP ${r.status}` };
      return { delivered: true, detail: token ? 'siem accepted (token auth)' : 'siem accepted (no token)' };
    } catch (err) {
      return { delivered: false, detail: `siem error: ${(err as Error).message}` };
    }
  }
}

// ---------- Routing rules ----------

export type ChannelType = 'webhook' | 'slack' | 'teams' | 'siem';

export interface AlertRulesConfig {
  /** Minimum severity per channel; channels without a threshold get everything. */
  severityThresholds: Partial<Record<ChannelType, AlertSeverity>>;
  /** When set (non-empty), only these orgs receive alerts. */
  organizations?: string[];
}

export const DEFAULT_RULES: AlertRulesConfig = {
  severityThresholds: { webhook: 'LOW', slack: 'HIGH', teams: 'CRITICAL', siem: 'MEDIUM' },
};

export function channelOf(routerId: string): ChannelType {
  const rid = routerId.toLowerCase();
  if (rid.includes('slack')) return 'slack';
  if (rid.includes('teams')) return 'teams';
  if (rid.includes('siem')) return 'siem';
  return 'webhook';
}

export function rulesAllow(rules: AlertRulesConfig, routerId: string, alert: Alert): { allowed: boolean; reason: string } {
  const channel = channelOf(routerId);
  if (rules.organizations && rules.organizations.length > 0 && !rules.organizations.includes(alert.organizationId)) {
    return { allowed: false, reason: `organization ${alert.organizationId} not on alert list` };
  }
  const threshold = rules.severityThresholds[channel];
  if (threshold && !severityAtLeast(alert.severity, threshold)) {
    return { allowed: false, reason: `severity ${alert.severity} below ${channel} threshold ${threshold}` };
  }
  return { allowed: true, reason: 'ok' };
}

// ---------- Manager ----------

export interface RoutedAttempt {
  routerId: string;
  delivered: boolean;
  detail?: string;
}

export interface AlertDispatchRecord {
  alertId: string;
  alertType: AlertType;
  routedTo: RoutedAttempt[];
  dispatchedAt: string;
}

/** In-memory queue + fire-and-record dispatcher. */
export class AlertManager {
  readonly routers: AlertRouter[];
  readonly rules: AlertRulesConfig;
  private queue: Alert[] = [];
  private records: AlertDispatchRecord[] = [];
  private inFlight = new Set<string>();

  constructor(routers: AlertRouter[], rules: AlertRulesConfig = DEFAULT_RULES) {
    this.routers = routers;
    this.rules = rules;
  }

  /** Queue an alert; flush() dispatches. Errors become failed attempts, never thrown. */
  enqueue(alert: Alert): void {
    this.queue.push(alert);
  }

  /** Fire every queued alert through every router the rules allow. */
  async flush(): Promise<AlertDispatchRecord[]> {
    const batch = this.queue;
    this.queue = [];
    const out: AlertDispatchRecord[] = [];
    for (const alert of batch) {
      if (this.inFlight.has(alert.alertId)) continue;
      this.inFlight.add(alert.alertId);
      try {
        const routedTo: RoutedAttempt[] = [];
        for (const router of this.routers) {
          const check = rulesAllow(this.rules, router.id, alert);
          if (!check.allowed) {
            routedTo.push({ routerId: router.id, delivered: false, detail: 'filtered by rules' });
            continue;
          }
          try {
            const r = await router.route(alert);
            routedTo.push({ routerId: router.id, delivered: r.delivered, detail: r.detail });
          } catch (err) {
            routedTo.push({ routerId: router.id, delivered: false, detail: `router threw: ${(err as Error).message}` });
          }
        }
        const rec: AlertDispatchRecord = {
          alertId: alert.alertId,
          alertType: alert.alertType,
          routedTo,
          dispatchedAt: new Date().toISOString(),
        };
        this.records.push(rec);
        out.push(rec);
      } finally {
        this.inFlight.delete(alert.alertId);
      }
    }
    return out;
  }

  health(): { queued: number; dispatched: number; routers: string[] } {
    return {
      queued: this.queue.length,
      dispatched: this.records.length,
      routers: this.routers.map(r => r.id),
    };
  }

  dispatchRecords(): AlertDispatchRecord[] {
    return this.records;
  }
}

// ---------- Governance adapters ----------

let alertSeq = 0;

export function newAlertId(): string {
  alertSeq += 1;
  return `ALT-${Date.now().toString(36)}-${alertSeq.toString(36)}`;
}

type IncidentLike = {
  incidentId: string;
  organizationId: string;
  interactionId: string;
  title: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: string;
  openedAt: string;
  summary: string;
  detections?: string[];
  enforcementActions?: string[];
};

/** Map a governance Incident (or stored incident row) to an Alert. */
export function alertFromIncident(incident: IncidentLike): Alert {
  return {
    alertId: newAlertId(),
    alertType: 'INCIDENT_OPENED',
    severity: incident.severity,
    organizationId: incident.organizationId,
    interactionId: incident.interactionId,
    incidentId: incident.incidentId,
    title: incident.title,
    summary: incident.summary,
    createdAt: incident.openedAt,
    payload: {
      incidentId: incident.incidentId,
      interactionId: incident.interactionId,
      organizationId: incident.organizationId,
      status: incident.status,
      detections: incident.detections ?? [],
      enforcementActions: incident.enforcementActions ?? [],
    },
  };
}

type DecisionLike = {
  decisionId: string;
  interactionId: string;
  matchedRule: string;
  allowed: boolean;
  reasons?: string[];
  actions?: string[];
  policyId?: string;
  decidedAt?: string;
};

/** Map a PolicyDecision to a POLICY_BLOCK Alert, severity derived from risk score. */
export function alertFromDecision(decision: DecisionLike, riskScore: number, organizationId = 'org-unknown'): Alert {
  const severity: AlertSeverity = riskScore >= 80 ? 'CRITICAL' : riskScore >= 60 ? 'HIGH' : riskScore >= 40 ? 'MEDIUM' : 'LOW';
  return {
    alertId: newAlertId(),
    alertType: 'POLICY_BLOCK',
    severity,
    organizationId,
    interactionId: decision.interactionId,
    title: `Policy ${decision.allowed ? 'allowed' : 'blocked'}: ${decision.matchedRule}`,
    summary: `Decision ${decision.decisionId} on interaction ${decision.interactionId}: rule ${decision.matchedRule} → ${(decision.actions ?? []).join(', ') || 'no actions'}. Reasons: ${(decision.reasons ?? []).join('; ') || 'none'}.`,
    riskScore,
    createdAt: decision.decidedAt ?? new Date().toISOString(),
    payload: {
      decisionId: decision.decisionId,
      interactionId: decision.interactionId,
      organizationId,
      policyId: decision.policyId,
      matchedRule: decision.matchedRule,
      allowed: decision.allowed,
      actions: decision.actions ?? [],
      reasons: decision.reasons ?? [],
    },
  };
}
