// Postgres-backed durable governance store.
//
// DESIGN DECISION (documented tradeoff):
// The Store interface is SYNC (API handlers return json synchronously and read
// the store directly). `pg` is an async-only driver, so a strictly async
// implementation cannot satisfy the sync interface. Rather than a worker
// thread or a fire-and-forget write-behind shim with lossy semantics, PgStore
// implements Store synchronously using an in-process MIRROR CACHE:
//
//   * Writes are applied to the mirror Map immediately (so the sync contract
//     holds and reads-your-writes is guaranteed) and queued to an in-memory
//     OUTBOX that a background pump flushes to Postgres (at-least-once,
//     eventual consistency < 1s under normal load).
//   * At startup the pump connects, creates the schema (same tables/columns,
//     TEXT/INTEGER/BIGINT/DOUBLE PRECISION/JSONB as appropriate, evidence PK
//     (interactionId, sequence), indexes interactions(organizationId,
//     startedAt DESC) and incidents(openedAt)), then hydrates the mirror from
//     Postgres (capped at 10k rows per table).
//   * On flush failure the outbox is retained and retried with backoff.
//
// TRADEOFF: the mirror is single-process. Multiple server processes against
// the same database will not see each other's writes until restart. A true
// multi-process deployment requires the async Store refactor planned for
// Phase 3 (PgStoreAsync-style, async handlers). This class gives the demo
// path sync semantics + durable Postgres persistence.

import type { Store, StoredInteraction } from './store.ts';

const MIRROR_CAP = 10_000;

type EvidenceRecord = {
  sequence: number; recordId: string; kind: string; refId: string;
  payloadHash: string; prevChainHash: string; chainHash: string; ts: string;
};

type IncidentRecord = {
  incidentId: string; organizationId: string; interactionId: string;
  title: string; severity: string; status: string; openedAt: string; summary: string;
};

type PolicyDecisionRecord = {
  decisionId: string; interactionId: string; policyId: string; policyVersion: number;
  matchedRule: string; allowed: number; actionsJson: string; reasonsJson: string;
  latencyMs: number; decidedAt: string; subjectJson: string;
  execution?: 'shadow' | 'enforce'; wouldEnforceActionsJson?: string;
};

