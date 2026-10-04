// Security Command Center — reads LIVE data from the CX Trust API.
// Every metric tile is a drill-down filter; every interaction row and every
// incident links into the Investigation Console. Filters are computed
// server-side from the evidence store (Next searchParams — no client JS).

import Link from 'next/link';
import { apiGet, ApiOffline } from './lib/api';
import { RiskBar } from './components';
import SeedButton from './SeedButton';

interface StoredInteraction {
  interactionId: string;
  organizationId: string;
  platform: string;
  channel: string;
  startedAt: string;
  endedAt?: string;
  scenarioLabel?: string;
  metadata?: Record<string, unknown>;
  biomarkers?: {
    emotion?: { activation?: number; confidence?: number; label?: string };
    biomarkers?: { key?: string; value?: number }[];
    limitations?: string[];
  };
  peakRisk: number;
  finalRisk: number;
}

interface Usage {
  governed: number; incidents: number; blockedDecisions: number; highRisk: number;
}

interface Incident {
  incidentId: string; interactionId: string; title: string;
  severity: string; status: string; summary: string;
}

const HIGH_RISK_THRESHOLD = 40; // must match store usageCounts (peakRisk >= 40)

// ---------- drill definitions: key → {title, predicate} ----------

type DrillKey = 'all' | 'high' | 'unknown-ai' | 'deepfake' | 'prompt' | 'blocked';

const DRILLS: Record<DrillKey, { title: string; hint: string; match: (i: StoredInteraction) => boolean }> = {
  all: { title: 'All governed interactions', hint: 'every interaction in the evidence store', match: () => true },
  high: { title: `High risk (peak ≥ ${HIGH_RISK_THRESHOLD})`, hint: 'risk fusion flagged these during the interaction', match: i => i.peakRisk >= HIGH_RISK_THRESHOLD },
  'unknown-ai': { title: 'Unknown AI callers', hint: 'bot-pattern signals with no registered agent identity', match: i => (i.scenarioLabel ?? '').toLowerCase().includes('unregistered') },
  deepfake: { title: 'Deepfake / synthetic voice', hint: 'voice-trust engine synthetic detections (incl. campaign members)', match: i => /deepfake|campaign/.test((i.scenarioLabel ?? '').toLowerCase()) },
  prompt: { title: 'Prompt injection attempts', hint: 'AI-security engine injections detected in transcript', match: i => (i.scenarioLabel ?? '').toLowerCase().includes('prompt') },
  blocked: { title: 'Interactions with enforcement records', hint: 'at least one policy DENY escalated to an incident', match: () => true }, // refined below with incident ids
};

function parseDrill(raw: string | string[] | undefined): DrillKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && v in DRILLS ? (v as DrillKey) : 'all';
}

