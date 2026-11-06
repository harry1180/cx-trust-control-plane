// Voice biomarkers panel — acoustic measurements + emotion ESTIMATE for an
// interaction. Signals for human review, never a diagnosis: every note
// carries its association AND its caveat, and the report's own limitations
// are rendered verbatim from the analyzer (not editorialized here).

interface BiomarkerEntry {
  key?: string; label?: string; value?: number; unit?: string;
  note?: string; baselineDeviationPct?: number;
}
export interface BiomarkerReport {
  biomarkers?: BiomarkerEntry[];
  emotion?: {
    activation?: number; label?: string; candidates?: string[];
    confidence?: number; disclaimer?: string;
  };
  limitations?: string[];
  analyzedDurationS?: number;
  speechFrames?: number;
  baselineUsed?: boolean;
}

export default function BiomarkersPanel({ report }: { report?: BiomarkerReport }) {
  const hasReport = !!report && Array.isArray(report.biomarkers) && report.biomarkers.length > 0;
  if (!hasReport) {
    return (
      <div className="panel" style={{ marginTop: 16 }}>
        <h3>Voice biomarkers</h3>
        <p style={{ color: 'var(--dim)', fontSize: 12 }}>
          No voice biomarkers for this interaction — they appear once a call has captured audio
          (live media streaming, the media simulator, or a bot-call session).
        </p>
      </div>
    );
  }
  const e = report.emotion ?? {};
  const activation = Math.round((e.activation ?? 0) * 100);
  const confidence = Math.round((e.confidence ?? 0) * 100);
  const actClass = activation >= 66 ? 'pill-red' : activation >= 34 ? 'pill-amber' : 'pill-green';

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Voice biomarkers · wellbeing signals</h3>
        <span className="pill pill-gray" title="Acoustic measurements with association notes — this panel never asserts a medical or emotional condition.">
          SIGNALS FOR REVIEW · NOT A DIAGNOSIS
        </span>
      </div>

      {/* Emotion estimate */}
      <div style={{ margin: '10px 0 4px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13 }}>Activation estimate</span>
        <span className={`pill ${actClass} mono`}>{activation}% · {e.label ?? '—'}</span>
        <span className="pill pill-gray mono" title="Confidence = cue coverage × analyzed duration (not correctness)">estimate confidence {confidence}%</span>
        {!!e.candidates?.length && (
          <span style={{ color: 'var(--dim)', fontSize: 12 }}>candidates: {e.candidates!.join(', ')}</span>
        )}
      </div>
      {e.disclaimer && <p style={{ color: 'var(--dim)', fontSize: 11, margin: '4px 0 10px' }}>{e.disclaimer}</p>}

      {/* Measurements */}
      <table className="tbl">
        <thead>
          <tr><th>Measurement</th><th>Value</th><th>Vs your baseline</th><th>Association (and caveat)</th></tr>
        </thead>
        <tbody>
          {(report.biomarkers ?? []).map(b => (
            <tr key={b.key}>
              <td style={{ fontSize: 12 }}>{b.label ?? b.key}</td>
              <td className="mono" style={{ fontSize: 12 }}>
                {typeof b.value === 'number' && Number.isFinite(b.value) ? b.value : '—'}{b.unit ? ` ${b.unit}` : ''}
              </td>
              <td className="mono" style={{ fontSize: 12 }}>
                {typeof b.baselineDeviationPct === 'number'
                  ? <span style={{ color: Math.abs(b.baselineDeviationPct) >= 30 ? 'var(--amber)' : 'var(--text)' }}>
                      {b.baselineDeviationPct > 0 ? '+' : ''}{b.baselineDeviationPct}%
                    </span>
                  : <span style={{ color: 'var(--dim)' }}>—</span>}
              </td>
              <td style={{ fontSize: 11, color: 'var(--dim)', maxWidth: 460 }}>{b.note}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {report.baselineUsed === false && (
        <p style={{ color: 'var(--dim)', fontSize: 11, margin: '6px 0 0' }}>
          No enrolled voiceprint baseline — enroll a voice (consent required) on /connectors to compare against your own baseline instead of raw values.
        </p>
      )}

      {report.limitations && report.limitations.length > 0 && (
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, color: 'var(--dim)', fontSize: 11 }}>
          {report.limitations.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
      <p style={{ color: 'var(--dim)', fontSize: 11, margin: '6px 0 0' }} className="mono">
        analyzed {report.analyzedDurationS ?? '?'}s · {report.speechFrames ?? '?'} speech frames
      </p>
    </div>
  );
}