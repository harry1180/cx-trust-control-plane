/**
 * Plugin compatibility checking against the platform version.
 *
 * PLATFORM_VERSION is a plain constant here (1.0.0). The comparison is a
 * NAIVE semver parse: dotted numeric parts, compare major/minor/patch in
 * order. Prerelease suffixes (-rc.1, +build) are stripped and ignored.
 * Documented limitation: '1.0.0-rc1' compares equal to '1.0.0'.
 */
export const PLATFORM_VERSION = '1.0.0';

/** Parse 'x.y.z' (extra suffix stripped). Returns null when not parseable. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 when a < b, 0 when equal, 1 when a > b. Unparseable -> null. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/** Plugin min-version must be satisfied by the current platform. */
export function isCompatible(cxtrustMinVersion: string): boolean {
  const cmp = compareVersions(PLATFORM_VERSION, cxtrustMinVersion);
  if (cmp === null) return false; // unparseable version -> fail closed
  return cmp >= 0;
}
