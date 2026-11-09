// Contract tests for the Store interface, run against BOTH backends:
//  * SqliteStore — validates the shared test functions themselves.
//  * PgStore     — sync contract + mirror semantics (mirror-only mode when
//                  no Postgres is available).
// When CXTRUST_TEST_PG_URL is set, additionally verifies the Postgres flush
// (write → flush → reload into a fresh PgStore reads back the same rows).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteStore, type Store, type StoredInteraction } from '../src/store.ts';
import { PgStore } from '../src/store_pg.ts';

const PG_URL = process.env.CXTRUST_TEST_PG_URL ?? '';

function makeInteraction(id: string, overrides: Partial<StoredInteraction> = {}): StoredInteraction {
  return {
    interactionId: id,
    organizationId: 'org-1',
    platform: 'web',
    channel: 'chat',
    startedAt: '2026-09-21T10:00:00.000Z',
    peakRisk: 10,
    finalRisk: 5,
    ...overrides,
  };
}

/** Exercises every Store method. Runs against SqliteStore and PgStore alike. */
export function runStoreContract(name: string, makeStore: () => { store: Store; dispose: () => Promise<void> | void }) {
  describe(`store contract: ${name}`, () => {
    test('interactions: upsert/get/list filters + ordering', async () => {
      const { store, dispose } = makeStore();
      try {
        store.upsertInteraction(makeInteraction('i-1'));
        store.upsertInteraction(makeInteraction('i-2', { startedAt: '2026-09-21T11:00:00.000Z' }));
        store.upsertInteraction(makeInteraction('i-3', { organizationId: 'org-2', platform: 'voice' }));

        assert.equal(store.getInteraction('i-1')?.organizationId, 'org-1');
        assert.equal(store.getInteraction('nope'), undefined);

        // Upsert updates mutable fields only.
        store.upsertInteraction(makeInteraction('i-1', { endedAt: '2026-09-21T10:05:00.000Z', peakRisk: 80, finalRisk: 60, scenarioLabel: 'escalation' }));
        const up = store.getInteraction('i-1')!;
        assert.equal(up.peakRisk, 80);
        assert.equal(up.scenarioLabel, 'escalation');
        assert.equal(up.startedAt, '2026-09-21T10:00:00.000Z'); // immutable on conflict

        const all = store.listInteractions();
        assert.deepEqual(all.map((r) => r.interactionId), ['i-2', 'i-1', 'i-3']); // startedAt DESC
        assert.equal(store.listInteractions({ limit: 1 }).length, 1);
        assert.deepEqual(store.listInteractions({ organizationId: 'org-2' }).map((r) => r.interactionId), ['i-3']);
        assert.equal(store.listInteractions({ platform: 'voice' }).length, 1);
        assert.equal(store.listInteractions({ platform: 'sms' }).length, 0);
      } finally {
        await dispose();
      }
    });

    test('interactions: metadata (call direction etc.) round-trips and survives updates', async () => {
      const { store, dispose } = makeStore();
      try {
        store.upsertInteraction(makeInteraction('m-1', { metadata: { initiationMethod: 'INBOUND', queue: 'arn:aws:connect:us-east-1:1:queue/x' } }));
        assert.deepEqual(store.getInteraction('m-1')?.metadata, { initiationMethod: 'INBOUND', queue: 'arn:aws:connect:us-east-1:1:queue/x' });

        // A later upsert WITHOUT metadata (risk update) must not wipe it.
        store.upsertInteraction(makeInteraction('m-1', { peakRisk: 42 }));
        const up = store.getInteraction('m-1')!;
        assert.equal(up.peakRisk, 42);
        assert.deepEqual(up.metadata, { initiationMethod: 'INBOUND', queue: 'arn:aws:connect:us-east-1:1:queue/x' });
        assert.equal(store.listInteractions().find(r => r.interactionId === 'm-1')?.metadata?.initiationMethod, 'INBOUND');

        // Interactions created without metadata stay metadata-free (no fabricated object).
        store.upsertInteraction(makeInteraction('m-2'));
        assert.equal(store.getInteraction('m-2')?.metadata, undefined);
      } finally {
        await dispose();
      }
    });

    test('interactions: biomarkers round-trip and survive updates without metadata', async () => {
      const { store, dispose } = makeStore();
      try {
        const report = { emotion: { activation: 0.62, confidence: 0.7 }, biomarkers: [{ key: 'tremorIndex', value: 0.2 }], limitations: ['x'] };
        store.upsertInteraction(makeInteraction('bm-1', { biomarkers: report as Record<string, unknown> }));
        assert.deepEqual(store.getInteraction('bm-1')?.biomarkers, report);

        // a later risk-only upsert must not wipe the report (COALESCE)
        store.upsertInteraction(makeInteraction('bm-1', { peakRisk: 77 }));
        const up = store.getInteraction('bm-1')!;
        assert.equal(up.peakRisk, 77);
        assert.deepEqual(up.biomarkers, report);
        assert.equal(
          (store.listInteractions().find(r => r.interactionId === 'bm-1')?.biomarkers as { emotion?: { activation?: number } } | undefined)?.emotion?.activation,
          0.62,
        );
      } finally {
        await dispose();
      }
    });

    test('evidence: append, order by sequence, dedupe by (interactionId, sequence)', async () => {
      const { store, dispose } = makeStore();
      try {
        const rec = (seq: number, recordId: string) => ({
          sequence: seq, recordId, kind: 'transcript', refId: `ref-${seq}`,
          payloadHash: `h${seq}`, prevChainHash: `p${seq}`, chainHash: `c${seq}`, ts: '2026-09-21T10:00:00.000Z',
        });
        store.appendEvidence('i-1', rec(2, 'r-2'));
        store.appendEvidence('i-1', rec(0, 'r-0'));
        store.appendEvidence('i-1', rec(1, 'r-1'));
        // Same PK (interactionId, sequence) → ignored.
        store.appendEvidence('i-1', rec(1, 'r-1-DUPLICATE'));
        // Same recordId at a different sequence → stored (dedupe is by PK, not recordId).
        store.appendEvidence('i-2', rec(0, 'r-0'));

        const rows = store.listEvidence('i-1');
        assert.deepEqual(rows.map((r) => r.sequence), [0, 1, 2]);
        assert.equal(rows.length, 3); // no duplicate sequence
        assert.ok(rows.every((r) => r.recordId !== 'r-1-DUPLICATE'));
        assert.equal(store.listEvidence('i-2').length, 1);
        assert.equal(store.listEvidence('missing').length, 0);
      } finally {
        await dispose();
      }
    });

    test('incidents: save/list status filter + openedAt desc', async () => {
      const { store, dispose } = makeStore();
      try {
        store.saveIncident({ incidentId: 'x-1', organizationId: 'org-1', interactionId: 'i-1', title: 'T1', severity: 'high', status: 'open', openedAt: '2026-09-21T10:00:00.000Z', summary: 's1' });
        store.saveIncident({ incidentId: 'x-2', organizationId: 'org-1', interactionId: 'i-2', title: 'T2', severity: 'low', status: 'closed', openedAt: '2026-09-21T11:00:00.000Z', summary: 's2' });
        store.saveIncident({ incidentId: 'x-1', organizationId: 'org-1', interactionId: 'i-1', title: 'T1-updated', severity: 'high', status: 'closed', openedAt: '2026-09-21T10:00:00.000Z', summary: 's1' });

        assert.deepEqual(store.listIncidents().map((r) => r.incidentId), ['x-2', 'x-1']);
        assert.deepEqual(store.listIncidents({ status: 'closed' }).map((r) => r.incidentId), ['x-2', 'x-1']);
        assert.deepEqual(store.listIncidents({ status: 'open' }), []);
        assert.equal(store.listIncidents().find((r) => r.incidentId === 'x-1')?.title, 'T1-updated');
        assert.equal(store.listIncidents({ limit: 1 }).length, 1);
      } finally {
        await dispose();
      }
    });

    test('timeline: save/get/overwrite', async () => {
      const { store, dispose } = makeStore();
      try {
        assert.equal(store.getTimeline('i-1'), undefined);
        store.saveTimeline('i-1', JSON.stringify([{ t: 1 }]));
        assert.equal(store.getTimeline('i-1'), JSON.stringify([{ t: 1 }]));
        store.saveTimeline('i-1', JSON.stringify([{ t: 2 }]));
        assert.equal(store.getTimeline('i-1'), JSON.stringify([{ t: 2 }]));
        assert.equal(store.getTimeline('missing'), undefined);
      } finally {
        await dispose();
      }
    });

    test('policy decisions: save/list (parsed json, allowed boolean, ordered by decidedAt)', async () => {
      const { store, dispose } = makeStore();
      try {
        store.savePolicyDecision({ decisionId: 'd-1', interactionId: 'i-1', policyId: 'p-1', policyVersion: 2, matchedRule: 'no-pii', allowed: 0, actionsJson: '["redact"]', reasonsJson: '["pii"]', latencyMs: 3.5, decidedAt: '2026-09-21T10:01:00.000Z', subjectJson: '{"userId":"u1"}' });
        store.savePolicyDecision({ decisionId: 'd-2', interactionId: 'i-1', policyId: 'p-2', policyVersion: 1, matchedRule: 'tone', allowed: 1, actionsJson: '[]', reasonsJson: '[]', latencyMs: 1, decidedAt: '2026-09-21T10:00:00.000Z', subjectJson: '{}' });
        store.savePolicyDecision({ decisionId: 'd-3', interactionId: 'i-2', policyId: 'p-1', policyVersion: 2, matchedRule: 'r', allowed: 1, actionsJson: '[]', reasonsJson: '[]', latencyMs: 0, decidedAt: '2026-09-21T10:02:00.000Z', subjectJson: '{}' });

        const rows = store.listPolicyDecisions('i-1');
        assert.deepEqual(rows.map((r) => r.decisionId), ['d-2', 'd-1']); // decidedAt asc
        const d1 = rows.find((r) => r.decisionId === 'd-1')!;
        assert.equal(d1.allowed, false);
        assert.deepEqual(d1.actions, ['redact']);
        assert.deepEqual(d1.reasons, ['pii']);
        assert.deepEqual(d1.subject, { userId: 'u1' });
        assert.equal(store.listPolicyDecisions('missing').length, 0);
      } finally {
        await dispose();
      }
    });

    test('usageCounts: governed/incidents/blockedDecisions/highRisk', async () => {
      const { store, dispose } = makeStore();
      try {
        store.upsertInteraction(makeInteraction('i-1'));
        store.upsertInteraction(makeInteraction('i-2', { peakRisk: 55 }));
        store.upsertInteraction(makeInteraction('i-3', { organizationId: 'org-2' }));
        store.saveIncident({ incidentId: 'x-1', organizationId: 'org-1', interactionId: 'i-1', title: 'T', severity: 'high', status: 'open', openedAt: '2026-09-21T10:00:00.000Z', summary: 's' });
        store.savePolicyDecision({ decisionId: 'd-1', interactionId: 'i-1', policyId: 'p', policyVersion: 1, matchedRule: 'r', allowed: 0, actionsJson: '[]', reasonsJson: '[]', latencyMs: 0, decidedAt: '2026-09-21T10:00:00.000Z', subjectJson: '{}' });
        store.savePolicyDecision({ decisionId: 'd-2', interactionId: 'i-2', policyId: 'p', policyVersion: 1, matchedRule: 'r', allowed: 1, actionsJson: '[]', reasonsJson: '[]', latencyMs: 0, decidedAt: '2026-09-21T10:00:00.000Z', subjectJson: '{}' });

        assert.deepEqual(store.usageCounts('org-1'), { governed: 2, incidents: 1, blockedDecisions: 1, highRisk: 1 });
        assert.deepEqual(store.usageCounts('org-2'), { governed: 1, incidents: 0, blockedDecisions: 0, highRisk: 0 });
        assert.deepEqual(store.usageCounts('org-none'), { governed: 0, incidents: 0, blockedDecisions: 0, highRisk: 0 });
      } finally {
        await dispose();
      }
    });
  });
}

