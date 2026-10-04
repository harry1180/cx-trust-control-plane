// Marketplace — third-party plugin catalog read from the CX Trust API.
//
// Posture: every plugin is permission-declared and signature-verified; the
// registry verifies detached Ed25519 signatures against trusted issuer keys,
// and risky permissions (audio-access, policy-evaluate, pii-tokenize → HIGH;
// network-egress, incident-write → MEDIUM) require an explicit approver and a
// recorded justification before install.
//
// NOTE on shape: GET /v1/marketplace maps each entry to
// { id, name, kind, author, status, permissions, riskFlags, reason }.
// version/description are declared optional here so the card renders them if
// the API starts including them without breaking on the current response.

import { apiGet, ApiOffline } from '../lib/api';
import PublishForm from './PublishForm';

type PluginKind = 'connector' | 'threat-pack' | 'voice-analyzer' | 'alert-router' | 'policy-pack';
type PluginStatus = 'unverified' | 'verified' | 'rejected';
type RiskLevel = 'HIGH' | 'MEDIUM';

interface RiskFlag {
  permission: string;
  risk: RiskLevel;
  reason: string;
}

interface Plugin {
  id: string;
  name: string;
  version?: string;
  kind: PluginKind;
  author: { name: string; organizationId: string };
  description?: string;
  status: PluginStatus;
  permissions: string[];
  riskFlags?: RiskFlag[];
  reason?: string;
}

// Example manifest (from @cxtrust/marketplace's SIMULATED_VOICE_ANALYZER_MANIFEST).
// Inlined as a plain string so the browser bundle never imports the package.
const EXAMPLE_MANIFEST = JSON.stringify(
  {
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
  },
  null,
  2,
);

const KIND_PILL: Record<PluginKind, string> = {
  connector: 'pill-blue',
  'threat-pack': 'pill-purple',
  'voice-analyzer': 'pill-green',
  'alert-router': 'pill-blue',
  'policy-pack': 'pill-gray',
};

const STATUS_PILL: Record<PluginStatus, string> = {
  verified: 'pill-green',
  unverified: 'pill-amber',
  rejected: 'pill-red',
};

function permissionPillClass(permission: string, flags: RiskFlag[]): string {
  const flag = flags.find(f => f.permission === permission);
  if (!flag) return 'pill-gray';
  return flag.risk === 'HIGH' ? 'pill-red' : 'pill-amber';
}

export default async function MarketplacePage() {
  const data = await apiGet<{ platformVersion?: string; plugins: Plugin[] }>('/v1/marketplace');
  if (!data) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 4 }}>Marketplace</h2>
        <ApiOffline path="/v1/marketplace" />
      </div>
    );
  }

  const plugins = data.plugins ?? [];
  const verified = plugins.filter(p => p.status === 'verified').length;
  const unverified = plugins.filter(p => p.status === 'unverified').length;

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Marketplace</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Third-party plugin catalog from the CX Trust API{data.platformVersion ? ` (platform v${data.platformVersion})` : ''}.
        Plugins are permission-declared and signature-verified; risky permissions require an approver
        and a recorded justification before install.
      </p>

      <div className="statgrid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 16 }}>
        <div className="stat"><div className="num">{plugins.length}</div><div className="lbl">Total Plugins</div></div>
        <div className="stat"><div className="num" style={{ color: 'var(--green)' }}>{verified}</div><div className="lbl">Verified</div></div>
        <div className="stat"><div className="num" style={{ color: 'var(--amber)' }}>{unverified}</div><div className="lbl">Unverified</div></div>
      </div>

      {plugins.length === 0 && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <h3>No plugins published yet</h3>
          <p style={{ color: 'var(--dim)', fontSize: 13, marginTop: 6 }}>
            Publish the first one with a signed manifest:
          </p>
          <pre className="mono" style={{ margin: '10px 0', color: 'var(--text)', background: 'var(--bg2)', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap' }}>
POST /v1/marketplace/publish — body: PluginManifest JSON with a detached
Ed25519 `signature` block (issuerKeyId, algorithm, detachedSignature).
Unsigned manifests land in `unverified` and are never auto-installed.
          </pre>
          <p style={{ color: 'var(--dim)', fontSize: 12 }}>
            Or use the form below to publish the example manifest, then re-run the demo signature
            flow (see packages/cxtrust-marketplace tests) to see the verified path.
          </p>
        </div>
      )}

      {plugins.map(p => {
        const flags = p.riskFlags ?? [];
        return (
          <div key={p.id} className="panel" style={{ marginBottom: 12, borderColor: p.status === 'rejected' ? 'var(--red)' : undefined }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontWeight: 700 }}>{p.name}</span>
              {p.version && <span className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>v{p.version}</span>}
              <span className={`pill ${KIND_PILL[p.kind] ?? 'pill-gray'}`}>{p.kind}</span>
              <span className={`pill ${STATUS_PILL[p.status] ?? 'pill-gray'}`}>{p.status}</span>
              <span className="mono" style={{ fontSize: 12, color: 'var(--dim)', marginLeft: 'auto' }}>{p.id}</span>
            </div>
            <p style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 6 }}>
              by {p.author?.name ?? 'unknown'} ({p.author?.organizationId ?? 'no org'})
            </p>
            {p.description && <p style={{ fontSize: 13, marginBottom: 8 }}>{p.description}</p>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
              {p.permissions.map(perm => (
                <span key={perm} className={`pill ${permissionPillClass(perm, flags)} mono`} title={
                  flags.find(f => f.permission === perm)?.reason
                }>{perm}</span>
              ))}
            </div>
            {flags.filter(f => f.risk === 'HIGH' || f.risk === 'MEDIUM').map(f => (
              <p key={f.permission} style={{ color: f.risk === 'HIGH' ? 'var(--red)' : 'var(--amber)', fontSize: 12, marginBottom: 4 }}>
                {f.risk} risk — {f.permission}: {f.reason}
              </p>
            ))}
            {p.reason && (
              <p style={{ color: 'var(--dim)', fontSize: 12, marginBottom: 4 }} className="mono">verification note: {p.reason}</p>
            )}
            <p style={{ color: 'var(--dim)', fontSize: 11, marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              Security posture: plugins are permission-declared and signature-verified; risky permissions
              require an approver identity and a recorded justification before install.
            </p>
          </div>
        );
      })}

      <PublishForm initialManifest={EXAMPLE_MANIFEST} />
    </div>
  );
}
