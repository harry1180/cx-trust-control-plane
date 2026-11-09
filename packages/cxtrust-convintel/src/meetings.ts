// Meeting intelligence — diarized transcripts with word-level timestamps,
// searchable meeting store, "ask this meeting" RAG, cross-meeting search,
// clickable timestamps. Deterministic core; diarization accepts EXTERNAL
// speaker-turn boundaries (from any diarization provider — e.g. pyannote
// running in a sidecar — or simple energy/turn heuristics) rather than
// embedding a heavy model here.

import { summarizeConversation, type ConversationSummary, type ConversationTurn } from './index.ts';

// ---------- data model ----------

export interface Word {
  start: number;
  end: number;
  word: string;
  speaker?: string;
  confidence?: number;
}

export interface MeetingSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
  /** per-word timestamps (the ASR sidecar provides these) */
  words?: Word[];
  /** avg ASR logprob/confidence 0..1 if the provider supplies it */
  confidence?: number;
}

export interface Meeting {
  meetingId: string;
  title: string;
  organizationId: string;
  startedAt: string;
  durationS: number;
  language?: string;
  /** how speaker boundaries were determined — honest provenance */
  diarization: 'provider' | 'none' | 'heuristic';
  segments: MeetingSegment[];
  /** optional recording anchor so timestamps can jump back to the audio */
  recordingUrl?: string;
  createdAt: string;
  summary?: ConversationSummary;
}

