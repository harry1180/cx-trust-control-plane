// Voice trust: reference helper mapping provider outputs to classification
// inputs. Kept separate so real provider adapters land here without touching
// the fusion/policy layers.

export interface VoiceAnalysis {
  syntheticProbability: number;
  replayProbability: number;
  impersonationProbability: number;
}

/** Decide voice-derived flags for a participant given provider output. */
export function voiceFlags(a: VoiceAnalysis) {
  return {
    isSynthetic: a.syntheticProbability > 0.85,
    isReplay: a.replayProbability > 0.8,
    isSuspectVoice: a.syntheticProbability > 0.5 || a.impersonationProbability > 0.6,
  };
}
