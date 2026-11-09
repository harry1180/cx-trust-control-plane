/**
 * Permission risk matrix and guarded installation for marketplace plugins.
 *
 * installPlugin() requires an explicit approver identity and refuses any
 * plugin carrying a RISKY_PERMISSION without a recorded justification string.
 * Every attempt (installed or blocked) produces an auditable
 * PluginInstallRecord.
 */
import type { PluginManifest, PluginPermission } from './registry.ts';
import { isCompatible } from './compat.ts';

export type RiskLevel = 'MEDIUM' | 'HIGH';

export interface RiskDescriptor {
  risk: RiskLevel;
  reason: string;
}

export const RISKY_PERMISSIONS: Record<PluginPermission, RiskDescriptor> = {
  'network-egress': { risk: 'MEDIUM', reason: 'plugin can send data off-site' },
  'audio-access': { risk: 'HIGH', reason: 'plugin can read raw customer audio' },
  'incident-write': { risk: 'MEDIUM', reason: 'plugin can create or mutate incident records' },
  'policy-evaluate': { risk: 'HIGH', reason: 'plugin participates in enforcement decisions' },
  'pii-tokenize': { risk: 'HIGH', reason: 'plugin can read and transform PII tokens' },
};

/** Permissions the manifest declares that carry risk. */
export function riskFlags(manifest: PluginManifest): { permission: PluginPermission; risk: RiskLevel; reason: string }[] {
  const out: { permission: PluginPermission; risk: RiskLevel; reason: string }[] = [];
  for (const p of manifest.permissions) {
    const r = RISKY_PERMISSIONS[p];
    if (r) out.push({ permission: p, risk: r.risk, reason: r.reason });
  }
  return out;
}

export interface InstallOptions {
  /** explicit human approver identity string, e.g. 'ops@acme.example.com' */
  approver: string;
  /** required justification when the plugin carries risky permissions */
  justification?: string;
}

export interface PluginInstallRecord {
  manifest: PluginManifest;
  installedAt: string;
  approver: string;
  justification?: string;
  status: 'installed' | 'blocked';
  reason?: string;
}

/**
 * installPlugin — guarded install. Fails closed:
 *  - no approver identity  -> blocked
 *  - plugin not verified   -> blocked (never auto-install unverified plugins)
 *  - incompatible version  -> blocked
 *  - risky permission w/o recorded justification string -> blocked
 */
export function installPlugin(
  manifest: PluginManifest,
  status: 'unverified' | 'verified' | 'rejected',
  opts: InstallOptions,
): PluginInstallRecord {
  const record: PluginInstallRecord = {
    manifest,
    installedAt: new Date().toISOString(),
    approver: typeof opts.approver === 'string' ? opts.approver.trim() : '',
    ...(opts.justification !== undefined ? { justification: opts.justification } : {}),
    status: 'blocked',
  };
  const block = (reason: string): PluginInstallRecord => ({ ...record, status: 'blocked', reason });
  if (!record.approver) return block('explicit approver identity required');
  if (status !== 'verified') return block(`plugin status is '${status}' — only verified plugins may be installed`);
  if (!isCompatible(manifest.cxtrustMinVersion)) {
    return block(`plugin requires cxtrust >= ${manifest.cxtrustMinVersion}, platform is ${PLATFORM_VERSION_PLACEHOLDER}`);
  }
  const flags = riskFlags(manifest);
  if (flags.length > 0) {
    const just = typeof opts.justification === 'string' ? opts.justification.trim() : '';
    if (!just) {
      return block(
        `risky permissions (${flags.map(f => f.permission).join(', ')}) require a recorded justification`,
      );
    }
  }
  return { ...record, status: 'installed' };
}

import { PLATFORM_VERSION } from './compat.ts';
const PLATFORM_VERSION_PLACEHOLDER = PLATFORM_VERSION;
