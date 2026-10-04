'use client';

// Live Simulator — drives the CX Trust API over HTTP (server-side governance).
// No engine runs in the browser: every step is a real API call, and the
// snapshot returned is the server's session state.

import { useCallback, useEffect, useRef, useState } from 'react';
import { RiskPill, ClassificationPill, ActionPill, SeverityPill, RiskBar, riskColor } from '../components';

interface Snapshot {
  interaction?: { interactionId: string; platform: string; organizationId: string };
  interactionId?: string;
  participants?: { participantId: string; kind: string; classification: string; identityConfidence: number; authLevel: string; riskState: { syntheticVoiceProbability?: number }; agentId?: string }[];
  risk?: { overall: number };
  timeline?: { offsetS: number; kind: string; label: string; detail?: string }[];
  decisions?: { decisionId: string; matchedRule: string; actions: string[]; reasons: string[]; policyId: string; policyVersion: number; latencyMs: number }[];
  detections?: { detectionId: string; code: string; title: string; evidence: { text: string }[] }[];
  incidents?: { incidentId: string; severity: string; summary: string }[];
  evidence?: { sequence: number; kind: string; chainHash: string }[];
  decision?: Snapshot['decisions'] extends (infer D)[] | undefined ? D : never;
}

interface ScenarioDef {
  id: string;
  title: string;
  blurb: string;
  steps: ScenarioStep[];
}
type ScenarioStep =
  | { t: 'participant'; at: number; participant: { participantId: string; kind: string; classification: string; identityConfidence: number; authLevel: string; agentId?: string } }
  | { t: 'voice'; at: number; participantId: string; synthetic: boolean; replay?: boolean }
  | { t: 'turn'; at: number; participantId: string; text: string }
  | { t: 'action'; at: number; participantId: string; action: string; amount?: number; intent?: string }
  | { t: 'auth'; at: number; participantId: string; result: 'SUCCESS' | 'FAILURE'; level: 'MEDIUM' | 'HIGH' }
  | { t: 'end'; at: number };

const STEP_LABELS: Record<string, string> = {
  participant: 'PARTICIPANT JOINS', voice: 'AUDIO ANALYSIS', turn: 'TRANSCRIPT',
  action: 'ACTION REQUEST', auth: 'STEP-UP AUTH', end: 'INTERACTION END',
};

const ORG = 'org-demo';

