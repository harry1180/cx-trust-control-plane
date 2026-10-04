// Feature flags: defaults, env override, no-arg allFlags snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagEnabled, allFlags, FLAG_DEFAULTS, type FlagName } from '../src/flags.ts';

test('defaults: detectors on, heavy ML off', () => {
  assert.equal(flagEnabled('ENABLE_PII_GOVERNANCE'), true);
  assert.equal(flagEnabled('ENABLE_AUTHORITY_CHECK'), true);
  assert.equal(flagEnabled('ENABLE_DIARIZATION'), false);
  assert.equal(flagEnabled('ENABLE_AUDIOSEAL'), false);
});

test('env override wins over default', () => {
  process.env.ENABLE_DIARIZATION = 'true';
  assert.equal(flagEnabled('ENABLE_DIARIZATION'), true);
  process.env.ENABLE_PII_GOVERNANCE = 'off';
  assert.equal(flagEnabled('ENABLE_PII_GOVERNANCE'), false);
  process.env.ENABLE_AUDIOSEAL = '1';
  assert.equal(flagEnabled('ENABLE_AUDIOSEAL'), true);
  delete process.env.ENABLE_DIARIZATION;
  delete process.env.ENABLE_PII_GOVERNANCE;
  delete process.env.ENABLE_AUDIOSEAL;
  assert.equal(flagEnabled('ENABLE_DIARIZATION'), false); // restored
});

test('allFlags returns every flag with source attribution', () => {
  const flags = allFlags();
  assert.equal(flags.length, Object.keys(FLAG_DEFAULTS).length);
  for (const f of flags) {
    assert.ok(['default', 'env'].includes(f.source));
    assert.equal(typeof f.enabled, 'boolean');
  }
  const names = flags.map(f => f.name) as FlagName[];
  assert.ok(names.includes('ENABLE_RAG_GOVERNANCE'));
});