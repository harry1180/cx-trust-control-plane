// End-to-end HTTP smoke test for the CX Trust API.
// Usage: node test/smoke_e2e.mjs [baseUrl]  (default http://127.0.0.1:8790)
import assert from 'node:assert/strict';

const BASE = process.argv[2] || `http://127.0.0.1:${process.env.CXTRUST_PORT || 8790}`;
let passed = 0, failed = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`PASS  ${name}`); })
    .catch(err => { failed++; failures.push(name); console.log(`FAIL  ${name}: ${err.message}`); });
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function main() {
  // 0. health
  await check('healthz', async () => {
    const r = await req('GET', '/healthz');
    assert.equal(r.status, 200);
  });

  // 1. start session
  let id = '';
  await check('start session', async () => {
    const r = await req('POST', '/v1/interactions', { organizationId: 'org-smoke' });
    assert.equal(r.status, 201, `status ${r.status}`);
    id = String(r.json.interactionId);
    assert.ok(id, 'missing interactionId');
  });

  // 2. register CUSTOMER participant
  await check('register CUSTOMER participant', async () => {
    const r = await req('POST', `/v1/interactions/${id}/participant`, {
      participantId: 'p-smoke', interactionId: id, organizationId: 'org-smoke',
      kind: 'CUSTOMER', classification: 'HUMAN_UNKNOWN', identityConfidence: 0.3,
      authLevel: 'NONE', joinedAtOffsetS: 0, riskState: {},
    });
    assert.equal(r.status, 200, `status ${r.status}`);
  });

  // 3. voice analysis
  await check('voice analysis (synthetic 0.97)', async () => {
    const r = await req('POST', `/v1/interactions/${id}/voice`, {
      participantId: 'p-smoke', syntheticProbability: 0.97,
      replayProbability: 0.01, impersonationProbability: 0.9,
    });
    assert.equal(r.status, 200, `status ${r.status}`);
  });

  // 4. two transcript turns
  await check('transcript turns', async () => {
    const t1 = await req('POST', `/v1/interactions/${id}/turns`, {
      participantId: 'p-smoke', text: 'I need to recover my account right now.', offsetS: 8,
    });
    assert.equal(t1.status, 200, `turn1 status ${t1.status}`);
    const t2 = await req('POST', `/v1/interactions/${id}/turns`, {
      participantId: 'p-smoke', text: 'Change my bank account and move my funds today.', offsetS: 16,
    });
    assert.equal(t2.status, 200, `turn2 status ${t2.status}`);
  });

  // 5. action -> blocked by R001
  await check('action blocked by R001_SYNTHETIC_VOICE_BLOCK', async () => {
    const r = await req('POST', `/v1/interactions/${id}/actions`, {
      requestedAction: 'CHANGE_BANK_ACCOUNT', participantId: 'p-smoke', intent: 'CHANGE_BANK_ACCOUNT',
    });
    assert.equal(r.status, 200, `status ${r.status}`);
    const decision = r.json.decision;
    assert.equal(decision.matchedRule, 'R001_SYNTHETIC_VOICE_BLOCK', `matchedRule=${decision.matchedRule}`);
    assert.equal(decision.allowed, false, 'allowed should be false');
  });

  // 6. evidence chain valid
  await check('evidence chainValid', async () => {
    const r = await req('GET', `/v1/interactions/${id}/evidence`);
    assert.equal(r.status, 200, `status ${r.status}`);
    assert.equal(r.json.chainValid, true, `chainValid=${r.json.chainValid}`);
  });

  // 7. timeline non-empty
  await check('timeline non-empty', async () => {
    const r = await req('GET', `/v1/interactions/${id}/timeline`);
    assert.equal(r.status, 200, `status ${r.status}`);
    assert.ok(Array.isArray(r.json.timeline) && r.json.timeline.length > 0, 'timeline empty');
  });

  // 8. usage governed >= 1
  await check('usage org-smoke governed >= 1', async () => {
    const r = await req('GET', '/v1/usage/org-smoke');
    assert.equal(r.status, 200, `status ${r.status}`);
    assert.ok(Number(r.json.governed) >= 1, `governed=${r.json.governed}`);
  });

  // 9. end session, then re-GET interaction (persistence)
  await check('end + persistence re-GET', async () => {
    const e = await req('POST', `/v1/interactions/${id}/end`);
    assert.equal(e.status, 200, `end status ${e.status}`);
    const g = await req('GET', `/v1/interactions/${id}`);
    assert.equal(g.status, 200, `re-GET status ${g.status}`);
    assert.ok(g.json.interaction, 'interaction record missing after end');
  });

  // 10. scenario agent-over-limit -> some decision has REQUIRE_APPROVAL
  await check('scenario agent-over-limit REQUIRE_APPROVAL', async () => {
    const r = await req('POST', '/v1/scenarios/agent-over-limit', {});
    assert.equal(r.status, 200, `status ${r.status}`);
    const decisions = r.json.decisions || [];
    const hit = decisions.some(d =>
      [d.action, d.decision && d.decision.action].includes('REQUIRE_APPROVAL') ||
      (Array.isArray(d.actions) && d.actions.includes('REQUIRE_APPROVAL')) ||
      (d.decision && Array.isArray(d.decision.actions) && d.decision.actions.includes('REQUIRE_APPROVAL')));
    assert.ok(hit, 'no decision with REQUIRE_APPROVAL; got: ' + JSON.stringify(decisions).slice(0, 300));
  });

  const total = passed + failed;
  if (failed === 0) {
    console.log(`SMOKE OK ${passed}/${total}`);
  } else {
    console.log(`SMOKE FAILED (${failed} failed: ${failures.join(', ')})`);
    process.exit(1);
  }
}

main().catch(err => {
  console.log(`SMOKE FAILED (unhandled: ${err && err.stack || err})`);
  process.exit(1);
});
