// Feature flags — env-configurable, safe defaults, no hard-coded behavior.
// Read once per call (cheap); every governance subsystem checks its flag at
// runtime so deployments can toggle capabilities without code changes.

export type FlagName =
  | 'ENABLE_PII_GOVERNANCE'
  | 'ENABLE_PROMPT_INJECTION'
  | 'ENABLE_AUTHORITY_CHECK'
  | 'ENABLE_TOOL_GOVERNANCE'
  | 'ENABLE_RAG_GOVERNANCE'
  | 'ENABLE_DIARIZATION'
  | 'ENABLE_DEEPFAKE_DETECTION'
  | 'ENABLE_VOICE_BIOMARKERS'
  | 'ENABLE_AUDIOSEAL'
  | 'ENABLE_TEST_LAB'
  | 'ENABLE_EXTERNAL_CONNECTORS'
  | 'ENABLE_OPENLIT'
  | 'ENABLE_LIVE_ASR_ROUTER';

/** Defaults: governance detectors ON (they are the product); heavy ML OFF. */
export const FLAG_DEFAULTS: Record<FlagName, boolean> = {
  ENABLE_PII_GOVERNANCE: true,
  ENABLE_PROMPT_INJECTION: true,
  ENABLE_AUTHORITY_CHECK: true,
  ENABLE_TOOL_GOVERNANCE: true,
  ENABLE_RAG_GOVERNANCE: true,
  ENABLE_DIARIZATION: false,
  ENABLE_DEEPFAKE_DETECTION: false,
  ENABLE_VOICE_BIOMARKERS: true,
  ENABLE_AUDIOSEAL: false,
  ENABLE_TEST_LAB: true,
  ENABLE_EXTERNAL_CONNECTORS: false,
  ENABLE_OPENLIT: false,
  ENABLE_LIVE_ASR_ROUTER: false,
};

/** Resolve one flag: env value ('true'/'1'/'on' vs 'false'/'0'/'off') > default. */
export function flagEnabled(name: FlagName): boolean {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (raw === undefined || raw === '') return FLAG_DEFAULTS[name];
  const v = raw.toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return FLAG_DEFAULTS[name];
}

/** All flags with their effective values (for a flags/system UI panel). */
export function allFlags(): { name: FlagName; enabled: boolean; source: 'default' | 'env' }[] {
  return (Object.keys(FLAG_DEFAULTS) as FlagName[]).map(name => {
    const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
    return {
      name,
      enabled: flagEnabled(name),
      source: raw === undefined || raw === '' ? 'default' : 'env',
    };
  });
}