type OutboxOp =
  | { kind: 'interaction'; i: StoredInteraction }
  | { kind: 'evidence'; interactionId: string; r: EvidenceRecord }
  | { kind: 'incident'; i: IncidentRecord }
  | { kind: 'timeline'; interactionId: string; timelineJson: string; savedAt: string }
  | { kind: 'spans'; interactionId: string; spansJson: string; savedAt: string }
  | { kind: 'decision'; d: PolicyDecisionRecord };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS interactions (
  interactionId TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  platform TEXT NOT NULL,
  channel TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  scenarioLabel TEXT,
  peakRisk DOUBLE PRECISION NOT NULL DEFAULT 0,
  finalRisk DOUBLE PRECISION NOT NULL DEFAULT 0,
  metadataJson JSONB,
  biomarkersJson JSONB
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
CREATE INDEX IF NOT EXISTS ix_inc_opened ON incidents(openedAt);

CREATE TABLE IF NOT EXISTS timeline (
  interactionId TEXT PRIMARY KEY,
  timelineJson JSONB NOT NULL,
  savedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spans (
  interactionId TEXT PRIMARY KEY,
  spansJson JSONB NOT NULL,
  savedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_decisions (
  decisionId TEXT PRIMARY KEY,
  interactionId TEXT NOT NULL,
  policyId TEXT NOT NULL,
  policyVersion INTEGER NOT NULL,
  matchedRule TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  actionsJson JSONB NOT NULL,
  reasonsJson JSONB NOT NULL,
  latencyMs DOUBLE PRECISION NOT NULL,
  decidedAt TEXT NOT NULL,
  subjectJson JSONB NOT NULL,
  execution TEXT DEFAULT 'enforce',
  wouldEnforceActionsJson TEXT
);

-- Additive migration for existing deployments (no-op when already present).
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS metadataJson JSONB;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS biomarkersJson JSONB;
`;

export class PgStore implements Store {
  // Mirror caches — the source of truth for synchronous reads.
  private interactions = new Map<string, StoredInteraction>();
  private evidence = new Map<string, Map<number, EvidenceRecord>>();
  private incidents = new Map<string, IncidentRecord>();
  private timelines = new Map<string, { timelineJson: string; savedAt: string }>();
  private decisions = new Map<string, PolicyDecisionRecord>();
  // Durable write-behind queue, flushed to Postgres by the pump.
  private outbox: OutboxOp[] = [];
  private flushing = false;
  private disposed = false;
  private ready: Promise<void>;
  private lastClient: import('pg').Client | undefined;
  private connected = false;

  constructor(url: string, pgModule: typeof import('pg')) {
    const client = new pgModule.Client({ connectionString: url });
    this.lastClient = client;
    this.ready = this.init(client);
    // The flush loop runs for the life of the process; it must not block
    // whenReady(), which resolves once the schema exists and the mirror is
    // hydrated.
    this.ready
      .then(() => this.flushLoop(client))
      .catch(() => { /* init retries exhaustively; errors already logged */ });
  }

  /** Resolves once the schema exists and the mirror has been hydrated. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async init(client: import('pg').Client): Promise<void> {
    let delay = 250;
    while (!this.disposed) {
      try {
        await client.connect();
        this.connected = true;
        await client.query(SCHEMA);
        await this.hydrate(client);
        return;
      } catch (err) {
        if (!this.disposed) {
          console.error('[PgStore] initial connect/hydrate failed, retrying:', (err as Error).message);
          await sleep(delay);
          delay = Math.min(delay * 2, 10_000);
        }
      }
    }
  }

  private async flushLoop(client: import('pg').Client): Promise<void> {
    while (!this.disposed) {
      if (this.outbox.length === 0) {
        await sleep(100);
        continue;
      }
      await this.flushOnce(client);
    }
    try { await client.end(); } catch { /* ignore */ }
  }

  private async hydrate(client: import('pg').Client): Promise<void> {
    const ints = await client.query(
      `SELECT * FROM interactions ORDER BY startedAt DESC LIMIT ${MIRROR_CAP}`);
    for (const row of ints.rows) this.interactions.set(row.interactionid ?? row.interactionId, pgRowToInteraction(row));
    const ev = await client.query(
      `SELECT * FROM evidence ORDER BY interactionId, sequence LIMIT ${MIRROR_CAP}`);
    for (const row of ev.rows) {
      const r = pgRowToEvidence(row);
      let m = this.evidence.get(keyOfEvidence(row));
      if (!m) { m = new Map(); this.evidence.set(keyOfEvidence(row), m); }
      m.set(r.sequence, r);
    }
    const inc = await client.query(
      `SELECT * FROM incidents ORDER BY openedAt DESC LIMIT ${MIRROR_CAP}`);
    for (const row of inc.rows) {
      const r = pgRowToIncident(row);
      this.incidents.set(r.incidentId, r);
    }
    const tl = await client.query(
      `SELECT * FROM timeline LIMIT ${MIRROR_CAP}`);
    for (const row of tl.rows) {
      const interactionId = row.interactionid ?? row.interactionId;
      this.timelines.set(interactionId, { timelineJson: row.timelinejson ?? row.timelineJson, savedAt: row.savedat ?? row.savedAt });
    }
    const dec = await client.query(
      `SELECT * FROM policy_decisions ORDER BY decidedAt LIMIT ${MIRROR_CAP}`);
    for (const row of dec.rows) {
      const r = pgRowToDecision(row);
      this.decisions.set(r.decisionId, r);
    }
  }

  private async flushOnce(client: import('pg').Client): Promise<void> {
    if (this.flushing) { await sleep(50); return; }
    this.flushing = true;
    const batch = this.outbox;
    this.outbox = [];
    try {
      await client.query('BEGIN');
      for (const op of batch) {
        switch (op.kind) {
          case 'interaction':
            await client.query(
              `INSERT INTO interactions (interactionId, organizationId, platform, channel, startedAt, endedAt, scenarioLabel, peakRisk, finalRisk, metadataJson, biomarkersJson)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               ON CONFLICT (interactionId) DO UPDATE SET
                 endedAt = EXCLUDED.endedAt, peakRisk = EXCLUDED.peakRisk,
                 finalRisk = EXCLUDED.finalRisk, scenarioLabel = EXCLUDED.scenarioLabel,
                 metadataJson = COALESCE(EXCLUDED.metadataJson, interactions.metadataJson),
                 biomarkersJson = COALESCE(EXCLUDED.biomarkersJson, interactions.biomarkersJson)`,
              [op.i.interactionId, op.i.organizationId, op.i.platform, op.i.channel,
                op.i.startedAt, op.i.endedAt ?? null, op.i.scenarioLabel ?? null, op.i.peakRisk, op.i.finalRisk,
                op.i.metadata ?? null, op.i.biomarkers ?? null]);
            break;
          case 'evidence':
            await client.query(
              `INSERT INTO evidence (interactionId, sequence, recordId, kind, refId, payloadHash, prevChainHash, chainHash, ts)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (interactionId, sequence) DO NOTHING`,
              [op.interactionId, op.r.sequence, op.r.recordId, op.r.kind, op.r.refId,
                op.r.payloadHash, op.r.prevChainHash, op.r.chainHash, op.r.ts]);
            break;
          case 'incident':
            await client.query(
              `INSERT INTO incidents (incidentId, organizationId, interactionId, title, severity, status, openedAt, summary)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (incidentId) DO UPDATE SET
                 title = EXCLUDED.title, severity = EXCLUDED.severity,
                 status = EXCLUDED.status, summary = EXCLUDED.summary`,
              [op.i.incidentId, op.i.organizationId, op.i.interactionId, op.i.title,
                op.i.severity, op.i.status, op.i.openedAt, op.i.summary]);
            break;
          case 'timeline':
            await client.query(
              `INSERT INTO timeline (interactionId, timelineJson, savedAt)
               VALUES ($1,$2,$3)
               ON CONFLICT (interactionId) DO UPDATE SET timelineJson = EXCLUDED.timelineJson, savedAt = EXCLUDED.savedAt`,
              [op.interactionId, op.timelineJson, op.savedAt]);
            break;
          case 'spans':
            await client.query(
              `INSERT INTO spans (interactionId, spansJson, savedAt)
               VALUES ($1,$2,$3)
               ON CONFLICT (interactionId) DO UPDATE SET spansJson = EXCLUDED.spansJson, savedAt = EXCLUDED.savedAt`,
              [op.interactionId, op.spansJson, op.savedAt]);
            break;
          case 'decision': {
            const base = [op.d.decisionId, op.d.interactionId, op.d.policyId, op.d.policyVersion, op.d.matchedRule,
              op.d.allowed, op.d.actionsJson, op.d.reasonsJson, op.d.latencyMs, op.d.decidedAt, op.d.subjectJson];
            const extraCols = op.d.execution !== undefined ? ', execution, wouldEnforceActionsJson' : '';
            const extraVals = op.d.execution !== undefined ? ', $12, $13' : '';
            const values = op.d.execution !== undefined
              ? [...base, op.d.execution, op.d.wouldEnforceActionsJson ?? null]
              : base;
            await client.query(
              `INSERT INTO policy_decisions (decisionId, interactionId, policyId, policyVersion, matchedRule, allowed, actionsJson, reasonsJson, latencyMs, decidedAt, subjectJson${extraCols})
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${extraVals})
               ON CONFLICT (decisionId) DO UPDATE SET
                 allowed = EXCLUDED.allowed, actionsJson = EXCLUDED.actionsJson,
                 reasonsJson = EXCLUDED.reasonsJson, subjectJson = EXCLUDED.subjectJson`,
              values);
            break;
          }
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      // At-least-once: put the failed batch back at the front and retry later.
      this.outbox = [...batch, ...this.outbox];
      console.error('[PgStore] flush failed, will retry:', (err as Error).message);
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      await sleep(1_000);
    } finally {
      this.flushing = false;
    }
  }

  /** Stops the flush loop and synchronously flushes any remaining outbox ops. */
  async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.ready; } catch { /* ignore */ }
    // Final flush so no queued writes are lost on shutdown.
    if (this.connected && this.outbox.length > 0) {
      try { await this.flushOnce(this.lastClient!); } catch { /* best effort */ }
    }
    try { await this.lastClient?.end(); } catch { /* ignore */ }
  }

  upsertInteraction(i: StoredInteraction): void {
    // Mirror merge: a later upsert without metadata/biomarkers must not wipe
    // what was captured earlier (mirrors the SQL COALESCE).
    const prev = this.interactions.get(i.interactionId);
    const merged: StoredInteraction = {
      ...i,
      metadata: i.metadata ?? prev?.metadata,
      biomarkers: i.biomarkers ?? prev?.biomarkers,
    };
    this.interactions.set(i.interactionId, merged);
    this.outbox.push({ kind: 'interaction', i: { ...merged } });
  }

  listInteractions(opts?: { limit?: number; organizationId?: string; platform?: string }): StoredInteraction[] {
    const limit = Math.min(opts?.limit ?? 100, 500);
    let rows = [...this.interactions.values()];
    if (opts?.organizationId) rows = rows.filter((r) => r.organizationId === opts.organizationId);
    if (opts?.platform) rows = rows.filter((r) => r.platform === opts.platform);
    rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return rows.slice(0, limit).map((r) => ({ ...r }));
  }

  getInteraction(id: string): StoredInteraction | undefined {
    const r = this.interactions.get(id);
    return r ? { ...r } : undefined;
  }

  appendEvidence(interactionId: string, r: EvidenceRecord): void {
    let m = this.evidence.get(interactionId);
    if (!m) { m = new Map(); this.evidence.set(interactionId, m); }
    if (m.has(r.sequence)) return; // dedupe by (interactionId, sequence) PK
    m.set(r.sequence, { ...r });
    this.outbox.push({ kind: 'evidence', interactionId, r: { ...r } });
  }

  listEvidence(interactionId: string): EvidenceRecord[] {
    const m = this.evidence.get(interactionId);
    if (!m) return [];
    return [...m.values()].sort((a, b) => a.sequence - b.sequence).map((r) => ({ ...r }));
  }

  saveIncident(i: IncidentRecord): void {
    this.incidents.set(i.incidentId, { ...i });
    this.outbox.push({ kind: 'incident', i: { ...i } });
  }

  listIncidents(opts?: { status?: string; limit?: number }): IncidentRecord[] {
    const limit = Math.min(opts?.limit ?? 100, 500);
    let rows = [...this.incidents.values()];
    if (opts?.status) rows = rows.filter((r) => r.status === opts.status);
    rows.sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0));
    return rows.slice(0, limit).map((r) => ({ ...r }));
  }

  saveTimeline(interactionId: string, timelineJson: string): void {
    const savedAt = new Date().toISOString();
    this.timelines.set(interactionId, { timelineJson, savedAt });
    this.outbox.push({ kind: 'timeline', interactionId, timelineJson, savedAt });
  }

  getTimeline(interactionId: string): string | undefined {
    const v = this.timelines.get(interactionId)?.timelineJson;
    if (v === undefined) return undefined;
    return typeof v === 'string' ? v : JSON.stringify(v); // JSONB may hydrate as parsed value
  }

  private spans = new Map<string, { spansJson: string; savedAt: string }>();

  saveSpans(interactionId: string, spansJson: string): void {
    const savedAt = new Date().toISOString();
    this.spans.set(interactionId, { spansJson, savedAt });
    this.outbox.push({ kind: 'spans', interactionId, spansJson, savedAt });
  }

  getSpans(interactionId: string): string | undefined {
    const v = this.spans.get(interactionId)?.spansJson;
    if (v === undefined) return undefined;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  savePolicyDecision(d: PolicyDecisionRecord): void {
    this.decisions.set(d.decisionId, { ...d });
    this.outbox.push({ kind: 'decision', d: { ...d } });
  }

  listPolicyDecisions(interactionId: string): Record<string, unknown>[] {
    const rows = [...this.decisions.values()]
      .filter((d) => d.interactionId === interactionId)
      .sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1 : 0));
    return rows.map(decisionToApiShape);
  }

  usageCounts(organizationId: string) {
    let governed = 0, high = 0;
    for (const r of this.interactions.values()) {
      if (r.organizationId !== organizationId) continue;
      governed++;
      if (r.peakRisk >= 40) high++;
    }
    let incidents = 0;
    for (const r of this.incidents.values()) {
      if (r.organizationId === organizationId) incidents++;
    }
    let blockedDecisions = 0;
    for (const d of this.decisions.values()) {
      if (d.allowed !== 0) continue;
      const i = this.interactions.get(d.interactionId);
      if (i && i.organizationId === organizationId) blockedDecisions++;
    }
    return { governed, incidents, blockedDecisions, highRisk: high };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyOfEvidence(row: Record<string, unknown>): string {
  return String(row.interactionid ?? row.interactionId ?? '');
}

// pg lower-cases column names for unquoted identifiers; handle both casings.
function pgRowToInteraction(row: Record<string, unknown>): StoredInteraction {
  const g = (a: string, b: string) => row[a] ?? row[b];
  return {
    interactionId: String(g('interactionid', 'interactionId')),
    organizationId: String(g('organizationid', 'organizationId')),
    platform: String(g('platform', 'platform')),
    channel: String(g('channel', 'channel')),
    startedAt: String(g('startedat', 'startedAt')),
    endedAt: g('endedat', 'endedAt') != null ? String(g('endedat', 'endedAt')) : undefined,
    scenarioLabel: g('scenariolabel', 'scenarioLabel') != null ? String(g('scenariolabel', 'scenarioLabel')) : undefined,
    peakRisk: Number(g('peakrisk', 'peakRisk') ?? 0),
    finalRisk: Number(g('finalrisk', 'finalRisk') ?? 0),
    metadata: parseMetadata(g('metadatajson', 'metadataJson')),
    biomarkers: parseMetadata(g('biomarkersjson', 'biomarkersJson')),
  };
}

function parseMetadata(v: unknown): Record<string, unknown> | undefined {
  if (v == null) return undefined;
  if (typeof v === 'object') return v as Record<string, unknown>; // JSONB hydrates parsed
  try { return JSON.parse(String(v)) as Record<string, unknown>; } catch { return undefined; }
}

function pgRowToEvidence(row: Record<string, unknown>): EvidenceRecord {
  const g = (a: string, b: string) => row[a] ?? row[b];
  return {
    sequence: Number(g('sequence', 'sequence')),
    recordId: String(g('recordid', 'recordId')),
    kind: String(g('kind', 'kind')),
    refId: String(g('refid', 'refId')),
    payloadHash: String(g('payloadhash', 'payloadHash')),
    prevChainHash: String(g('prevchainhash', 'prevChainHash')),
    chainHash: String(g('chainhash', 'chainHash')),
    ts: String(g('ts', 'ts')),
  };
}

function pgRowToIncident(row: Record<string, unknown>): IncidentRecord {
  const g = (a: string, b: string) => row[a] ?? row[b];
  return {
    incidentId: String(g('incidentid', 'incidentId')),
    organizationId: String(g('organizationid', 'organizationId')),
    interactionId: String(g('interactionid', 'interactionId')),
    title: String(g('title', 'title')),
    severity: String(g('severity', 'severity')),
    status: String(g('status', 'status')),
    openedAt: String(g('openedat', 'openedAt')),
    summary: String(g('summary', 'summary')),
  };
}

function pgRowToDecision(row: Record<string, unknown>): PolicyDecisionRecord {
  const g = (a: string, b: string) => row[a] ?? row[b];
  const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
  return {
    decisionId: String(g('decisionid', 'decisionId')),
    interactionId: String(g('interactionid', 'interactionId')),
    policyId: String(g('policyid', 'policyId')),
    policyVersion: Number(g('policyversion', 'policyVersion') ?? 0),
    matchedRule: String(g('matchedrule', 'matchedRule')),
    allowed: Number(g('allowed', 'allowed') ?? 0),
    actionsJson: asText(g('actionsjson', 'actionsJson')),
    reasonsJson: asText(g('reasonsjson', 'reasonsJson')),
    latencyMs: Number(g('latencyms', 'latencyMs') ?? 0),
    decidedAt: String(g('decidedat', 'decidedAt')),
    subjectJson: asText(g('subjectjson', 'subjectJson')),
  };
}

function decisionToApiShape(d: PolicyDecisionRecord): Record<string, unknown> {
  return {
    decisionId: d.decisionId,
    interactionId: d.interactionId,
    policyId: d.policyId,
    policyVersion: d.policyVersion,
    matchedRule: d.matchedRule,
    allowed: !!d.allowed,
    actions: JSON.parse(d.actionsJson),
    reasons: JSON.parse(d.reasonsJson),
    subject: JSON.parse(d.subjectJson),
    latencyMs: d.latencyMs,
    decidedAt: d.decidedAt,
  };
}
