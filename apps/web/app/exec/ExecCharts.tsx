'use client';

// Executive charts — zero-dependency plain SVG. Fetches the aggregated risk
// reasons from the executive API on mount; the interactions-by-hour sparkline
// is rendered from byHour passed down by the server component.

import { useEffect, useState } from 'react';

interface Reason { label: string; points: number }

export default function ExecCharts({ byHour }: { byHour: Record<string, number> }) {
  const [reasons, setReasons] = useState<Reason[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/cxtrust?path=' + encodeURIComponent('/v1/executive/org-demo/reasons'))
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { reasons?: Reason[] }) => { if (alive) setReasons(j.reasons ?? []); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="grid2">
      <div className="panel">
        <h3>Top risk reasons (aggregated points)</h3>
        {failed && <p style={{ color: 'var(--dim)' }}>Reasons unavailable (API offline).</p>}
        {!failed && reasons === null && <p style={{ color: 'var(--dim)' }}>Loading…</p>}
        {!failed && reasons !== null && reasons.length === 0 && (
          <p style={{ color: 'var(--dim)' }}>No risk reasons recorded yet.</p>
        )}
        {reasons !== null && reasons.length > 0 && <ReasonBars reasons={reasons} />}
      </div>
      <div className="panel">
        <h3>Interactions by hour</h3>
        <HourSparkline byHour={byHour} />
      </div>
    </div>
  );
}

// The client fetches via the existing same-origin proxy route
// (/api/cxtrust?path=…) so the browser never needs the API key or API host.
function ReasonBars({ reasons }: { reasons: Reason[] }) {
  const max = Math.max(1, ...reasons.map(r => r.points));
  const W = 640, ROW = 26, LEFT = 300;
  const H = reasons.length * ROW + 8;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Top risk reasons">
      {reasons.map((r, i) => {
        const y = i * ROW + 4;
        const w = Math.max(2, (r.points / max) * (W - LEFT - 60));
        return (
          <g key={r.label}>
            <title>{`${r.label}: ${r.points}`}</title>
            <text x={LEFT - 8} y={y + 12} textAnchor="end" fontSize="10" fill="var(--dim)" fontFamily="ui-monospace, monospace">
              {r.label.length > 46 ? r.label.slice(0, 45) + '…' : r.label}
            </text>
            <rect x={LEFT} y={y} width={w} height={ROW - 8} rx="3" fill="var(--amber)" opacity="0.85" />
            <text x={LEFT + w + 6} y={y + 12} fontSize="10" fill="var(--text)" fontFamily="ui-monospace, monospace">{r.points}</text>
          </g>
        );
      })}
    </svg>
  );
}

function HourSparkline({ byHour }: { byHour: Record<string, number> }) {
  const hours = Object.entries(byHour).sort(([a], [b]) => a.localeCompare(b)).slice(-24);
  if (hours.length === 0) {
    return <p style={{ color: 'var(--dim)' }}>No interaction timestamps recorded yet.</p>;
  }
  const W = 320, H = 90, PAD = 6;
  const max = Math.max(1, ...hours.map(([, n]) => n));
  const step = hours.length > 1 ? (W - PAD * 2) / (hours.length - 1) : 0;
  const pts = hours.map(([, n], i) => [PAD + i * step, H - PAD - (n / max) * (H - PAD * 2 - 10)] as const);
  const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${path} L${pts[pts.length - 1][0].toFixed(1)},${H - PAD} L${pts[0][0].toFixed(1)},${H - PAD} Z`;
  const first = hours[0][0].replace('T', ' ') + 'h';
  const last = hours[hours.length - 1][0].replace('T', ' ') + 'h';
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Interactions by hour">
        <path d={area} fill="var(--blue)" opacity="0.15" />
        <path d={path} fill="none" stroke="var(--blue)" strokeWidth="2" />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={2.5} fill="var(--blue)">
            <title>{`${hours[i][0]}: ${hours[i][1]}`}</title>
          </circle>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--dim)', fontSize: 11 }} className="mono">
        <span>{first}</span><span>{last}</span>
      </div>
    </div>
  );
}
