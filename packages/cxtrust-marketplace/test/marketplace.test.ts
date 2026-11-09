// Marketplace package tests: registry, permissions, compat, example plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MarketplaceRegistry,
  signManifest,
  installPlugin,
  riskFlags,
  isCompatible,
  compareVersions,
  PLATFORM_VERSION,
  SIMULATED_VOICE_ANALYZER_MANIFEST,
  createSimulatedVoiceAnalyzer,
  type PluginManifest,
} from '../src/index.ts';
import { PassportIssuer } from '@cxtrust/passport';

const issuer = new PassportIssuer('marketplace-test-ca');
const KEY = issuer.createSigningKey('mk-1');

test('unsigned publish lands unverified and is not installable', () => {
  const reg = new MarketplaceRegistry();
  const entry = reg.publish({ ...SIMULATED_VOICE_ANALYZER_MANIFEST } as PluginManifest);
  assert.equal(entry.status, 'unverified');
  assert.ok(entry.reason);
  const record = installPlugin(entry.manifest, entry.status, { approver: 'ops@acme' });
  assert.equal(record.status, 'blocked');
  assert.match(record.reason ?? '', /only verified plugins/);
});

test('signed publish verifies, then installs with approver + justification', () => {
  const reg = new MarketplaceRegistry();
  reg.keyring.addIssuer(issuer);
  const signed = signManifest(SIMULATED_VOICE_ANALYZER_MANIFEST, issuer, KEY);
  const entry = reg.publish(signed);
  assert.equal(entry.status, 'verified', entry.reason);
  assert.equal(reg.verifyPlugin(signed).valid, true);
  // audio-access is risky -> justification required
  const noJust = installPlugin(signed, entry.status, { approver: 'ops@acme' });
  assert.equal(noJust.status, 'blocked');
  assert.match(noJust.reason ?? '', /justification/);
  const ok = installPlugin(signed, entry.status, { approver: 'ops@acme', justification: 'demo pilot, egress reviewed' });
  assert.equal(ok.status, 'installed');
  assert.equal(ok.approver, 'ops@acme');
  assert.equal(ok.justification, 'demo pilot, egress reviewed');
  // tampered signature is rejected
  const tampered = { ...signed, signature: { ...signed.signature!, detachedSignature: Buffer.alloc(64).toString('base64') } };
  assert.equal(reg.verifyPlugin(tampered).valid, false);
  assert.equal(reg.verifyPlugin(tampered).reason, 'signature mismatch');
});

test('unknown issuer key and wrong-algorithm signatures rejected', () => {
  const reg = new MarketplaceRegistry();
  const signed = signManifest(SIMULATED_VOICE_ANALYZER_MANIFEST, issuer, KEY);
  assert.match(reg.verifyPlugin(signed).reason ?? '', /unknown issuer key/);
  const bad = { ...signed, signature: { ...signed.signature!, algorithm: 'rsa' as never } };
  assert.match(reg.verifyPlugin(bad).reason ?? '', /unsupported signature algorithm/);
});

test('risky permission without justification -> blocked with reason listing permissions', () => {
  const manifest: PluginManifest = {
    ...SIMULATED_VOICE_ANALYZER_MANIFEST,
    permissions: ['network-egress', 'audio-access'],
  } as PluginManifest;
  const flags = riskFlags(manifest);
  assert.deepEqual(flags.map(f => f.permission).sort(), ['audio-access', 'network-egress']);
  const rec = installPlugin(manifest, 'verified', { approver: 'a@b' });
  assert.equal(rec.status, 'blocked');
  assert.match(rec.reason ?? '', /network-egress, audio-access|audio-access, network-egress/);
});

test('no approver identity -> blocked', () => {
  const rec = installPlugin({ ...SIMULATED_VOICE_ANALYZER_MANIFEST } as PluginManifest, 'verified', { approver: '   ' });
  assert.equal(rec.status, 'blocked');
  assert.match(rec.reason ?? '', /approver/);
});

test('compat: min version > platform -> reject; <= -> accept; unparseable -> reject', () => {
  assert.equal(PLATFORM_VERSION, '1.0.0');
  assert.equal(isCompatible('0.9.9'), true);
  assert.equal(isCompatible('1.0.0'), true);
  assert.equal(isCompatible('1.0.1'), false);
  assert.equal(isCompatible('2.0.0'), false);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(isCompatible('not-a-version'), false);
});

test('example plugin factory returns VoiceAnalyzer shape (DEMO, not production forensics)', () => {
  const va = createSimulatedVoiceAnalyzer();
  assert.match(va.id, /DEMO — NOT production voice forensics/);
  const clean = va.analyze({ contactId: 'c1', customerPhoneNumber: '+15550001234' });
  assert.deepEqual(clean, { syntheticProbability: 0.02, replayProbability: 0.01, impersonationProbability: 0.05 });
  const spoof = va.analyze({ contactId: 'c2', customerPhoneNumber: '+155****1111' });
  assert.equal(spoof.syntheticProbability, 0.97);
  assert.ok(spoof.syntheticProbability <= 1 && spoof.impersonationProbability >= 0);
});
