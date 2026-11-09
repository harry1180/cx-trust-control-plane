// Alerting tests — every remote endpoint is MOCKED with in-test node:http servers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';

import {
  AlertManager,
  WebhookRouter,
  SlackRouter,
  TeamsRouter,
  SiemRouter,
  DEFAULT_RULES,
  rulesAllow,
  severityAtLeast,
  alertFromIncident,
  alertFromDecision,
  type Alert,
  type AlertSeverity,
} from '../src/index.ts';
import { createApi } from '../../cxtrust-server/src/index.ts';
import { SqliteStore } from '../../cxtrust-server/src/store.ts';

// ---------- in-test HTTP mock helper ----------

interface CapturedRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
  auth: string | undefined;
}

/** Start a mock server that records every POST; returns { base, requests, close }. */
async function startMock(status = 200): Promise<{
  base: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
  server: Server;
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        path: req.url ?? '/',
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        body: Buffer.concat(chunks).toString('utf8'),
        auth: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    requests,
    server,
    close: () => new Promise(resolve => { server.close(() => resolve()); }),
  };
}

function baseAlert(severity: AlertSeverity = 'LOW', org = 'org-a'): Alert {
  return {
    alertId: 'ALT-1',
    alertType: 'INCIDENT_OPENED',
    severity,
    organizationId: org,
    interactionId: 'INT-1',
    incidentId: 'INC-1',
    title: 'Test alert',
    summary: 'A test happened',
    riskScore: 42,
    createdAt: new Date().toISOString(),
    payload: { interactionId: 'INT-1', status: 'OPEN' },
  };
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------- WebhookRouter ----------

test('WebhookRouter posts alert JSON with valid HMAC signature header', async () => {
  const mock = await startMock();
  await withEnv({
    CXTRUST_ALERT_WEBHOOK_URL: `${mock.base}/hook`,
    CXTRUST_ALERT_SIGNING_SECRET: 'shhh-test-secret',
  }, async () => {
    const router = new WebhookRouter();
    const alert = baseAlert('HIGH');
    const r = await router.route(alert);
    assert.equal(r.delivered, true);
    assert.equal(mock.requests.length, 1);
    const req = mock.requests[0];
    assert.equal(req.path, '/hook');
    // body is the alert JSON and the signature matches HMAC-SHA256 of the exact body
    const parsed = JSON.parse(req.body) as Alert;
    assert.equal(parsed.alertId, 'ALT-1');
    assert.equal(parsed.alertType, 'INCIDENT_OPENED');
    assert.deepEqual(parsed.payload, { interactionId: 'INT-1', status: 'OPEN' });
    const expect = createHmac('sha256', 'shhh-test-secret').update(req.body).digest('hex');
    assert.equal(req.headers['x-cxtrust-signature'], expect);
  });
  await mock.close();
});

test('WebhookRouter sends unsigned when no signing secret, notes it in detail', async () => {
  const mock = await startMock();
  await withEnv({
    CXTRUST_ALERT_WEBHOOK_URL: `${mock.base}/hook`,
    CXTRUST_ALERT_SIGNING_SECRET: undefined,
  }, async () => {
    const r = await new WebhookRouter().route(baseAlert());
    assert.equal(r.delivered, true);
    assert.ok((r.detail ?? '').includes('unsigned'));
    assert.equal(mock.requests[0].headers['x-cxtrust-signature'], undefined);
  });
  await mock.close();
});

// ---------- Slack / Teams / Siem format ----------

test('SlackRouter posts Block Kit payload with severity color and link', async () => {
  const mock = await startMock();
  await withEnv({ CXTRUST_SLACK_WEBHOOK_URL: `${mock.base}/slack` }, async () => {
    const router = new SlackRouter();
    const r = await router.route(baseAlert('CRITICAL'));
    assert.equal(r.delivered, true);
    const payload = JSON.parse(mock.requests[0].body) as {
      text: string;
      attachments: { color: string; blocks: { type: string; text?: { text: string }; fields?: { text: string }[] }[] }[];
    };
    assert.equal(payload.attachments[0].color, '#9d0000'); // CRITICAL color
    const header = payload.attachments[0].blocks.find(b => b.type === 'header');
    assert.ok(header?.text?.text.includes('[CRITICAL] Test alert'));
    const fields = payload.attachments[0].blocks.find(b => b.fields)?.fields ?? [];
    const linkField = fields.find(f => f.text.includes('/interactions/INT-1'));
    assert.ok(linkField, 'interaction link placeholder present');
    assert.ok(linkField.text.includes('<https://console.example.com/interactions/INT-1|INT-1>'));
  });
  await mock.close();
});

test('TeamsRouter posts MessageCard JSON', async () => {
  const mock = await startMock();
  await withEnv({ CXTRUST_TEAMS_WEBHOOK_URL: `${mock.base}/teams` }, async () => {
    const r = await new TeamsRouter().route(baseAlert('HIGH'));
    assert.equal(r.delivered, true);
    const card = JSON.parse(mock.requests[0].body) as Record<string, unknown> & {
      sections: { facts: { name: string; value: string }[] }[];
    };
    assert.equal(card['@type'], 'MessageCard');
    assert.equal(card['@context'], 'https://schema.org/extensions');
    assert.equal(card.themeColor, '#e01e5a'); // HIGH color
    assert.equal(card.title, '[HIGH] Test alert');
    const facts = card.sections[0].facts;
    assert.ok(facts.find(f => f.name === 'Alert type' && f.value === 'INCIDENT_OPENED'));
    assert.ok(facts.find(f => f.name === 'Incident' && f.value === 'INC-1'));
  });
  await mock.close();
});

test('SiemRouter posts one NDJSON line per alert, token auth when set', async () => {
  const mock = await startMock();
  await withEnv({
    CXTRUST_SIEM_URL: `${mock.base}/hec`,
    CXTRUST_SIEM_TOKEN: 'tok-123',
  }, async () => {
    const router = new SiemRouter();
    const alert = baseAlert('MEDIUM');
    const r = await router.route(alert);
    assert.equal(r.delivered, true);
    assert.equal(mock.requests[0].auth, 'Bearer tok-123');
    const raw = mock.requests[0].body;
    assert.ok(raw.endsWith('\n'));
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 1); // exactly one NDJSON line
    const parsed = JSON.parse(lines[0]) as Alert & { body: string };
    assert.equal(parsed.alertId, 'ALT-1');
    assert.equal(parsed.severity, 'MEDIUM');
    assert.equal(parsed.body, JSON.stringify(alert)); // embedded raw line
  });
  await mock.close();
});

