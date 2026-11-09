// Correlate the demo scenario corpus into one ThreatGraph.
//
// DEMO SIGNAL (documented): voiceSignatureHash here is synthetic-provider-based
// — every interaction whose customer voice analysis came back synthetic=true
// shares the same demo hash `synth-demo`. That is the demo's clustering signal,
// NOT a production voiceprint (real voiceprints are per-identity acoustic
// embeddings). To keep the demo honest, the hash is only attached for
// UNREGISTERED synthetic customer personas: registered enterprise agents
// ('verified-agent-passport', 'agent-over-limit') run on synthetic TTS by
// design and must not be welded to fraudster personas, so their interactions
// carry no demo voice hash and stay isolated.

import type { ScenarioDef, GovernanceSnapshot, GovernanceSession } from '@cxtrust/core';
import { runScenario } from '@cxtrust/core';
import { ThreatGraph, type Campaign, type GraphSummary } from './graph.ts';

export interface CorrelationOptions {
  /** Hash assigned to all synthetic (unregistered) caller personas. */
  demoSyntheticVoiceHash?: string;
}

export interface CorrelationResult {
  graph: ThreatGraph;
  /** interactionId -> scenario id */
  scenarioById: Map<string, string>;
  campaigns: Campaign[];
  summary: GraphSummary;
}

const DEMO_SYNTH_VOICE_HASH = 'synth-demo-voice';

/** Run the corpus and feed every snapshot into one shared ThreatGraph. */
export function correlateScenarios(
  defs: ScenarioDef[],
  runFn: (def: ScenarioDef, onSnapshot: (s: GovernanceSnapshot) => void) => { snapshot: GovernanceSnapshot; session: GovernanceSession } = runScenario,
  opts: CorrelationOptions = {},
): CorrelationResult {
  const graph = new ThreatGraph();
  const scenarioById = new Map<string, string>();
  const synthHash = opts.demoSyntheticVoiceHash ?? DEMO_SYNTH_VOICE_HASH;

  for (const def of defs) {
    let snapshot: GovernanceSnapshot | undefined;
    runFn(def, (s) => {
      snapshot = s;
    });
    if (!snapshot) continue;
    // Demo policy: attach the synthetic voice hash only to unregistered
    // synthetic customer personas (registered agents run on TTS by design and
    // must stay isolated from fraudster personas).
    const isSyntheticCustomer = snapshot.participants.some(
      (p) => p.kind === 'CUSTOMER' && (p.riskState.syntheticVoiceProbability ?? 0) > 0.85,
    );
    scenarioById.set(snapshot.interaction.interactionId, def.id);
    graph.addInteraction(snapshot, {
      voiceSignatureHash: isSyntheticCustomer ? synthHash : undefined,
    });
  }

  return { graph, scenarioById, campaigns: graph.findCampaigns(), summary: graph.graphSummary() };
}

export { DEMO_SYNTH_VOICE_HASH };
