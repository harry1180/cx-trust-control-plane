/**
 * @cxtrust/marketplace — third-party plugin discovery, trust verification,
 * and guarded installation.
 */
export {
  MarketplaceRegistry,
  MarketplaceKeyring,
  manifestDigest,
  unsignedManifest,
  signManifest,
  type PluginManifest,
  type PluginKind,
  type PluginPermission,
  type PluginSignature,
  type PluginStatus,
  type PluginEntry,
  type VerifyResult,
} from './registry.ts';
export {
  RISKY_PERMISSIONS,
  riskFlags,
  installPlugin,
  type RiskDescriptor,
  type InstallOptions,
  type PluginInstallRecord,
} from './permissions.ts';
export {
  PLATFORM_VERSION,
  isCompatible,
  compareVersions,
  parseVersion,
} from './compat.ts';
export {
  SIMULATED_VOICE_ANALYZER_MANIFEST,
  createSimulatedVoiceAnalyzer,
} from './example_plugin.ts';