test('Routers without their env var return delivered:false with a clear detail', async () => {
  await withEnv({
    CXTRUST_ALERT_WEBHOOK_URL: undefined,
    CXTRUST_SLACK_WEBHOOK_URL: undefined,
    CXTRUST_TEAMS_WEBHOOK_URL: undefined,
    CXTRUST_SIEM_URL: undefined,
  }, async () => {
    for (const router of [new WebhookRouter(), new SlackRouter(), new TeamsRouter(), new SiemRouter()]) {
      const r = await router.route(baseAlert());
      assert.equal(r.delivered, false, router.id);
      assert.ok((r.detail ?? '').includes('not set'), router.id);
    }
  });
});

// ---------- routing rules ----------

test('AlertRules filter by severity per channel', async () => {
  assert.ok(severityAtLeast('HIGH', 'HIGH'));
  assert.ok(!severityAtLeast('MEDIUM', 'HIGH'));
  assert.ok(severityAtLeast('CRITICAL', 'MEDIUM'));

  // webhook gets all
  assert.equal(rulesAllow(DEFAULT_RULES, 'webhook', baseAlert('LOW')).allowed, true);
  // slack >= HIGH
  assert.equal(rulesAllow(DEFAULT_RULES, 'slack', baseAlert('MEDIUM')).allowed, false);
  assert.equal(rulesAllow(DEFAULT_RULES, 'slack', baseAlert('HIGH')).allowed, true);
  // teams >= CRITICAL
  assert.equal(rulesAllow(DEFAULT_RULES, 'teams', baseAlert('HIGH')).allowed, false);
  assert.equal(rulesAllow(DEFAULT_RULES, 'teams', baseAlert('CRITICAL')).allowed, true);
  // siem >= MEDIUM
  assert.equal(rulesAllow(DEFAULT_RULES, 'siem', baseAlert('LOW')).allowed, false);
  assert.equal(rulesAllow(DEFAULT_RULES, 'siem', baseAlert('MEDIUM')).allowed, true);
});

