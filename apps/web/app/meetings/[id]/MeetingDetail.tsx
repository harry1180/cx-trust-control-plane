// Meeting detail — the full post-meeting surface: diarized transcript with
// speaker labels + word timestamps, clickable timestamps (audio anchor or
// in-page position), summary/topics/sentiment, action items, decisions,
// ask-this-meeting RAG, in-meeting search.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface Word { start: number; end: number; word: string; speaker?: string }
interface Segment { start: number; end: number; text: string; speaker: string; words?: Word[] }
interface Summary {
  digest: string;
  topics: { topic: string; mentions: number; firstOffsetS: number }[];
  actionItems: { text: string; who: string; offsetS: number }[];
  decisions: { text: string; offsetS: number }[];
  sentiment: { overall: number; label: string; timeline: { offsetS: number; score: number; label: string }[] };
  openQuestions: string[];
}
interface Meeting {
  meetingId: string; title: string; startedAt: string; durationS: number;
  language?: string; diarization: string; recordingUrl?: string;
  segments: Segment[]; summary?: Summary;
}
interface AskResult {
  answer: string; confidence: number; unanswerable: boolean;
  citations: { start: number; end: number; speaker: string; text: string; recordingAnchor?: string }[];
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export default function MeetingDetail({ meetingId }: { meetingId: string }) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing'>('loading');
  const [ask, setAsk] = useState('');
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [search, setSearch] = useState('');
  const [searchHits, setSearchHits] = useState<{ start: number; end: number; speaker: string; excerpt: string }[] | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/cxtrust?path=/v1/meetings/${encodeURIComponent(meetingId)}`)
      .then(async r => {
        if (cancelled) return;
        if (r.ok) { setMeeting((await r.json()) as Meeting); setState('ok'); }
        else setState('missing');
      })
      .catch(() => { if (!cancelled) setState('missing'); });
    return () => { cancelled = true; };
  }, [meetingId]);

  const summary = meeting?.summary;

  const runAsk = async () => {
    if (!ask.trim()) return;
    const res = await fetch(`/api/cxtrust?path=${encodeURIComponent(`/v1/meetings/${meetingId}/ask?q=${encodeURIComponent(ask)}`)}`);
    if (res.ok) setAskResult((await res.json()) as AskResult);
  };
  const runSearch = async () => {
    if (!search.trim()) return;
    const res = await fetch(`/api/cxtrust?path=${encodeURIComponent(`/v1/meetings/${meetingId}/search?q=${encodeURIComponent(search)}`)}`);
    if (res.ok) {
      const body = (await res.json()) as { hits: typeof searchHits };
      setSearchHits(body.hits);
    }
  };
  const jumpTo = (start: number) => {
    setActive(start);
    const row = rowRefs.current[start];
    const list = listRef.current;
    if (row && list) list.scrollTo({ top: row.offsetTop - list.offsetTop - 12, behavior: 'smooth' });
  };

  const sentimentCls = summary?.sentiment.label === 'NEGATIVE' ? 'pill-red' : summary?.sentiment.label === 'POSITIVE' ? 'pill-green' : 'pill-gray';

  if (state === 'loading') return <p style={{ color: 'var(--dim)' }}>Loading meeting…</p>;
  if (state === 'missing' || !meeting) return <p style={{ color: 'var(--dim)' }}>Meeting not found.</p>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span className="pill pill-blue mono">{fmt(meeting.durationS)}</span>
        <span className="pill pill-gray mono">{meeting.segments.length} segments</span>
        <span className={`pill ${meeting.diarization === 'provider' ? 'pill-green' : 'pill-amber'} mono`}>
          {meeting.diarization === 'provider' ? 'DIARIZED' : 'SINGLE-SPEAKER (no diarization provider)'}
        </span>
        {meeting.language && <span className="pill pill-gray mono">{meeting.language}</span>}
        {summary && <span className={`pill ${sentimentCls} mono`}>{summary.sentiment.label}</span>}
      </div>

      <div className="grid3">
        {/* LEFT: transcript */}
        <div>
          <div className="panel" style={{ marginBottom: 12 }}>
            <h3>Transcript</h3>
            <div ref={listRef} style={{ maxHeight: 480, overflowY: 'auto' }}>
              {meeting.segments.map((s, i) => {
                const isHit = searchHits?.some(h => h.start === s.start);
                return (
                  <div
                    key={i}
                    ref={el => { rowRefs.current[s.start] = el; }}
                    className="timeline-row"
                    style={{
                      gridTemplateColumns: 'auto auto 1fr',
                      background: active === s.start ? 'rgba(56,132,255,0.14)' : isHit ? 'rgba(251,191,36,0.12)' : undefined,
                      cursor: 'pointer',
                    }}
                    onClick={() => jumpTo(s.start)}
                    title={meeting.recordingUrl ? 'Jump in recording' : 'Timestamp (no recording attached)'}
                  >
                    <span className="mono" style={{ color: 'var(--blue)' }}>{fmt(s.start)}</span>
                    <span className="pill pill-purple mono" style={{ fontSize: 10 }}>{s.speaker}</span>
                    <span style={{ fontSize: 13 }}>{s.text}</span>
                  </div>
                );
              })}
            </div>
            <p style={{ color: 'var(--dim)', fontSize: 11, margin: '8px 0 0' }}>
              {meeting.recordingUrl
                ? <>Click a timestamp to open that moment in the recording (<a href={`${meeting.recordingUrl}#t=${active ?? 0}`} target="_blank" rel="noreferrer">recording ↗</a>).</>
                : 'Timestamps are clickable within this view. Attach recordingUrl at upload to deep-link into the recording.'}
            </p>
          </div>
        </div>

        {/* RIGHT: analysis */}
        <div>
          {summary && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <h3>Summary &amp; Analysis</h3>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {summary.topics.slice(0, 8).map(t => (
                  <span key={t.topic} className="pill pill-blue mono" style={{ fontSize: 10 }}>
                    {t.topic} ×{t.mentions}
                  </span>
                ))}
              </div>
              {summary.digest && <p style={{ fontSize: 13, margin: '4px 0 10px' }}>{summary.digest}</p>}
              {summary.actionItems.length > 0 && (
                <>
                  <h3 style={{ marginTop: 10 }}>Action items</h3>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                    {summary.actionItems.slice(0, 6).map((a, i) => (
                      <li key={i} style={{ cursor: 'pointer', color: 'var(--dim)' }} onClick={() => jumpTo(a.offsetS)}>
                        <span className="mono" style={{ color: 'var(--blue)' }}>{fmt(a.offsetS)}</span> {a.text}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {summary.decisions.length > 0 && (
                <>
                  <h3 style={{ marginTop: 10 }}>Decisions</h3>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                    {summary.decisions.slice(0, 6).map((d, i) => (
                      <li key={i} style={{ cursor: 'pointer', color: 'var(--dim)' }} onClick={() => jumpTo(d.offsetS)}>
                        <span className="mono" style={{ color: 'var(--blue)' }}>{fmt(d.offsetS)}</span> {d.text}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>Ask this meeting</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={ask}
                onChange={e => setAsk(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void runAsk(); }}
                placeholder="e.g. what was decided about the refund?"
                style={{ flex: 1, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px' }}
              />
              <button onClick={() => void runAsk()}
                style={{ background: 'var(--blue)', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer' }}>
                Ask
              </button>
            </div>
            {askResult && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                  <span className={`pill ${askResult.unanswerable ? 'pill-amber' : 'pill-green'} mono`} style={{ fontSize: 10 }}>
                    {askResult.unanswerable ? 'WEAK MATCH' : 'ANSWERED'} · {(askResult.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <p style={{ fontSize: 13, margin: '0 0 8px' }}>{askResult.answer}</p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                  {askResult.citations.map((c, i) => (
                    <li key={i}>
                      <span className="mono" style={{ color: 'var(--blue)', cursor: 'pointer' }} onClick={() => jumpTo(c.start)}>{fmt(c.start)}</span>{' '}
                      <span className="pill pill-purple mono" style={{ fontSize: 10 }}>{c.speaker}</span>{' '}
                      {c.text.slice(0, 120)}
                      {c.recordingAnchor && <> · <a href={c.recordingAnchor} target="_blank" rel="noreferrer">in recording ↗</a></>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="panel">
            <h3>Search this transcript</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void runSearch(); }}
                placeholder="find words in this meeting"
                style={{ flex: 1, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px' }}
              />
              <button onClick={() => void runSearch()}
                style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer' }}>
                Find
              </button>
            </div>
            {searchHits && (
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12 }}>
                {searchHits.length === 0 && <li style={{ color: 'var(--dim)' }}>No matches.</li>}
                {searchHits.slice(0, 8).map((h, i) => (
                  <li key={i} style={{ cursor: 'pointer' }} onClick={() => jumpTo(h.start)}>
                    <span className="mono" style={{ color: 'var(--blue)' }}>{fmt(h.start)}</span>{' '}
                    <span className="pill pill-purple mono" style={{ fontSize: 10 }}>{h.speaker}</span> {h.excerpt.slice(0, 100)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}