// Server-side helper: all console data surfaces read from the CX Trust API
// service. If the API is unreachable the UI renders an explicit offline state
// — no silent fallback to locally-computed data.

export const API_BASE = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
export const API_KEY = process.env.CXTRUST_API_KEY;

export async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: API_KEY ? { 'x-api-key': API_KEY } : {},
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function ApiOffline({ path }: { path: string }) {
  return (
    <div className="panel" style={{ borderColor: 'var(--amber)' }}>
      <h3>API offline</h3>
      <p style={{ color: 'var(--dim)' }}>
        This console reads live data from the CX Trust API ({API_BASE}
        {path}) but the service is not reachable. Start it with:
      </p>
      <pre className="mono" style={{ margin: '10px 0', color: 'var(--text)', background: 'var(--bg2)', padding: 10, borderRadius: 6 }}>
cd packages/cxtrust-server && node src/index.ts
      </pre>
      <p style={{ color: 'var(--dim)', fontSize: 12 }}>
        Then load the demo corpus from the Command Center ("Seed demo corpus" button) or POST
        /v1/scenarios/&#123;id&#125; for each of the 8 scenarios.
      </p>
    </div>
  );
}