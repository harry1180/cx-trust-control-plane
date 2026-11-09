// Usage / licensing metering tests: counters, atomic persistence,
// month-to-date aggregation, licensing endpoint, edition overage, e2e.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import { UsageMeter, EDITION_FEATURES, setActiveMeter, getActiveMeter } from '../src/usage.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const AI_EVENT = {
  organizationId: 'org-demo',
  platform: 'amazon-connect',
  channel: 'voice',
  startedAt: '2026-09-21T10:00:00.000Z',
  endedAt: '2026-09-21T10:05:00.000Z', // 5 minutes
  peakRisk: 0.8,
  participants: [{ kind: 'CUSTOMER' }, { kind: 'ENTERPRISE_AI' }, { kind: 'THIRD_PARTY_AI' }],
  decisions: [{ allowed: true, latencyMs: 4 }, { allowed: false, latencyMs: 7 }],
};

test('UsageMeter counts interactions, minutes, AI agents, policy outcomes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  try {
    const meter = new UsageMeter(join(dir, 'usage.json'));
    meter.recordUsage('INT-1', AI_EVENT);
    // partial interaction: started 1 minute ago so "duration so far" stays
    // bounded (a fixed historical date would eventually exceed 24h)
    meter.recordUsage('INT-2', { ...AI_EVENT, organizationId: 'org-other', endedAt: undefined, startedAt: new Date(Date.now() - 60_000).toISOString(), agentGoverned: true });
    const a = meter.counters('org-demo');
    assert.equal(a.monthToDate.interactionsGoverned, 1);
    assert.equal(a.monthToDate.minutesGoverned, 5);
    assert.equal(a.monthToDate.aiAgentsGoverned, 2); // ENTERPRISE_AI + THIRD_PARTY_AI
    assert.equal(a.monthToDate.policyEvaluations, 2);
    assert.equal(a.monthToDate.policyDecisionsBlocked, 1);
    // partial interaction: counted at duration-so-far (endedAt undefined →
    // now − startedAt, an estimate that grows until the interaction ends)
    const b = meter.counters('org-other').monthToDate;
    assert.equal(b.interactionsGoverned, 1);
    assert.ok(b.minutesGoverned > 0 && b.minutesGoverned < 60 * 24);
    // NOTE: aiAgentsGoverned is 2 here, not 1 — the fixed AI_EVENT spread
    // retains its ENTERPRISE_AI/THIRD_PARTY_AI participants; agentGoverned is
    // only a fallback when the participant list carries no AI kinds.
    assert.equal(b.aiAgentsGoverned, 2);
    // delta accounting: re-emitting the same fixed event is a no-op
    meter.recordUsage('INT-1', AI_EVENT);
    assert.equal(meter.counters('org-demo').monthToDate.interactionsGoverned, 1);
    assert.equal(meter.counters('org-demo').monthToDate.policyEvaluations, 2);
    // but an ACCRUED snapshot (new participant + new decision) applies deltas
    meter.recordUsage('INT-1', { ...AI_EVENT, participants: [...AI_EVENT.participants, { kind: 'EXTERNAL_AI' }], decisions: [...AI_EVENT.decisions, { allowed: false, latencyMs: 2 }] });
    const after = meter.counters('org-demo').monthToDate;
    assert.equal(after.interactionsGoverned, 1); // still one interaction
    assert.equal(after.aiAgentsGoverned, 3);      // +EXTERNAL_AI
    assert.equal(after.policyEvaluations, 3);     // +1 decision
    assert.equal(after.policyDecisionsBlocked, 2); // +1 blocked
    meter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic JSON write: file exists and parses after burst of writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  try {
    const path = join(dir, 'usage.json');
    const meter = new UsageMeter(path);
    for (let i = 0; i < 50; i++) {
      meter.recordUsage(`INT-burst-${i}`, { ...AI_EVENT, startedAt: `2026-09-21T10:0${i % 6}:00.000Z` });
    }
    meter.flush();
    assert.ok(existsSync(path));
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { orgs: Record<string, Record<string, unknown>> };
    assert.equal(Object.keys(parsed.orgs['org-demo'] ?? {}).length, 1); // one day bucket
    // no tmp residue
    assert.equal(mkdtempOrphans(dir), 0);
    meter.close();
    assert.equal(mkdtempOrphans(dir), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkdtempOrphans(dir: string): number {
  return readdirSync(dir).filter(f => f.includes('.tmp-')).length;
}

test('month-to-date aggregation spans multiple days of current month only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  try {
    const meter = new UsageMeter(join(dir, 'usage.json'));
    // two days in the current month + one day outside it
    const now = new Date();
    const ym = now.toISOString().slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const d1 = `${ym}-01T10:00:00.000Z`;
    const d2 = `${ym}-02T10:00:00.000Z`;
    const outsideMonth = new Date(Date.UTC(y === 1 ? 2019 : y - 1, m - 1, 15)).toISOString().replace('.000Z', '.000Z');
    meter.recordUsage('INT-m1', { ...AI_EVENT, startedAt: d1, endedAt: `${ym}-01T10:10:00.000Z` });
    meter.recordUsage('INT-m2', { ...AI_EVENT, startedAt: d2, endedAt: `${ym}-02T10:02:00.000Z` });
    meter.recordUsage('INT-old', { ...AI_EVENT, startedAt: outsideMonth, endedAt: outsideMonth });
    const c = meter.counters('org-demo', now);
    assert.equal(c.monthToDate.interactionsGoverned, 2); // prior-month day excluded
    assert.equal(c.monthToDate.minutesGoverned, 12);
    assert.ok(c.day.interactionsGoverned <= 2);
    meter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('licensing report: counters + limits + no overage at low volume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  const prevEdition = process.env.CXTRUST_EDITION;
  delete process.env.CXTRUST_EDITION; // default enterprise → unlimited
  try {
    const meter = new UsageMeter(join(dir, 'usage.json'));
    meter.recordUsage('INT-l1', AI_EVENT);
    const report = meter.licensing('org-demo');
    assert.equal(report.organizationId, 'org-demo');
    assert.equal(report.edition, 'enterprise');
    assert.equal(report.meterVersion, 1);
    assert.equal(report.limits.unlimited, true);
    assert.equal(report.overage.interactionsOver, null);
    assert.equal(report.counters.monthToDate.interactionsGoverned, 1);
    meter.close();
  } finally {
    if (prevEdition === undefined) delete process.env.CXTRUST_EDITION;
    else process.env.CXTRUST_EDITION = prevEdition;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edition limits respected: exceeding limit shows overage flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  const prevEdition = process.env.CXTRUST_EDITION;
  process.env.CXTRUST_EDITION = 'core';
  try {
    const meter = new UsageMeter(join(dir, 'usage.json'));
    const limit = EDITION_FEATURES.core.maxInteractionsPerMonth as number;
    for (let i = 0; i < limit + 3; i++) meter.recordUsage(`INT-x-${i}`, AI_EVENT);
    const report = meter.licensing('org-demo');
    assert.equal(report.edition, 'core');
    assert.equal(report.counters.monthToDate.interactionsGoverned, limit + 3);
    assert.equal(report.overage.interactionsOver, 3);
    // enterprise back to null
    process.env.CXTRUST_EDITION = 'enterprise';
    assert.equal(meter.licensing('org-demo').overage.interactionsOver, null);
    meter.close();
  } finally {
    if (prevEdition === undefined) delete process.env.CXTRUST_EDITION;
    else process.env.CXTRUST_EDITION = prevEdition;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('meter reloads persisted state from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  try {
    const path = join(dir, 'usage.json');
    const m1 = new UsageMeter(path);
    m1.recordUsage('INT-r', AI_EVENT);
    m1.close();
    const m2 = new UsageMeter(path);
    assert.equal(m2.counters('org-demo').monthToDate.interactionsGoverned, 1);
    m2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- server e2e: CXTRUST_USAGE=on → REST interactions → /v1/licensing ----------

let server: Server;
let base = '';

test.before(async () => {
  process.env.CXTRUST_USAGE = 'on';
  const dir = mkdtempSync(join(tmpdir(), 'usage-e2e-'));
  process.env.CXTRUST_USAGE_DB = join(dir, 'e2e-usage.json');
  const store = new SqliteStore(':memory:');
  server = createApi({ port: 0, store });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => {
  getActiveMeter()?.close();
  setActiveMeter(null);
  delete process.env.CXTRUST_USAGE;
  delete process.env.CXTRUST_USAGE_DB;
  server.close();
});

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('e2e: 2 governed interactions reflected in /v1/licensing', async () => {
  const h = await req('GET', '/healthz');
  assert.equal(h.status, 200);
  assert.ok(getActiveMeter(), 'meter active with CXTRUST_USAGE=on');

  for (let i = 0; i < 2; i++) {
    const start = await req('POST', '/v1/interactions', { organizationId: 'org-demo', interactionId: `INT-e2e-${i}` });
    assert.equal(start.status, 201);
    const id = String(start.json.interactionId);
    await req('POST', `/v1/interactions/${id}/participant`, {
      participantId: 'p-ai', interactionId: id, organizationId: 'org-demo',
      kind: 'ENTERPRISE_AI', classification: 'AUTHORIZED_ENTERPRISE_AI', identityConfidence: 0.9,
      authLevel: 'HIGH', joinedAtOffsetS: 0, riskState: {},
    });
    await req('POST', `/v1/interactions/${id}/turns`, { participantId: 'p-ai', text: 'Move my funds now.', offsetS: 3 });
    const end = await req('POST', `/v1/interactions/${id}/end`);
    assert.equal(end.status, 200);
  }

  const lic = await req('GET', '/v1/licensing/org-demo');
  assert.equal(lic.status, 200);
  const counters = lic.json.counters as { day: Record<string, number>; monthToDate: Record<string, number> };
  assert.equal(counters.monthToDate.interactionsGoverned, 2);
  assert.equal(counters.monthToDate.aiAgentsGoverned, 2);
  assert.equal(lic.json.organizationId, 'org-demo');
  assert.ok(lic.json.edition);
  assert.ok('limits' in lic.json && 'overage' in lic.json && 'meterVersion' in lic.json);
  assert.equal((lic.json.overage as { interactionsOver: number | null }).interactionsOver, null);
  assert.ok(Number(counters.day.interactionsGoverned) >= 2);

  // licensing with metering off still answers (dormant shape)
  const noMeter = await req('GET', '/v1/licensing/org-unknown');
  assert.equal(noMeter.status, 200);
});