test('AlertRules filter by organization', async () => {
  const rules = { ...DEFAULT_RULES, organizations: ['org-a'] };
  assert.equal(rulesAllow(rules, 'webhook', baseAlert('LOW', 'org-a')).allowed, true);
  const denied = rulesAllow(rules, 'webhook', baseAlert('LOW', 'org-b'));
  assert.equal(denied.allowed, false);
});

test('AlertManager records filtered-by-rules attempts with detail', async () => {
  const mock = await startMock();
  await withEnv({ CXTRUST_ALERT_WEBHOOK_URL: `${mock.base}/hook` }, async () => {
    const manager = new AlertManager([new WebhookRouter()], {
      severityThresholds: { webhook: 'HIGH' },
    });
    manager.enqueue(baseAlert('LOW'));
    const recs = await manager.flush();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].alertType, 'INCIDENT_OPENED');
    assert.equal(recs[0].routedTo[0].delivered, false);
    assert.equal(recs[0].routedTo[0].detail, 'filtered by rules');
    assert.equal(mock.requests.length, 0); // nothing sent
    assert.ok(recs[0].dispatchedAt.length > 0);
  });
  await mock.close();
});

// ---------- adapters ----------

test('alertFromIncident maps governance incident fields onto an Alert', () => {
  const alert = alertFromIncident({
    incidentId: 'INC-9',
    organizationId: 'org-x',
    interactionId: 'INT-9',
    title: 'Synthetic voice detected',
    severity: 'HIGH',
    status: 'OPEN',
    openedAt: '2026-09-21T00:00:00.000Z',
    summary: 'Block due to synthetic voice',
    detections: ['D1'],
    enforcementActions: ['DENY'],
  });
  assert.equal(alert.alertType, 'INCIDENT_OPENED');
  assert.equal(alert.severity, 'HIGH');
  assert.equal(alert.incidentId, 'INC-9');
  assert.equal(alert.interactionId, 'INT-9');
  assert.equal(alert.organizationId, 'org-x');
  assert.equal(alert.createdAt, '2026-09-21T00:00:00.000Z');
  assert.equal(alert.payload.status, 'OPEN');
  assert.deepEqual(alert.payload.enforcementActions, ['DENY']);
});