/** Speakers present, ordered by speaking time. */
export function speakersOf(m: Meeting): { speaker: string; seconds: number }[] {
  const map = new Map<string, number>();
  for (const s of m.segments) map.set(s.speaker, (map.get(s.speaker) ?? 0) + (s.end - s.start));
  return Array.from(map.entries())
    .map(([speaker, seconds]) => ({ speaker, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

/** Flatten segments into the generic turn shape for the summary engine. */
function turnsOf(m: Meeting): ConversationTurn[] {
  return m.segments.map(s => ({
    participantId: s.speaker,
    text: s.text,
    offsetS: s.start,
    kind: /agent|host|speaker_?0/i.test(s.speaker) ? 'agent' : 'customer',
  }));
}

/** Summarize a meeting (reuses the conversation-intelligence engine). */
export function summarizeMeeting(m: Meeting): ConversationSummary {
  const s = summarizeConversation(turnsOf(m));
  s.durationS = m.durationS;
  return s;
}

// ---------- ask this meeting (extractive RAG) ----------

export interface AskAnswer {
  question: string;
  answer: string;
  /** quoted evidence with clickable timestamps */
  citations: { start: number; end: number; speaker: string; text: string; recordingAnchor?: string }[];
  /** honest 0..1 — lexical relevance of the answer to the question */
  confidence: number;
  unanswerable: boolean;
}

const STOP = new Set(['what', 'when', 'who', 'was', 'the', 'a', 'an', 'is', 'did', 'do', 'does', 'of', 'in', 'to', 'for', 'and', 'were', 'they', 'that', 'this', 'about', 'said', 'tell', 'me', 'can', 'you', 'any', 'there', 'how', 'much', 'many']);

/** Naive stem: strips common suffixes so 'approved' matches 'approve'. */
function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, '');
}

function termHit(term: string, lowerText: string): boolean {
  const st = stem(term);
  // prefix match on word boundaries-ish: covers approve/approved/refunds
  return lowerText.includes(term) || lowerText.includes(st);
}

/**
 * Ask this meeting: retrieve the most relevant segments and extractively
 * answer with quotes + timestamps. Deterministic; honest about weak matches
 * (unanswerable=true when relevance is low).
 */
export function askMeeting(m: Meeting, question: string): AskAnswer {
  const terms = question.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
  if (!terms.length) return { question, answer: 'Ask a more specific question.', citations: [], confidence: 0, unanswerable: true };
  const scored = m.segments.map(seg => {
    const lower = seg.text.toLowerCase();
    let hits = 0;
    for (const t of terms) if (termHit(t, lower)) hits++;
    return { seg, score: hits / terms.length };
  }).sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score >= 0.34).slice(0, 4);
  if (!top.length) {
    return { question, answer: 'No part of this meeting addresses that question.', citations: [], confidence: 0, unanswerable: true };
  }
  const citations = top.map(t => ({
    start: t.seg.start,
    end: t.seg.end,
    speaker: t.seg.speaker,
    text: t.seg.text,
    ...(m.recordingUrl ? { recordingAnchor: `${m.recordingUrl}#t=${t.seg.start.toFixed(1)}` } : {}),
  }));
  const answer = top.map(t => `${t.seg.speaker}: "${t.seg.text.slice(0, 160)}"`).join(' · ');
  const confidence = top[0].score;
  return {
    question,
    answer,
    citations,
    confidence,
    unanswerable: confidence < 0.4,
  };
}

// ---------- search across meetings ----------

export interface MeetingSearchHit {
  meetingId: string;
  title: string;
  start: number;
  end: number;
  speaker: string;
  excerpt: string;
  score: number;
  recordingAnchor?: string;
}

export function searchMeetings(meetings: Meeting[], query: string, opts: { limit?: number } = {}): MeetingSearchHit[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
  if (!terms.length) return [];
  const hits: MeetingSearchHit[] = [];
  for (const m of meetings) {
    for (const seg of m.segments) {
      const lower = seg.text.toLowerCase();
      let hitsN = 0;
      for (const t of terms) if (termHit(t, lower)) hitsN++;
      const score = hitsN / terms.length;
      if (score >= 0.5) {
        const idx = terms.map(t => lower.indexOf(t)).filter(i => i >= 0);
        const start = idx.length ? Math.max(0, Math.min(...idx) - 40) : 0;
        hits.push({
          meetingId: m.meetingId,
          title: m.title,
          start: seg.start,
          end: seg.end,
          speaker: seg.speaker,
          excerpt: seg.text.slice(start, start + 150),
          score,
          ...(m.recordingUrl ? { recordingAnchor: `${m.recordingUrl}#t=${seg.start.toFixed(1)}` } : {}),
        });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 30);
}

// ---------- diarization adapter ----------

/**
 * Assign speakers to ASR segments. If a diarization provider gave us turn
 * boundaries (list of {start, end, speaker}), overlaps are resolved by
 * max-coverage; otherwise every segment is labeled SPEAKER_0 (honest: no
 * diarization performed — the UI shows a single speaker and the provenance
 * field says 'none').
 */
export function applyDiarization(segments: MeetingSegment[], turns?: { start: number; end: number; speaker: string }[]): { segments: MeetingSegment[]; diarization: Meeting['diarization'] } {
  if (!turns || !turns.length) {
    return { segments: segments.map(s => ({ ...s, speaker: s.speaker || 'SPEAKER_0' })), diarization: 'none' };
  }
  const out = segments.map(seg => {
    const mid = (seg.start + seg.end) / 2;
    let speaker = 'SPEAKER_0';
    let best = -1;
    for (const t of turns) {
      const overlap = Math.min(seg.end, t.end) - Math.max(seg.start, t.start);
      if (overlap > best) { best = overlap; speaker = t.speaker; }
    }
    // fallback: nearest turn boundary for silence-padded segments
    if (best <= 0) {
      let nearest = Infinity;
      for (const t of turns) {
        const d = Math.abs(t.start - mid);
        if (d < nearest) { nearest = d; speaker = t.speaker; }
      }
    }
    return { ...seg, speaker };
  });
  return { segments: out, diarization: 'provider' };
}

/** Word-level timestamps across the whole meeting (clickable). */
export function wordTimeline(m: Meeting): Word[] {
  return m.segments.flatMap(s => (s.words ?? []).map(w => ({ ...w, speaker: s.speaker })));
}