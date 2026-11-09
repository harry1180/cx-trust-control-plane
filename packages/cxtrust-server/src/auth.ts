// RBAC + multi-tenant isolation for the CX Trust API.
//
// Token model:
//   CXTRUST_ADMIN_TOKENS   comma-separated bootstrap admin tokens
//   CXTRUST_ORG_TOKENS     comma-separated `<token>:<organizationId>:<role>`
//                          entries (roles: ADMIN, SECURITY_ANALYST,
//                          CX_ANALYST, SERVICE)
// When neither env var is set, auth is disabled (current behavior).
//
// Multi-tenant rule: org-scoped reads of another org's data return 404
// (never 403) so callers cannot probe for the existence of foreign rows.

export type Role = 'ADMIN' | 'SECURITY_ANALYST' | 'CX_ANALYST' | 'SERVICE';

export type Permission =
  | 'interactions:list'
  | 'interactions:read'
  | 'interactions:write'
  | 'turns:write'
  | 'voice:write'
  | 'auth:write'
  | 'actions:write'
  | 'participant:write'
  | 'end:write'
  | 'timeline:read'
  | 'evidence:read'
  | 'decisions:read'
  | 'incidents:read'
  | 'incidents:write'
  | 'usage:read'
  | 'agents:read'
  | 'policy:read'
  | 'scenarios:read'
  | 'scenarios:run'
  | 'tokens:read';

export interface TokenRecord {
  token: string;
  organizationId: string;
  role: Role;
  label?: string;
}

export interface RbacConfig {
  adminTokens?: string[];
  orgTokens?: string[];
}

export interface Caller {
  organizationId: string; // '*' for bootstrap ADMIN tokens
  role: Role;
  tokenId: string;
}

export interface AuthResult {
  ok: boolean;
  caller?: Caller;
  denyResponse?: { status: number; body: unknown };
}

// ---------- RBAC matrix (data table) ----------

// Granted per role; ADMIN is implicitly granted everything.
export const ROLE_PERMISSIONS: Record<Exclude<Role, 'ADMIN'>, Permission[]> = {
  SECURITY_ANALYST: [
    'interactions:list', 'interactions:read', 'timeline:read', 'evidence:read',
    'decisions:read', 'incidents:read', 'usage:read', 'agents:read',
    'policy:read', 'scenarios:read',
  ],
  CX_ANALYST: [
    'interactions:list', 'interactions:read', 'timeline:read', 'usage:read',
    'agents:read', 'policy:read', 'scenarios:read',
  ],
  SERVICE: [
    'interactions:read', 'interactions:write', 'turns:write', 'voice:write',
    'auth:write', 'actions:write', 'participant:write', 'end:write',
  ],
};

export function can(role: Role, permission: Permission): boolean {
  if (role === 'ADMIN') return true;
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

// ---------- route class -> required permission ----------

export const ROUTE_PERMISSIONS: Record<string, Permission> = {
  'GET /v1/agents': 'agents:read',
  'GET /v1/scenarios': 'scenarios:read',
  'GET /v1/policy': 'policy:read',
  'GET /v1/incidents': 'incidents:read',
  'GET /v1/usage/{orgId}': 'usage:read',
  'GET /v1/tokens': 'tokens:read',
  'GET /v1/interactions': 'interactions:list',
  'GET /v1/interactions/{id}': 'interactions:read',
  'GET /v1/interactions/{id}/timeline': 'timeline:read',
  'GET /v1/interactions/{id}/evidence': 'evidence:read',
  'GET /v1/interactions/{id}/decisions': 'decisions:read',
  'GET /v1/interactions/{id}/replay': 'evidence:read',
  'POST /v1/interactions': 'interactions:write',
  'POST /v1/interactions/{id}/turns': 'turns:write',
  'POST /v1/interactions/{id}/voice': 'voice:write',
  'POST /v1/interactions/{id}/auth': 'auth:write',
  'POST /v1/interactions/{id}/actions': 'actions:write',
  'POST /v1/interactions/{id}/participant': 'participant:write',
  'POST /v1/interactions/{id}/end': 'end:write',
  'POST /v1/scenarios/{id}': 'scenarios:run',
};

/** Resolve the route class for a request; undefined = unknown route. */
export function routeClass(method: string, parts: string[]): string | undefined {
  const [a, b, c, d] = parts;
  if (method === 'GET' && a === 'v1') {
    if (b === 'agents') return 'GET /v1/agents';
    if (b === 'policy') return 'GET /v1/policy';
    if (b === 'incidents') return 'GET /v1/incidents';
    if (b === 'tokens') return 'GET /v1/tokens';
    if (b === 'usage' && c) return 'GET /v1/usage/{orgId}';
    if (b === 'scenarios' && !c) return 'GET /v1/scenarios';
    if (b === 'interactions') {
      if (!c) return 'GET /v1/interactions';
      if (!d) return 'GET /v1/interactions/{id}';
      return `GET /v1/interactions/{id}/${d}`;
    }
  }
  if (method === 'POST' && a === 'v1') {
    if (b === 'interactions') {
      if (!c) return 'POST /v1/interactions';
      if (d) return `POST /v1/interactions/{id}/${d}`;
    }
    if (b === 'scenarios' && c) return 'POST /v1/scenarios/{id}';
  }
  return undefined;
}

// ---------- token registry ----------

export function buildTokenRegistry(cfg?: RbacConfig): TokenRecord[] {
  const out: TokenRecord[] = [];
  const adminSrc = cfg?.adminTokens ?? envList('CXTRUST_ADMIN_TOKENS');
  for (const token of adminSrc) out.push({ token, organizationId: '*', role: 'ADMIN' });
  const orgSrc = cfg?.orgTokens ?? envList('CXTRUST_ORG_TOKENS');
  for (const entry of orgSrc) {
    const [token, organizationId, role, label] = entry.split(':').map(s => s?.trim());
    if (!token || !organizationId || !role) continue;
    if (!['ADMIN', 'SECURITY_ANALYST', 'CX_ANALYST', 'SERVICE'].includes(role)) continue;
    out.push({ token, organizationId, role: role as Role, label });
  }
  return out;
}

function envList(name: string): string[] {
  return (process.env[name] ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

export function authEnabled(cfg?: RbacConfig): boolean {
  return buildTokenRegistry(cfg).length > 0;
}

// ---------- request authentication ----------

export function authenticate(req: { headers: Record<string, string | string[] | undefined> }, cfg?: RbacConfig): AuthResult {
  if (!authEnabled(cfg)) return { ok: true };
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, denyResponse: { status: 401, body: { error: 'missing API key' } } };
  }
  const registry = buildTokenRegistry(cfg);
  const rec = registry.find(r => r.token === key);
  if (!rec) {
    return { ok: false, denyResponse: { status: 401, body: { error: 'invalid API key' } } };
  }
  return {
    ok: true,
    caller: { organizationId: rec.organizationId, role: rec.role, tokenId: maskToken(rec.token) },
  };
}

export function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/** Masked token-management view (ADMIN only route). */
export function tokenView(cfg?: RbacConfig): { token: string; organizationId: string; role: Role; label?: string }[] {
  return buildTokenRegistry(cfg).map(r => ({
    token: maskToken(r.token), organizationId: r.organizationId, role: r.role, label: r.label,
  }));
}

/** True when caller may see data for organizationId. */
export function orgAllowed(caller: Caller | undefined, organizationId: string): boolean {
  if (!caller) return true; // auth disabled
  if (caller.role === 'ADMIN') return true;
  return caller.organizationId === organizationId;
}
