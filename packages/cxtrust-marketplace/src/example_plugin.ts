/**
 * DEMO example plugin wired through the whole marketplace pipeline.
 *
 * SimulatedVoiceAnalyzerPlugin — a thin, clearly-labeled DEMO voice analyzer
 * factory that returns the VoiceAnalyzer shape from @cxtrust/connect.
 * NOT production voice forensics: it returns scripted probabilities keyed on
 * the caller's phone number, like @cxtrust/connect's DemoVoiceAnalyzer.
 *
 * The manifest here is the marketplace listing for the plugin (it is signed
 * in tests with a local passport issuer to drive the verified→installed path).
 */
import type { PluginManifest } from './registry.ts';
import type { VoiceAnalyzer, VoiceAnalysis } from '@cxtrust/connect';

export const SIMULATED_VOICE_ANALYZER_MANIFEST: Omit<PluginManifest, 'signature'> = {
  pluginId: 'plugin-simulated-voice-analyzer',
  name: 'SimulatedVoiceAnalyzerPlugin',
  version: '1.0.0',
  kind: 'voice-analyzer',
  author: { name: 'CX Trust Demo Team', organizationId: 'org-demo' },
  description: 'DEMO scripted voice analyzer returning the VoiceAnalyzer seam shape. NOT production voice forensics.',
  homepage: 'https://example.com/cxtrust/simulated-voice-analyzer',
  entrypoint: '@cxtrust/marketplace/example-plugin',
  permissions: ['audio-access'],
  license: 'MIT',
  cxtrustMinVersion: '1.0.0',
};

const SPOOF_NUMBERS = new Set(['+155****1111']);

/**
 * Thin factory: returns a VoiceAnalyzer-compatible object (DEMO — NOT
 * production voice forensics).
 */
export function createSimulatedVoiceAnalyzer(): VoiceAnalyzer {
  return {
    id: 'simulated-voice-analyzer (DEMO — NOT production voice forensics)',
    analyze(input: { customerPhoneNumber?: string }): VoiceAnalysis {
      const spoofed = !!input.customerPhoneNumber && SPOOF_NUMBERS.has(input.customerPhoneNumber);
      return spoofed
        ? { syntheticProbability: 0.97, replayProbability: 0.01, impersonationProbability: 0.9 }
        : { syntheticProbability: 0.02, replayProbability: 0.01, impersonationProbability: 0.05 };
    },
  };
}