test('alertFromDecision maps a policy decision to a POLICY_BLOCK alert with risk-derived severity', () => {
  const decision = {
    decisionId: 'DEC-1',
    interactionId: 'INT-1',
    matchedRule: 'R001_SYNTHETIC_VOICE_BLOCK',
    allowed: false,
    reasons: ['synthetic voice'],
    actions: ['DENY'],
    decidedAt: '2026-09-21T01:00:00.000Z',
  };
  const alert = alertFromDecision(decision, 87, 'org-q');
  assert.equal(alert.alertType, 'POLICY_BLOCK');
  assert.equal(alert.severity, 'CRITICAL'); // 87 >= 80
  assert.equal(alert.riskScore, 87);
  assert.equal(alert.organizationId, 'org-q');
  assert.equal(alert.payload.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK');
  assert.equal(alertFromDecision(decision, 10).severity, 'LOW');
  assert.equal(alertFromDecision(decision, 65).severity, 'HIGH');
});

// ---------- AlertManager records ----------

test('AlertManager dispatch records routedTo across multiple routers', async () => {
  const mock = await startMock();
  await withEnv({ CXTRUST_SLACK_WEBHOOK_URL: `${mock.base}/slack` }, async () => {
    const manager = new AlertManager([new SlackRouter('slack'), new TeamsRouter('teams')], {
      severityThresholds: { slack: 'LOW', teams: 'LOW' },
    });
    manager.enqueue(baseAlert('MEDIUM'));
    const recs = await manager.flush();
    assert.equal(recs.length, 1);
    const routed = recs[0].routedTo;
    assert.equal(routed.length, 2);
    assert.ok(routed.find(r => r.routerId === 'slack')?.delivered === true);
    assert.ok(routed.find(r => r.routerId === 'teams')?.delivered === false);
    assert.equal(mock.requests.length, 1);
    const h = manager.health();
    assert.equal(h.queued, 0);
    assert.equal(h.dispatched, 1);
  });
  await mock.close();
});

// ---------- end-to-end through the API ----------

test('end-to-end: createApi with CXTRUST_ALERTING=on dispatches INCIDENT_OPENED to mock webhook', async () => {
  const mock = await startMock();
  await withEnv({
    CXTRUST_ALERTING: 'on',
    CXTRUST_ALERT_WEBHOOK_URL: `${mock.base}/hook`,
    CXTRUST_ALERT_SIGNING_SECRET: 'e2e-secret',
  }, async () => {
    const store = new SqliteStore(':memory:');
    const server = createApi({ port: 0, store });
    await new Promise<void>(resolve => server.listen(0, () => resolve()));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      // start a governed interaction
      const start = await fetch(`${base}/v1/interactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org-e2e' }),
      });
      assert.equal(start.status, 201);
      const { interactionId } = (await start.json()) as { interactionId: string };

      // register a participant with unknown identity
      await fetch(`${base}/v1/interactions/${interactionId}/participant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          participantId: 'p-caller', interactionId, organizationId: 'org-e2e',
          kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
          authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
        }),
      });

      // synthetic voice signal
      await fetch(`${base}/v1/interactions/${interactionId}/voice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          participantId: 'p-caller', syntheticProbability: 0.97,
          replayProbability: 0.01, impersonationProbability: 0.9,
        }),
      });

      // blocked action scenario
      const act = await fetch(`${base}/v1/interactions/${interactionId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestedAction: 'CHANGE_BANK_ACCOUNT', participantId: 'p-caller',
          intent: 'CHANGE_BANK_ACCOUNT',
        }),
      });
      assert.equal(act.status, 200);

      // alerts are fire-and-record; poll the mock webhook briefly
      const deadline = Date.now() + 5_000;
      while (mock.requests.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(mock.requests.length >= 1, 'webhook should have received at least one alert');
      const alert = JSON.parse(mock.requests[0].body) as Alert;
      assert.equal(alert.alertType, 'INCIDENT_OPENED');
      assert.equal(alert.interactionId, interactionId);
      assert.ok(alert.incidentId, 'incident id present');
      assert.equal(alert.organizationId, 'org-e2e');
      assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(alert.severity));
      assert.ok(alert.title.length > 0);
      assert.ok(alert.createdAt);
      assert.equal(typeof alert.payload, 'object');
      // signed with the known secret
      const expect = createHmac('sha256', 'e2e-secret').update(mock.requests[0].body).digest('hex');
      assert.equal(mock.requests[0].headers['x-cxtrust-signature'], expect);

      // no duplicate dispatch after a second persist (end the interaction)
      const countAfterFirst = mock.requests.length;
      await fetch(`${base}/v1/interactions/${interactionId}/end`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 150));
      assert.equal(mock.requests.length, countAfterFirst, 'no re-dispatch for already-seen incidents');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  await mock.close();
});
