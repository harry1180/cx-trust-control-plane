// Meetings hub — upload audio (WAV) → transcribe via asr-worker (faster-whisper)
// → diarized, timestamped, searchable meeting. Cross-meeting search included.

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface MeetingRow {
  meetingId: string; title: string; startedAt: string; durationS: number;
  diarization: string; speakers: string[]; segmentCount: number;
  sentimentLabel?: string; recordingUrl?: string;
}
interface UploadState { phase: 'idle' | 'uploading' | 'transcribing' | 'done' | 'error'; message?: string; meetingId?: string }
interface Hit { meetingId: string; title: string; start: number; speaker: string; excerpt: string; score: number }

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export default function MeetingsClient() {
  const [meetings, setMeetings] = useState<MeetingRow[] | null>(null);
  const [upload, setUpload] = useState<UploadState>({ phase: 'idle' });
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);

  const load = async () => {
    const res = await fetch('/api/cxtrust?path=/v1/meetings');
    if (res.ok) setMeetings(((await res.json()) as { meetings: MeetingRow[] }).meetings);
  };
  useEffect(() => { void load(); }, []);

  const onFile = async (file: File) => {
    setUpload({ phase: 'uploading', message: `Reading ${file.name}…` });
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const audioB64 = btoa(binary);
    setUpload({ phase: 'transcribing', message: 'Transcribing with faster-whisper (CPU)… this takes a while for long audio.' });
    try {
      const res = await fetch('/api/cxtrust?path=/v1/meetings/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          audio_base64: audioB64,
          title: title.trim() || file.name.replace(/\.(wav|mp3|ogg)$/i, ''),
        }),
      });
      const body = (await res.json()) as { meetingId?: string; error?: string; segments?: number; diarization?: string; asrLatencyMs?: number };
      if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
      setUpload({ phase: 'done', meetingId: body.meetingId, message: `${body.segments} segments · diarization: ${body.diarization} · ${((body.asrLatencyMs ?? 0) / 1000).toFixed(1)}s` });
      void load();
    } catch (e) {
      setUpload({ phase: 'error', message: String((e as Error).message) });
    }
  };

  const doSearch = async () => {
    if (!query.trim()) return;
    const res = await fetch(`/api/cxtrust?path=${encodeURIComponent(`/v1/meetings-search?q=${encodeURIComponent(query)}`)}`);
    if (res.ok) setHits(((await res.json()) as { hits: Hit[] }).hits);
  };

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>Upload a recording (WAV)</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="meeting title (optional)"
            style={{ flex: '0 1 260px', background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px' }}
          />
          <input
            type="file"
            accept=".wav,audio/wav"
            onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
            style={{ color: 'var(--dim)' }}
          />
        </div>
        {upload.phase !== 'idle' && (
          <p style={{ marginTop: 10, color: upload.phase === 'error' ? 'var(--red)' : 'var(--dim)', fontSize: 12 }}>
            {upload.phase === 'transcribing' && <span className="pill pill-amber mono">TRANSCRIBING… </span>}
            {upload.phase === 'done' && (
              <>Done — <Link href={`/meetings/${upload.meetingId}`} style={{ color: 'var(--blue)' }}>open meeting ↗</Link> · </>
            )}
            {upload.message}
          </p>
        )}
        <p style={{ color: 'var(--dim)', fontSize: 11, margin: '8px 0 0' }}>
          Transcription runs locally (faster-whisper base, CPU). Speaker diarization is applied
          when diarization turns are provided; without a provider the transcript is labeled
          single-speaker honestly. Word-level timestamps are captured for every segment.
        </p>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>Cross-meeting search</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void doSearch(); }}
            placeholder="search across all meetings"
            style={{ flex: 1, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px' }}
          />
          <button onClick={() => void doSearch()}
            style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer' }}>
            Search
          </button>
        </div>
        {hits && (
          <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {hits.length === 0 && <li style={{ color: 'var(--dim)' }}>No matches across meetings.</li>}
            {hits.map((h, i) => (
              <li key={i}>
                <Link href={`/meetings/${h.meetingId}`} style={{ color: 'var(--blue)' }}>{h.title}</Link>
                {' · '}<span className="mono">{fmt(h.start)}</span>{' · '}
                <span className="pill pill-purple mono" style={{ fontSize: 10 }}>{h.speaker}</span> {h.excerpt.slice(0, 110)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <h3>Meetings</h3>
        {!meetings && <p style={{ color: 'var(--dim)' }}>Loading…</p>}
        {meetings?.length === 0 && <p style={{ color: 'var(--dim)' }}>No meetings yet — upload a WAV recording above.</p>}
        {meetings && meetings.length > 0 && meetings.map(m => (
          <div key={m.meetingId} className="timeline-row" style={{ gridTemplateColumns: '1fr auto auto auto' }}>
            <span>
              <Link href={`/meetings/${m.meetingId}`} style={{ color: 'var(--text)' }}>{m.title}</Link>
              <span style={{ color: 'var(--dim)', fontSize: 11 }}> · {new Date(m.startedAt).toLocaleString()}</span>
            </span>
            <span className="pill pill-gray mono" style={{ fontSize: 10 }}>{fmt(m.durationS)}</span>
            <span className={`pill ${m.diarization === 'provider' ? 'pill-green' : 'pill-amber'} mono`} style={{ fontSize: 10 }}>
              {m.speakers.length} speaker{m.speakers.length === 1 ? '' : 's'}
            </span>
            <span className="pill pill-blue mono" style={{ fontSize: 10 }}>{m.segmentCount} seg</span>
          </div>
        ))}
      </div>
    </div>
  );
}