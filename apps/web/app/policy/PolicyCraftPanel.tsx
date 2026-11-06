'use client';

// Natural-language policy authoring: type plain English → deterministic
// compiler → run the compiled artifact through what-if simulation against
// the demo corpus BEFORE anything ships. Authoring-time only: the live
// engine never evaluates English, only compiled Policy JSON.

import { useState } from 'react';

interface CompileError { line: number; message: string }
interface RuleView { id: string; severity: string; actions: string[] }
interface SimTotals { newlyBlocked: number; newlyAllowed: number; falsePositiveEstimate: number; scenariosCompared: number }

const EXAMPLE = `IF synthetic voice probability is greater than 0.85 AND identity confidence is less than 0.5 AND requested action is one of CHANGE_BANK_ACCOUNT, ISSUE_REFUND, MONEY_TRANSFER THEN deny and step up authentication

IF risk score is at least 80 THEN transfer to human`;

async function postJson(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`/api/cxtrust?path=${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

export default function PolicyCraftPanel() {
  const [text, setText] = useState(EXAMPLE);
  const [phase, setPhase] = useState<'idle' | 'compiling' | 'error' | 'done'>('idle');
  const [errors, setErrors] = useState<CompileError[]>([]);
  const [rendered, setRendered] = useState<string[]>([]);
  const [rules, setRules] = useState<RuleView[]>([]);
  const [totals, setTotals] = useState<SimTotals | null>(null);
  const [policyId, setPolicyId] = useState<string | null>(null);

  async function compileAndSimulate() {
    setPhase('compiling'); setErrors([]); setRendered([]); setRules([]); setTotals(null); setPolicyId(null);
    const c = await postJson('/v1/policy/compile', { text, policyId: 'NL_STUDIO_POLICY', name: 'Policy Studio draft', version: 1 });
    if (c.status !== 200 || !c.data || typeof c.data !== 'object') { setErrors([{ line: 0, message: `compile request failed (HTTP ${c.status})` }]); setPhase('error'); return; }
    const cd = c.data as { ok: boolean; errors?: CompileError[]; rendered?: string[]; policy?: { rules?: RuleView[]; policyId?: string } };
    if (!cd.ok) { setErrors(cd.errors ?? []); setPhase('error'); return; }
    setRendered(cd.rendered ?? []);
    setRules(cd.policy?.rules ?? []);
    setPolicyId(cd.policy?.policyId ?? null);
    const s = await postJson('/v1/simulate', { candidate: cd.policy });
    const sd = s.data as { totals?: SimTotals; error?: string };
    if (s.status === 200 && sd?.totals) { setTotals(sd.totals); setPhase('done'); }
    else { setErrors([{ line: 0, message: sd?.error ?? 'simulation failed' }]); setPhase('error'); }
  }

  const sevPill: Record<string, string> = { CRITICAL: 'pill-red', HIGH: 'pill-amber', MEDIUM: 'pill', LOW: 'pill' };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>Natural-Language Policy Authoring</h3>
        <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>compiled deterministically — English never runs on the hot path</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--dim)', margin: '6px 0 10px' }}>
        Write IF/THEN rules in plain English. The compiler turns them into the same Policy artifact the engine runs,
        then replays your demo corpus against it — see what would change <em>before</em> deploying.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%', minHeight: 130, background: 'var(--bg2, #0d1117)', color: 'var(--text, #e6e6e6)',
          fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5, padding: 10,
          border: '1px solid var(--line, #222)', borderRadius: 6, resize: 'vertical', boxSizing: 'border-box',
        }}
      />
      <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="btn" onClick={compileAndSimulate} disabled={phase === 'compiling'}>
          {phase === 'compiling' ? 'Compiling + simulating…' : 'Compile & Simulate'}
        </button>
        {phase === 'done' && policyId && <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>compiled as {policyId}</span>}
      </div>

      {errors.length > 0 && (
        <div style={{ marginTop: 10, padding: 10, border: '1px solid #7f1d1d', borderRadius: 6, background: 'rgba(127,29,29,.15)' }}>
          {errors.map((e, i) => (
            <div key={i} className="mono" style={{ fontSize: 11, color: '#fca5a5' }}>
              {e.line > 0 ? `line ${e.line}: ` : ''}{e.message}
            </div>
          ))}
        </div>
      )}

      {rendered.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Compiled rules</div>
          {rendered.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: i ? '1px solid var(--line, #222)' : undefined }}>
              <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', minWidth: 36 }}>{rules[i]?.id}</span>
              <span className={`pill ${sevPill[rules[i]?.severity ?? ''] ?? 'pill'}`}>{rules[i]?.severity}</span>
              <span className="mono" style={{ fontSize: 11 }}>{r}</span>
            </div>
          ))}
        </div>
      )}

      {totals && (
        <div style={{ marginTop: 12, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <Stat label="Scenarios compared" value={String(totals.scenariosCompared)} />
          <Stat label="Newly blocked" value={String(totals.newlyBlocked)} tone={totals.newlyBlocked > 0 ? '#4ade80' : undefined} />
          <Stat label="Newly allowed" value={String(totals.newlyAllowed)} tone={totals.newlyAllowed > 0 ? '#facc15' : undefined} />
          <Stat label="Est. false positives" value={String(totals.falsePositiveEstimate)} tone={totals.falsePositiveEstimate > 0 ? '#f87171' : undefined} />
          {totals.newlyAllowed > 0 && (
            <div style={{ fontSize: 11, color: '#facc15', alignSelf: 'center' }}>
              caution: this draft would ALLOW {totals.newlyAllowed} action(s) the current policy blocks
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 22, color: tone ?? 'var(--text, #e6e6e6)' }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
    </div>
  );
}
