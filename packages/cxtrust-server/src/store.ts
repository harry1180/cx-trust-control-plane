// Durable governance store — node:sqlite with a swappable interface so
// Postgres can replace it without touching the session or API layers.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MeetingStore } from './meetings_store.ts';

export interface StoredInteraction {
  interactionId: string;
  organizationId: string;
  platform: string;
  channel: string;
  startedAt: string;
  endedAt?: string;
  scenarioLabel?: string;
  /** Connector-suppressed context that must survive the live session
   *  (Connect: initiationMethod/direction, queue, phone…). */
  metadata?: Record<string, unknown>;
  /** Voice biomarker report (measurements + emotion estimate) for this
   *  interaction — acoustic signals for review, never a diagnosis. */
  biomarkers?: Record<string, unknown>;
  peakRisk: number;
  finalRisk: number;
}

export interface Store {
  upsertInteraction(i: StoredInteraction): void;
  listInteractions(opts?: { limit?: number; organizationId?: string; platform?: string }): StoredInteraction[];
  getInteraction(id: string): StoredInteraction | undefined;
  appendEvidence(interactionId: string, record: {
    sequence: number; recordId: string; kind: string; refId: string;
    payloadHash: string; prevChainHash: string; chainHash: string; ts: string;
  }): void;
  listEvidence(interactionId: string): {
    sequence: number; recordId: string; kind: string; refId: string;
    payloadHash: string; prevChainHash: string; chainHash: string; ts: string;
  }[];
  saveIncident(i: {
    incidentId: string; organizationId: string; interactionId: string;
    title: string; severity: string; status: string; openedAt: string; summary: string;
  }): void;
  listIncidents(opts?: { status?: string; limit?: number }): {
    incidentId: string; organizationId: string; interactionId: string;
    title: string; severity: string; status: string; openedAt: string; summary: string;
  }[];
  saveTimeline(interactionId: string, timelineJson: string): void;
  getTimeline(interactionId: string): string | undefined;
  saveSpans(interactionId: string, spansJson: string): void;
  getSpans(interactionId: string): string | undefined;
  savePolicyDecision(d: {
    decisionId: string; interactionId: string; policyId: string; policyVersion: number;
    matchedRule: string; allowed: number; actionsJson: string; reasonsJson: string;
    latencyMs: number; decidedAt: string; subjectJson: string;
    execution?: 'shadow' | 'enforce'; wouldEnforceActionsJson?: string;
  }): void;
  listPolicyDecisions(interactionId: string): Record<string, unknown>[];
  usageCounts(organizationId: string): {
    governed: number; incidents: number; blockedDecisions: number; highRisk: number;
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS interactions (
  interactionId TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  scenarioLabel TEXT,
  peakRisk REAL NOT NULL DEFAULT 0,
  finalRisk REAL NOT NULL DEFAULT 0,
  metadataJson TEXT,
  biomarkersJson TEXT
);
CREATE INDEX IF NOT EXISTS ix_int_org ON interactions(organizationId, startedAt DESC);

CREATE TABLE IF NOT EXISTS evidence (
  interactionId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  recordId TEXT NOT NULL,
  kind TEXT NOT NULL,
  refId TEXT NOT NULL,
  payloadHash TEXT NOT NULL,
  prevChainHash TEXT NOT NULL,
  chainHash TEXT NOT NULL,
  ts TEXT NOT NULL,
  PRIMARY KEY (interactionId, sequence)
);

CREATE TABLE IF NOT EXISTS incidents (
  incidentId TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  interactionId TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  openedAt TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline (
  interactionId TEXT PRIMARY KEY,
  timelineJson TEXT NOT NULL,
  savedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spans (
  interactionId TEXT PRIMARY KEY,
  spansJson TEXT NOT NULL,
  savedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  decisionId TEXT PRIMARY KEY,
  interactionId TEXT NOT NULL,
  policyId TEXT NOT NULL,
  policyVersion INTEGER NOT NULL,
  matchedRule TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  actionsJson TEXT NOT NULL,
  reasonsJson TEXT NOT NULL,
  latencyMs REAL NOT NULL,
  decidedAt TEXT NOT NULL,
  subjectJson TEXT NOT NULL
);
`;

/** Map a raw interactions row (metadataJson/biomarkersJson columns) to StoredInteraction. */
function rowToStoredInteraction(row: Record<string, unknown>): StoredInteraction {
  const r = { ...row } as unknown as StoredInteraction & { metadataJson?: unknown; biomarkersJson?: unknown };
  const rawMeta = r.metadataJson;
  delete r.metadataJson;
  if (typeof rawMeta === 'string' && rawMeta) {
    try { r.metadata = JSON.parse(rawMeta) as Record<string, unknown>; } catch { /* corrupt — omit */ }
  }
  const rawBm = r.biomarkersJson;
  delete r.biomarkersJson;
  if (typeof rawBm === 'string' && rawBm) {
    try { r.biomarkers = JSON.parse(rawBm) as Record<string, unknown>; } catch { /* corrupt — omit */ }
  }
  return r;
}

export class SqliteStore implements Store {
  // Meeting intelligence store (separate concern from the governance Store).
  meetings: import('./meetings_store.ts').MeetingStore | undefined;
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.meetings = new MeetingStore(this.db);
    // Additive migration: shadow/enforce execution mode on stored decisions.
    try { this.db.exec("ALTER TABLE policy_decisions ADD COLUMN execution TEXT DEFAULT 'enforce'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE policy_decisions ADD COLUMN wouldEnforceActionsJson TEXT"); } catch { /* column exists */ }
    // Additive migration: connector metadata (Connect call direction, queue…).
    try { this.db.exec("ALTER TABLE interactions ADD COLUMN metadataJson TEXT"); } catch { /* column exists */ }
    // Additive migration: voice biomarker reports.
    try { this.db.exec("ALTER TABLE interactions ADD COLUMN biomarkersJson TEXT"); } catch { /* column exists */ }
  }

  upsertInteraction(i: StoredInteraction) {
    this.db.prepare(`
      INSERT INTO interactions (interactionId, organizationId, platform, channel, startedAt, endedAt, scenarioLabel, peakRisk, finalRisk, metadataJson, biomarkersJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(interactionId) DO UPDATE SET
        endedAt = excluded.endedAt, peakRisk = excluded.peakRisk,
        finalRisk = excluded.finalRisk, scenarioLabel = excluded.scenarioLabel,
        metadataJson = COALESCE(excluded.metadataJson, interactions.metadataJson),
        biomarkersJson = COALESCE(excluded.biomarkersJson, interactions.biomarkersJson)
    `).run(i.interactionId, i.organizationId, i.platform, i.channel,
      i.startedAt, i.endedAt ?? null, i.scenarioLabel ?? null, i.peakRisk, i.finalRisk,
      i.metadata !== undefined ? JSON.stringify(i.metadata) : null,
      i.biomarkers !== undefined ? JSON.stringify(i.biomarkers) : null);
  }

  listInteractions(opts?: { limit?: number; organizationId?: string; platform?: string }): StoredInteraction[] {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const filters: string[] = [];
    const args: (string | number)[] = [];
    if (opts?.organizationId) { filters.push('organizationId = ?'); args.push(opts.organizationId); }
    if (opts?.platform) { filters.push('platform = ?'); args.push(opts.platform); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM interactions ${where} ORDER BY startedAt DESC LIMIT ?`).all(...args, limit);
    return (rows as unknown as Record<string, unknown>[]).map(rowToStoredInteraction);
  }

  getInteraction(id: string): StoredInteraction | undefined {
    const row = this.db.prepare('SELECT * FROM interactions WHERE interactionId = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToStoredInteraction(row) : undefined;
  }

  appendEvidence(interactionId: string, r: {
    sequence: number; recordId: string; kind: string; refId: string;
    payloadHash: string; prevChainHash: string; chainHash: string; ts: string;
  }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO evidence (interactionId, sequence, recordId, kind, refId, payloadHash, prevChainHash, chainHash, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(interactionId, r.sequence, r.recordId, r.kind, r.refId,
      r.payloadHash, r.prevChainHash, r.chainHash, r.ts);
  }

  listEvidence(interactionId: string) {
    return this.db.prepare(
      'SELECT sequence, recordId, kind, refId, payloadHash, prevChainHash, chainHash, ts FROM evidence WHERE interactionId = ? ORDER BY sequence',
    ).all(interactionId) as unknown as ReturnType<Store['listEvidence']>;
  }

  saveIncident(i: Parameters<Store['saveIncident']>[0]) {
    this.db.prepare(`
      INSERT OR REPLACE INTO incidents (incidentId, organizationId, interactionId, title, severity, status, openedAt, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(i.incidentId, i.organizationId, i.interactionId, i.title, i.severity, i.status, i.openedAt, i.summary);
  }

  listIncidents(opts?: { status?: string; limit?: number }) {
    const limit = Math.min(opts?.limit ?? 100, 500);
    return (opts?.status
      ? this.db.prepare('SELECT * FROM incidents WHERE status = ? ORDER BY openedAt DESC LIMIT ?').all(opts.status, limit)
      : this.db.prepare('SELECT * FROM incidents ORDER BY openedAt DESC LIMIT ?').all(limit)) as unknown as ReturnType<Store['listIncidents']>;
  }

  saveTimeline(interactionId: string, timelineJson: string) {
    this.db.prepare('INSERT OR REPLACE INTO timeline VALUES (?, ?, ?)')
      .run(interactionId, timelineJson, new Date().toISOString());
  }

  getTimeline(interactionId: string) {
    const r = this.db.prepare('SELECT timelineJson FROM timeline WHERE interactionId = ?').get(interactionId) as { timelineJson: string } | undefined;
    return r?.timelineJson;
  }

  saveSpans(interactionId: string, spansJson: string) {
    this.db.prepare('INSERT OR REPLACE INTO spans VALUES (?, ?, ?)')
      .run(interactionId, spansJson, new Date().toISOString());
  }

  getSpans(interactionId: string) {
    const r = this.db.prepare('SELECT spansJson FROM spans WHERE interactionId = ?').get(interactionId) as { spansJson: string } | undefined;
    return r?.spansJson;
  }

  savePolicyDecision(d: Parameters<Store['savePolicyDecision']>[0]) {
    this.db.prepare(`
      INSERT OR REPLACE INTO policy_decisions
      (decisionId, interactionId, policyId, policyVersion, matchedRule, allowed, actionsJson, reasonsJson, latencyMs, decidedAt, subjectJson, execution, wouldEnforceActionsJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(d.decisionId, d.interactionId, d.policyId, d.policyVersion, d.matchedRule,
      d.allowed, d.actionsJson, d.reasonsJson, d.latencyMs, d.decidedAt, d.subjectJson,
      d.execution ?? 'enforce', d.wouldEnforceActionsJson ?? null);
  }

  listPolicyDecisions(interactionId: string): Record<string, unknown>[] {
    const rows = this.db.prepare('SELECT * FROM policy_decisions WHERE interactionId = ? ORDER BY decidedAt').all(interactionId) as Record<string, unknown>[];
    for (const r of rows) {
      r.actions = JSON.parse(String(r.actionsJson));
      r.reasons = JSON.parse(String(r.reasonsJson));
      r.subject = JSON.parse(String(r.subjectJson));
      r.allowed = !!r.allowed;
      // shadow-mode fields (SELECT * returns them when the migration ran)
      if (r.wouldEnforceActionsJson) {
        try { r.wouldEnforceActions = JSON.parse(String(r.wouldEnforceActionsJson)); } catch { /* keep raw */ }
      }
      if (r.execution == null) r.execution = 'enforce';
    }
    return rows;
  }

  usageCounts(organizationId: string) {
    const governed = (this.db.prepare('SELECT COUNT(*) AS n FROM interactions WHERE organizationId = ?').get(organizationId) as { n: number }).n;
    const incidents = (this.db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE organizationId = ?').get(organizationId) as { n: number }).n;
    const blocked = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM policy_decisions pd JOIN interactions i ON i.interactionId = pd.interactionId
      WHERE i.organizationId = ? AND pd.allowed = 0
    `).get(organizationId) as { n: number }).n;
    const high = (this.db.prepare('SELECT COUNT(*) AS n FROM interactions WHERE organizationId = ? AND peakRisk >= 40').get(organizationId) as { n: number }).n;
    return { governed: Number(governed), incidents: Number(incidents), blockedDecisions: Number(blocked), highRisk: Number(high) };
  }
}
