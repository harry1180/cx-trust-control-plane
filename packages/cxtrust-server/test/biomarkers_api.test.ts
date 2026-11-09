// Biomarker persistence + wellbeing-signal incident API tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const { createApi } = await import('../src/index.ts');
const { SqliteStore } = await import('../src/store.ts');

let server: ReturnType<typeof createServer>;
let base = '';

test.before(async () => {
  server = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(r => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => server.close());

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

function report(activation: number, tremor: number): Record<string, unknown> {
  return {
    biomarkers: [
      { key: 'tremorIndex', label: 'Pitch tremor index (4–7Hz)', value: tremor, unit: '0..1', note: 'association + caveat text for the record' },
      { key: 'pauseRatio', label: 'Pause ratio', value: 12.5, unit: '%', note: 'association + caveat text for the record' },
    ],
    emotion: { activation, confidence: 0.8, label: 'test band', candidates: ['neutral'], disclaimer: 'estimate, unreliable' },
    limitations: ['Not a medical device; no diagnostic claims.'],
    analyzedDurationS: 5, speechFrames: 120, baselineUsed: false,
  };
}

test('POST biomarkers persists on the interaction and is readable via replay', async () => {
  const created = await post('/v1/interactions', { interactionId: 'INT-BM-1', organizationId: 'org-demo', platform: 'amazon-connect', channel: 'voice' });
  assert.ok(created.status === 200 || created.status === 201, `create → ${created.status}: ${JSON.stringify(created.json)}`);

  const saved = await post('/v1/interactions/INT-BM-1/biomarkers', report(0.4, 0.1));
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.incident, null, 'below thresholds → no incident');
  assert.deepEqual(saved.json.flags, []);

  const replay = await (await fetch(`${base}/v1/interactions/INT-BM-1/replay`)).json() as { interaction?: { biomarkers?: { emotion?: { activation?: number } } } };
  assert.equal(replay.interaction?.biomarkers?.emotion?.activation, 0.4, 'report survives on the stored row (what Investigation reads)');
});

test('crossed thresholds open a Wellbeing signal incident carrying measured values', async () => {
  await post('/v1/interactions', { interactionId: 'INT-BM-2', organizationId: 'org-demo', platform: 'amazon-connect', channel: 'voice' });
  const saved = await post('/v1/interactions/INT-BM-2/biomarkers', report(0.9, 0.7));
  assert.equal(saved.status, 200);
  assert.equal(saved.json.incident, 'WB-INT-BM-2');
  assert.equal((saved.json.flags as string[]).length, 2, 'both activation and tremor flags fire');

  const incidents = await (await fetch(`${base}/v1/incidents`)).json() as { incidents: { incidentId: string; title: string; summary: string }[] };
  const inc = incidents.incidents.find(i => i.incidentId === 'WB-INT-BM-2')!;
  assert.ok(inc, 'incident persisted');
  assert.match(inc.title, /^Wellbeing signal/);
  assert.match(inc.summary, /NOT a diagnosis/);
  assert.match(inc.summary, /confidence 0.8/);
});

test('malformed report → 400, never a fabricated record', async () => {
  await post('/v1/interactions', { interactionId: 'INT-BM-3', organizationId: 'org-demo', platform: 'amazon-connect', channel: 'voice' });
  const bad = await post('/v1/interactions/INT-BM-3/biomarkers', { emotion: { activation: 0.5 } });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json.error), /biomarker report required/);
});