export default async function CommandCenter({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const drill = parseDrill(sp.drill);
  const platformFilter = (Array.isArray(sp.platform) ? sp.platform[0] : sp.platform) ?? undefined;

  const [interactions, usage, incidents] = await Promise.all([
    apiGet<{ interactions: StoredInteraction[] }>('/v1/interactions'),
    apiGet<Usage>('/v1/usage/org-demo'),
    apiGet<{ incidents: Incident[] }>('/v1/incidents'),
  ]);

  if (!interactions || !usage) {
    return (
      <div className="page">
        <h2 style={{ marginBottom: 4 }}>Security Command Center</h2>
        <ApiOffline path="/v1/interactions" />
        <SeedButton />
      </div>
    );
  }

  const all = interactions.interactions ?? [];
  const allIncidents = incidents?.incidents ?? [];
  const incidentList = allIncidents.slice(0, 20);
  // Wellbeing watch: interactions carrying voice-biomarker reports, highest
  // activation first (default flag at 75%, env CXTRUST_WELLBEING_ACTIVATION).
  const bmRows = all
    .filter(i => i.biomarkers?.emotion && typeof i.biomarkers.emotion.activation === 'number')
    .sort((a, b) => (b.biomarkers!.emotion!.activation ?? 0) - (a.biomarkers!.emotion!.activation ?? 0))
    .slice(0, 6);
  // Interactions with at least one enforcement escalation recorded.
  const blockedIds = new Set(allIncidents.map(i => i.interactionId));
  const deepfakeish = all.filter(DRILLS.deepfake.match).length;
  const promptInj = all.filter(DRILLS.prompt.match).length;
  const unknownAI = all.filter(DRILLS['unknown-ai'].match).length;
  const agents = await apiGet<{ agents: { agentId: string }[] }>('/v1/agents');

  // Active list for the table: drill filter + optional platform chip.
  const filtered = all.filter(i =>
    (drill === 'blocked' ? blockedIds.has(i.interactionId) : DRILLS[drill].match(i)) &&
    (!platformFilter || i.platform === platformFilter));
  const list = [...filtered].sort((a, b) => b.peakRisk - a.peakRisk).slice(0, 25);
  const isFiltered = drill !== 'all' || !!platformFilter;

  const tiles: { key: string; href: string; num: React.ReactNode; label: string; color?: string }[] = [
    { key: 'gov', href: '/?drill=all', num: usage.governed, label: 'Interactions Governed' },
    { key: 'high', href: '/?drill=high', num: usage.highRisk, label: 'High Risk Interactions', color: 'var(--amber)' },
    { key: 'inc', href: '/incidents', num: usage.incidents, label: 'Incidents', color: 'var(--red)' },
    { key: 'blk', href: '/?drill=blocked', num: usage.blockedDecisions, label: 'Blocked Actions', color: 'var(--red)' },
    { key: 'uai', href: '/?drill=unknown-ai', num: unknownAI, label: 'Unknown AI Callers', color: 'var(--amber)' },
    { key: 'dfk', href: '/?drill=deepfake', num: deepfakeish, label: 'Deepfake / Campaign' },
    { key: 'inj', href: '/?drill=prompt', num: promptInj, label: 'Prompt Injection' },
    { key: 'agt', href: '/agents', num: agents?.agents.length ?? '—', label: 'Registered AI Agents' },
  ];

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Security Command Center</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Live view over the CX Trust API — persisted interactions, incidents, and usage telemetry
        from the evidence store. <span style={{ color: 'var(--text)' }}>Click any metric to drill in.</span>
        <span className="pill pill-gray" style={{ marginLeft: 8 }}>DEMO DATA · {usage.governed} interactions in store</span>
      </p>

      <div className="statgrid">
        {tiles.map(t => (
          <Link key={t.key} href={t.href} style={{ textDecoration: 'none' }}>
            <div className="stat" style={{ cursor: 'pointer', borderColor: drillHrefKey(t.href) === drill && !platformFilter ? 'var(--blue)' : undefined }}>
              <div className="num" style={{ color: t.color }}>{t.num}</div>
              <div className="lbl">{t.label} <span style={{ color: 'var(--blue)', fontSize: 9 }}>▸</span></div>
            </div>
          </Link>
        ))}
      </div>

      <SeedButton />

      <div className="grid3" style={{ marginTop: 16 }}>
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>
              {isFiltered ? DRILLS[drill].title : 'Interactions · risk-ranked'}
              {platformFilter ? ` · ${platformFilter}` : ''}
            </h3>
            {isFiltered ? (
              <Link href="/" className="pill pill-gray" style={{ fontSize: 11, textDecoration: 'none' }}>clear filter ✕</Link>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--dim)' }}>{usage.governed} total · click a tile or platform to filter</span>
            )}
          </div>
          {isFiltered && <div style={{ fontSize: 11, color: 'var(--dim)', margin: '4px 0 8px' }}>{DRILLS[drill].hint}{platformFilter ? ' · platform chip below' : ''}</div>}
          {list.length === 0 && <p style={{ color: 'var(--dim)' }}>No interactions match this filter — seed the demo corpus or run the Attack Simulator.</p>}
          <table className="tbl">
            <thead><tr><th>Interaction</th><th>Label</th><th>Platform</th><th>Risk (peak/final)</th></tr></thead>
            <tbody>
              {list.map(i => (
                <tr key={i.interactionId}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    <Link href={`/investigation/${encodeURIComponent(i.interactionId)}`} style={{ color: 'var(--blue)', textDecoration: 'none' }}>
                      {i.interactionId}
                    </Link>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {i.scenarioLabel ?? '—'}
                    {typeof i.metadata?.initiationMethod === 'string' && (
                      <span className="pill pill-gray mono" style={{ fontSize: 9, marginLeft: 6 }}
                        title={`Amazon Connect initiation: ${String(i.metadata.initiationMethod)}`}>
                        {String(i.metadata.initiationMethod).toLowerCase()}
                      </span>
                    )}
                  </td>
                  <td>
                    <Link href={`/?drill=${drill}&platform=${encodeURIComponent(i.platform)}`} style={{ textDecoration: 'none' }}>
                      <span className="pill pill-blue mono" style={{ fontSize: 10, cursor: 'pointer' }}>{i.platform}</span>
                    </Link>
                  </td>
                  <td style={{ width: 140 }}>
                    <RiskBar risk={i.peakRisk} />
                    <span style={{ fontSize: 11, color: 'var(--dim)' }}>{Math.round(i.peakRisk)} / {Math.round(i.finalRisk)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>Recent Incidents</h3>
            {incidentList.length === 0 && <p style={{ color: 'var(--dim)' }}>No incidents.</p>}
            {incidentList.map(i => (
              <div key={i.incidentId} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #16202c' }}>
                <span className="pill pill-red">{i.severity}</span>{' '}
                <Link href={`/investigation/${encodeURIComponent(i.interactionId)}`} className="mono" style={{ fontSize: 12, color: 'var(--blue)', textDecoration: 'none' }}>
                  {i.incidentId}
                </Link>
                <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 4 }}>{i.summary}</div>
              </div>
            ))}
            <Link href="/incidents"><span style={{ fontSize: 12, color: 'var(--blue)' }}>All incidents →</span></Link>
          </div>

          <div className="panel" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>Wellbeing watch · voice biomarkers</h3>
              <span className="pill pill-gray" style={{ fontSize: 10 }} title="Acoustic signals with measured values — never medical or emotional condition labels.">NOT A DIAGNOSIS</span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--dim)', margin: '6px 0 8px' }}>
              Activation ≥75% or tremor ≥0.5 opens a “Wellbeing signal” incident for review
              (thresholds: env CXTRUST_WELLBEING_ACTIVATION / CXTRUST_WELLBEING_TREMOR).
            </p>
            {bmRows.length === 0 && (
              <p style={{ color: 'var(--dim)', fontSize: 12 }}>
                No interactions with voice biomarkers yet — they appear once calls carry captured audio (media streaming or the simulator).
              </p>
            )}
            {bmRows.map(i => {
              const act = Math.round((i.biomarkers?.emotion?.activation ?? 0) * 100);
              const conf = Math.round((i.biomarkers?.emotion?.confidence ?? 0) * 100);
              const flagged = act >= 75;
              return (
                <div key={i.interactionId} className="timeline-row" style={{ gridTemplateColumns: 'auto auto 1fr', marginBottom: 4 }}>
                  <span className={`pill ${flagged ? 'pill-red' : act >= 34 ? 'pill-amber' : 'pill-green'} mono`} style={{ fontSize: 10 }}>{act}%</span>
                  <span style={{ fontSize: 11, color: 'var(--dim)' }} className="mono">conf {conf}%</span>
                  <Link href={`/investigation/${encodeURIComponent(i.interactionId)}`} style={{ fontSize: 12 }}>
                    {i.interactionId}{flagged ? ' · REVIEW' : ''}
                  </Link>
                </div>
              );
            })}
          </div>

          <div className="panel">
            <h3>Platforms Governed</h3>
            <p style={{ fontSize: 11, color: 'var(--dim)', margin: '0 0 8px' }}>click a platform to filter interactions</p>
            {[...new Set(all.map(i => i.platform))].map(p => (
              <Link key={p} href={`/?drill=${drill}&platform=${encodeURIComponent(p)}`} style={{ textDecoration: 'none' }}>
                <div className={`pill mono ${platformFilter === p ? 'pill-red' : 'pill-blue'}`} style={{ marginRight: 6, marginBottom: 6, display: 'inline-block', cursor: 'pointer' }}>
                  {p}
                </div>
              </Link>
            ))}
            {all.length === 0 && <p style={{ color: 'var(--dim)' }}>—</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

// map tile href back to its drill key so the active tile gets a border
function drillHrefKey(href: string): DrillKey | null {
  const m = href.match(/\?drill=([\w-]+)/);
  if (!m) return null;
  return m[1] in DRILLS ? (m[1] as DrillKey) : null;
}