// --- Run the same contract functions against both backends -------------------

function makeSqlite() {
  const dir = mkdtempSync(join(tmpdir(), 'cxtrust-sqlite-'));
  const store = new SqliteStore(join(dir, 'test.db'));
  return { store, dispose: () => { /* process exit closes it */ } };
}

function makePgMirrorOnly() {
  // Mirror-only mode: a URL is still required by the constructor but the
  // background pump simply fails to connect and retries; all sync reads are
  // served from the in-process mirror, so the sync contract is fully
  // validated without a real Postgres.
  const store = new PgStore('postgresql://invalid:invalid@127.0.0.1:1/none', get_pg());
  return { store, dispose: () => store.dispose() };
}

// node --test strip-types only; avoid top-level await. Lazy import for pg.
let pgMod: typeof import('pg') | undefined;
function get_pg(): typeof import('pg') {
  if (!pgMod) pgMod = createRequire(import.meta.url)('pg') as typeof import('pg');
  return pgMod;
}

runStoreContract('SqliteStore', makeSqlite);
runStoreContract('PgStore (mirror-only)', makePgMirrorOnly);

// --- Postgres-only tests (flush + reload round-trip) --------------------------

describe('store contract: PgStore (real Postgres via CXTRUST_TEST_PG_URL)', {
  skip: PG_URL === '' ? 'CXTRUST_TEST_PG_URL not set' : false,
}, () => {
  const suffix = Date.now().toString(36);

  function makePg() {
    const store = new PgStore(PG_URL, get_pg());
    return { store, dispose: () => store.dispose() };
  }
  runStoreContract(`PgStore (flushed, run ${suffix})`, makePg);

  test('restart-recovery: write → dispose → fresh PgStore reads rows back', async () => {
    const uniq = `pg-restart-${suffix}`;
    const org = `org-${uniq}`;
    const a = new PgStore(PG_URL, get_pg());
    await a.whenReady();
    a.upsertInteraction(makeInteraction(uniq, {
      organizationId: org, peakRisk: 70, finalRisk: 40,
      startedAt: '2026-09-21T12:00:00.000Z', endedAt: '2026-09-21T12:05:00.000Z', scenarioLabel: 'restart-test',
    }));
    a.appendEvidence(uniq, { sequence: 1, recordId: 'ev-1', kind: 'transcript', refId: 'ref', payloadHash: 'h', prevChainHash: 'p', chainHash: 'c', ts: '2026-09-21T12:00:00.000Z' });
    a.saveIncident({ incidentId: `inc-${uniq}`, organizationId: org, interactionId: uniq, title: 'T', severity: 'high', status: 'open', openedAt: '2026-09-21T12:00:00.000Z', summary: 's' });
    a.saveTimeline(uniq, JSON.stringify([{ t: 1 }]));
    a.savePolicyDecision({ decisionId: `dec-${uniq}`, interactionId: uniq, policyId: 'p', policyVersion: 1, matchedRule: 'r', allowed: 0, actionsJson: '[]', reasonsJson: '[]', latencyMs: 1, decidedAt: '2026-09-21T12:00:00.000Z', subjectJson: '{}' });
    await a.dispose();
    // Give the pump's final flush a beat; dispose stops the loop after the
    // current iteration, so wait until the rows are actually visible.
    await waitForRows(PG_URL, uniq, 15_000);
    await a.dispose();

    const b = new PgStore(PG_URL, get_pg());
    await b.whenReady();
    try {
      assert.deepEqual(b.getInteraction(uniq), {
        interactionId: uniq, organizationId: org, platform: 'web', channel: 'chat',
        startedAt: '2026-09-21T12:00:00.000Z', endedAt: '2026-09-21T12:05:00.000Z',
        scenarioLabel: 'restart-test', peakRisk: 70, finalRisk: 40,
      });
      assert.equal(b.listEvidence(uniq).length, 1);
      assert.ok(b.listIncidents().some((r) => r.incidentId === `inc-${uniq}`));
      assert.equal(b.getTimeline(uniq), JSON.stringify([{ t: 1 }]));
      const dec = b.listPolicyDecisions(uniq);
      assert.equal(dec.length, 1);
      assert.equal(dec[0].allowed, false);
      assert.deepEqual(b.usageCounts(org), { governed: 1, incidents: 1, blockedDecisions: 1, highRisk: 1 });
    } finally {
      await b.dispose();
    }
  });

  test('flush reaches real Postgres: row visible via raw SQL after flush', async () => {
    const uniq = `pg-flush-${suffix}`;
    const a = new PgStore(PG_URL, get_pg());
    a.upsertInteraction(makeInteraction(uniq, { organizationId: `org-${uniq}` }));
    await waitForRows(PG_URL, uniq, 15_000);
    await a.dispose();
  });
});

async function waitForRows(url: string, interactionId: string, timeoutMs: number): Promise<void> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await client.query('SELECT COUNT(*)::int AS n FROM interactions WHERE interactionId = $1', [interactionId]);
      if (r.rows[0].n > 0) return;
      await new Promise((res) => setTimeout(res, 200));
    }
    assert.fail(`row ${interactionId} not flushed to Postgres within ${timeoutMs}ms`);
  } finally {
    await client.end();
  }
}