export default function Simulator() {
  const [scen, setScen] = useState<ScenarioDef | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [iid, setIid] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastStep, setLastStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioDef[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadScenarios = useCallback(async () => {
    const r = await fetch('/api/cxtrust?path=/v1/scenarios');
    const j = await r.json() as { scenarios?: ScenarioDef[] };
    setScenarios(j.scenarios ?? []);
  }, []);

  // fetch scenario definitions on mount (not during SSR/prerender — the
  // proxy URL only resolves in a browser context)
  useEffect(() => {
    if (scenarios === null) { void loadScenarios(); }
  }, [scenarios, loadScenarios]);

  const runStep = useCallback(async (sc: ScenarioDef, idx: number, id: string) => {
    const step = sc.steps[idx];
    if (!step) {
      setRunning(false);
      return;
    }
    try {
      switch (step.t) {
        case 'participant': {
          const r = await fetch(`/api/cxtrust?path=/v1/interactions/${id}/participant`, {
            method: 'POST', body: JSON.stringify({
              participantId: step.participant.participantId, interactionId: id, organizationId: ORG,
              kind: step.participant.kind, classification: 'UNKNOWN_PARTICIPANT',
              identityConfidence: step.participant.authLevel === 'HIGH' ? 0.95 : step.participant.authLevel === 'MEDIUM' ? 0.7 : 0.3,
              authLevel: step.participant.authLevel, joinedAtOffsetS: step.at,
              agentId: step.participant.agentId, riskState: {},
            }),
          });
          if (r.ok) setSnap(await r.json());
          setLastStep(`participant ${step.participant.participantId} (${step.participant.kind}) joined`);
          break;
        }
        case 'voice': {
          const r = await fetch(`/api/cxtrust?path=/v1/interactions/${id}/voice`, {
            method: 'POST', body: JSON.stringify({
              participantId: step.participantId,
              syntheticProbability: step.synthetic ? 0.97 : 0.02,
              replayProbability: step.replay ? 0.93 : 0.01,
              impersonationProbability: step.synthetic ? 0.9 : 0.05,
            }),
          });
          if (r.ok) setSnap(await r.json());
          setLastStep(`voice trust engine analyzing ${step.participantId}…`);
          break;
        }
        case 'turn': {
          const r = await fetch(`/api/cxtrust?path=/v1/interactions/${id}/turns`, {
            method: 'POST', body: JSON.stringify({ participantId: step.participantId, text: step.text, offsetS: step.at }),
          });
          if (r.ok) setSnap(await r.json());
          setLastStep(`transcript: "${step.text.slice(0, 60)}"`);
          break;
        }
        case 'action': {
          const r = await fetch(`/api/cxtrust?path=/v1/interactions/${id}/actions`, {
            method: 'POST', body: JSON.stringify({
              requestedAction: step.action, participantId: step.participantId,
              amount: step.amount, intent: step.intent,
            }),
          });
          if (r.ok) {
            const j = await r.json();
            setSnap(j.snapshot ?? j);
          }
          setLastStep(`action request: ${step.action}${step.amount ? ` ($${step.amount})` : ''}`);
          break;
        }
        case 'auth': {
          const r = await fetch(`/api/cxtrust?path=/v1/interactions/${id}/auth`, {
            method: 'POST', body: JSON.stringify({ participantId: step.participantId, result: step.result, level: step.level }),
          });
          if (r.ok) setSnap(await r.json());
          setLastStep(`step-up authentication: ${step.result}`);
          break;
        }
        case 'end': {
          await fetch(`/api/cxtrust?path=/v1/interactions/${id}/end`, { method: 'POST' });
          // snapshot persists server-side; keep last known
          setLastStep('interaction ended · persisted to evidence store');
          setRunning(false);
          return;
        }
      }
    } catch (e) {
      setError(String((e as Error).message));
      setRunning(false);
      return;
    }
    timer.current = setTimeout(() => { void runStep(sc, idx + 1, id); }, 850);
  }, []);

  const start = useCallback(async (sc: ScenarioDef) => {
    if (timer.current) clearTimeout(timer.current);
    setError(null);
    setRunning(true);
    setScen(sc);
    setSnap(null);
    setIid(null);
    // randomize the label suffix so repeated runs are distinct interactions
    const res = await fetch('/api/cxtrust?path=/v1/interactions', {
      method: 'POST',
      body: JSON.stringify({
        organizationId: ORG, platform: 'amazon-connect',
        metadata: { label: sc.title, scenario: sc.id },
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(`API ${res.status}: ${(j as { error?: string }).error ?? 'unreachable — is the server running?'}`);
      setRunning(false);
      return;
    }
    const j = await res.json() as Snapshot;
    const id = j.interactionId ?? j.interaction?.interactionId;
    if (!id) { setError('no interactionId in API response'); setRunning(false); return; }
    setIid(id);
    setSnap(j);
    void runStep(sc, 0, id);
  }, [runStep]);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setRunning(false);
  }, []);

  const risk = snap?.risk?.overall ?? 0;

  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Attack Simulator</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Every step is a live HTTP call into the CX Trust API — the governance engine runs
        server-side, state is persisted, and evidence chains are verifiable afterwards.
        <span className="pill pill-gray" style={{ marginLeft: 8 }}>DEMO DATA</span>
      </p>

      {!scenarios && <p style={{ color: 'var(--dim)' }}>Loading scenarios from API…</p>}
      {scenarios && (
        <div className="sim-btn-row">
          {scenarios.map(s => (
            <button key={s.id} className={`btn ${scen?.id === s.id ? 'btn-primary' : ''}`}
              onClick={() => { void start(s); }} disabled={running}>
              {s.title.split('·')[1]?.trim() ?? s.title}
            </button>
          ))}
          <button className="btn" onClick={stop} disabled={!running}>Stop</button>
        </div>
      )}
      {error && (
        <div className="panel" style={{ borderColor: 'var(--red)', marginBottom: 16 }}>
          <h3 style={{ color: 'var(--red)' }}>API error</h3>
          <p className="mono" style={{ fontSize: 12 }}>{error}</p>
          <p style={{ color: 'var(--dim)', fontSize: 12, marginTop: 6 }}>
            Start the governance API: <span className="mono">cd packages/cxtrust-server && node src/index.ts</span>
          </p>
        </div>
      )}

      <div className="grid3">
        <div>
          {scen && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <h3>{scen.title}</h3>
              <p style={{ color: 'var(--dim)', marginBottom: 12 }}>{scen.blurb}</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
                <span className="mono" style={{ fontSize: 20, fontWeight: 700, color: riskColor(risk) }}>{snap ? risk : '—'}</span>
                <RiskPill risk={risk} />
                {running && <span className="pill pill-blue">LIVE · via API</span>}
                {!running && iid && <span className="pill pill-gray mono">{iid}</span>}
              </div>
              <RiskBar risk={risk} />
              <div style={{ marginTop: 8, color: 'var(--dim)', fontSize: 12 }} className="mono">{lastStep}</div>
            </div>
          )}

          <div className="panel">
            <h3>Live Interaction Timeline (server state)</h3>
            {!snap && <p style={{ color: 'var(--dim)' }}>Start a scenario to see the live feed.</p>}
            {snap?.timeline?.map((t, i) => (
              <div key={i} className="timeline-row">
                <span className="mono" style={{ color: 'var(--dim)' }}>t+{t.offsetS}s</span>
                <span className={`pill ${t.kind === 'RISK' ? 'pill-amber' : (t.kind === 'POLICY' || t.kind === 'ENFORCEMENT' || t.kind === 'INCIDENT') ? 'pill-red' : t.kind === 'AUTH' ? 'pill-blue' : 'pill-gray'} mono`}
                  style={{ justifySelf: 'start', fontSize: 10 }}>{t.kind}</span>
                <span>{t.label}{t.detail ? <span style={{ color: 'var(--dim)' }}> — {t.detail}</span> : null}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          {snap && (
            <>
              <div className="panel" style={{ marginBottom: 16 }}>
                <h3>Participants</h3>
                {snap.participants?.map(p => (
                  <div key={p.participantId} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className="mono">{p.kind}</span>
                      <ClassificationPill c={p.classification as never} />
                      {p.agentId && <span className="pill pill-purple mono">{p.agentId}</span>}
                    </div>
                    <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 4 }}>
                      identity confidence {Math.round(p.identityConfidence * 100)}% · auth {p.authLevel}
                      {p.riskState?.syntheticVoiceProbability !== undefined &&
                        <> · synthetic voice {Math.round(p.riskState.syntheticVoiceProbability * 100)}%</>}
                    </div>
                  </div>
                ))}
              </div>

              <div className="panel" style={{ marginBottom: 16 }}>
                <h3>Policy Decisions</h3>
                {snap.decisions?.length === 0 && <p style={{ color: 'var(--dim)' }}>No policy decisions yet.</p>}
                {snap.decisions?.map(d => (
                  <div key={d.decisionId} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid #16202c' }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="mono" style={{ fontSize: 12 }}>{d.matchedRule}</span>
                      {d.actions.map(a => <ActionPill key={a} a={a as never} />)}
                    </div>
                    <ul style={{ color: 'var(--dim)', fontSize: 12, margin: '6px 0 0 16px' }}>
                      {d.reasons.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                    <div className="mono" style={{ color: 'var(--dim)', fontSize: 11, marginTop: 4 }}>
                      {d.policyId} v{d.policyVersion} · {d.latencyMs}ms
                    </div>
                  </div>
                ))}
              </div>

              <div className="panel" style={{ marginBottom: 16 }}>
                <h3>Detections</h3>
                {snap.detections?.map(d => (
                  <div key={d.detectionId} style={{ marginBottom: 8, fontSize: 13 }}>
                    <strong>{d.title}</strong> <span className="pill pill-gray mono" style={{ fontSize: 10 }}>{d.code}</span>
                    <div style={{ color: 'var(--dim)', fontSize: 12 }}>
                      {d.evidence.map((e, i) => <div key={i}>{e.text}</div>)}
                    </div>
                  </div>
                ))}
              </div>

              {snap.incidents && snap.incidents.length > 0 && (
                <div className="panel" style={{ marginBottom: 16, borderColor: 'var(--red)' }}>
                  <h3>Incidents</h3>
                  {snap.incidents.map(i => (
                    <div key={i.incidentId}>
                      <SeverityPill s={i.severity as never} /> <span className="mono" style={{ fontSize: 12 }}>{i.incidentId}</span>
                      <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 4 }}>{i.summary}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="panel">
                <h3>Evidence Chain ({snap.evidence?.length ?? 0} records · persisted)</h3>
                {snap.evidence?.slice(-6).map(e => (
                  <div key={e.sequence} className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 4 }}>
                    #{e.sequence} {e.kind} · {e.chainHash.slice(0, 16)}…
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}