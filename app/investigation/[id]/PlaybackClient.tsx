'use client';

import { useEffect, useRef, useState } from 'react';

export interface TimelineEntry {
  offsetS: number;
  kind: string;
  label: string;
  detail?: string;
  refId?: string;
  risk?: number;
}

// Synchronized playback driver for the LEFT pane: steps through the
// pre-fetched timeline array at 700ms per entry, highlight-scrolling to the
// current row. Pure client state — no API polling.
export default function PlaybackClient({ timeline }: { timeline: TimelineEntry[] }) {
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(-1); // -1 = not started
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (!playing) return;
    if (cursor >= timeline.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => setCursor(c => c + 1), 700);
    return () => clearTimeout(timer);
  }, [playing, cursor, timeline.length]);

  useEffect(() => {
    if (cursor < 0) return;
    const row = rowRefs.current[cursor];
    const list = listRef.current;
    if (row && list) {
      const top = row.offsetTop - list.offsetTop;
      list.scrollTo({ top: Math.max(top - 24, 0), behavior: 'smooth' });
    }
  }, [cursor]);

  const reset = () => { setPlaying(false); setCursor(-1); };
  const stepOnce = () => { setPlaying(false); setCursor(c => Math.min(c + 1, timeline.length - 1)); };

  const kindCls = (k: string) =>
    k === 'RISK' ? 'pill-amber'
      : (k === 'POLICY' || k === 'ENFORCEMENT' || k === 'INCIDENT') ? 'pill-red'
        : k === 'DETECTION' ? 'pill-purple'
          : k === 'AUTH' ? 'pill-blue'
            : 'pill-gray';

  return (
    <div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Playback</h3>
          <button onClick={() => setPlaying(p => !p)} disabled={timeline.length === 0}
            style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button onClick={stepOnce} disabled={timeline.length === 0}
            style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>⏭ Step</button>
          <button onClick={reset}
            style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>⟲ Reset</button>
          <span className="pill pill-gray mono" style={{ marginLeft: 'auto' }}>
            {cursor < 0 ? 'IDLE' : playing ? 'PLAYING' : 'PAUSED'} · {Math.max(cursor + 1, 0)}/{timeline.length}
          </span>
        </div>
      </div>

      <div
        ref={listRef}
        style={{ maxHeight: 560, overflowY: 'auto' }}
        className="panel"
      >
        <h3>Timeline</h3>
        {timeline.length === 0 && <p style={{ color: 'var(--dim)' }}>No timeline entries recorded.</p>}
        {timeline.map((t, i) => (
          <div
            key={i}
            ref={el => { rowRefs.current[i] = el; }}
            className="timeline-row"
            style={{
              gridTemplateColumns: 'auto auto 1fr',
              background: i === cursor ? 'rgba(56,132,255,0.14)' : undefined,
              borderLeft: i === cursor ? '3px solid var(--blue)' : '3px solid transparent',
              transition: 'background 200ms, border-left 200ms',
            }}
          >
            <span className="mono" style={{ color: 'var(--dim)' }}>t+{t.offsetS}s</span>
            <span className={`pill ${kindCls(t.kind)} mono`} style={{ justifySelf: 'start', fontSize: 10 }}>{t.kind}</span>
            <span>{t.label}{t.detail ? <span style={{ color: 'var(--dim)' }}> — {t.detail}</span> : null}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
