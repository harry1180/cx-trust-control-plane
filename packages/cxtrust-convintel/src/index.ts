// Conversation intelligence — post-interaction extraction over the stored
// transcript. Deterministic extractive core (no LLM required); an optional
// LLM provider seam exists for richer summaries. Reuses the governance
// timeline/transcript rather than a separate speech stack.

export interface ConversationTurn {
  participantId: string;
  text: string;
  offsetS: number;
  kind?: 'customer' | 'agent' | string;
}

export interface ActionItem {
  text: string;
  offsetS: number;
  who: string;
}

export interface Decision {
  text: string;
  offsetS: number;
}

export interface Topic {
  topic: string;
  mentions: number;
  firstOffsetS: number;
}

export interface SentimentPoint {
  offsetS: number;
  /** -1..1 */
  score: number;
  label: 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE';
}

export interface ConversationSummary {
  turns: number;
  durationS: number;
  topics: Topic[];
  actionItems: ActionItem[];
  decisions: Decision[];
  sentiment: { overall: number; label: SentimentPoint['label']; timeline: SentimentPoint[] };
  /** 2-3 sentence extractive summary built from the highest-information turns */
  digest: string;
  questionsAsked: number;
  openQuestions: string[];
}

// ---------- lexicons (small, deterministic, no deps) ----------

const NEGATIVE = ['angry', 'furious', 'terrible', 'awful', 'unacceptable', 'frustrated', 'frustrating', 'ridiculous', 'horrible', 'worst', 'hate', 'scam', 'lie', 'lying', 'complaint', 'cancel everything', 'never again', 'fed up', 'disgusted', 'appalling'];
const POSITIVE = ['great', 'wonderful', 'perfect', 'excellent', 'thank', 'thanks', 'appreciate', 'helpful', 'fantastic', 'good', 'resolved', 'fixed', 'happy', 'love', 'awesome'];

const ACTION_PATTERNS: RegExp[] = [
  /\bI will (?:go ahead and )?(?:send|process|transfer|issue|update|check|review|escalate|call|email|schedule|refund)\b[^.!?]*/i,
  /\b(?:we|I)'?ll (?:send|process|transfer|issue|update|check|review|escalate|call|email|schedule|refund)\b[^.!?]*/i,
  /\b(?:please )?(?:send|email) (?:me|us|you) (?:the |a )?[a-z ]+\b[^.!?]*/i,
  /\blet me (?:check|review|look into|pull up|transfer|process|update)\b[^.!?]*/i,
];

const DECISION_PATTERNS: RegExp[] = [
  /\b(?:we'?ve|we have|we|i'?ve|i have|i)\s+(?:decided|approved|confirmed|processed|issued|updated|completed)\b[^.!?]*/i,
  /\b(?:we are|we're) (?:going to|going)\b[^.!?]*/i,
  /\byour (?:refund|payment|claim|address|account) (?:has been|was|is now)\b[^.!?]*/i,
  /\bwe (?:will|won't|cannot) (?:be able to )?(?:approve|issue|process|refund|honor)\b[^.!?]*/i,
];

const TOPIC_STOP = new Set(['this', 'that', 'with', 'have', 'will', 'your', 'from', 'they', 'just', 'what', 'about', 'there', 'would', 'could', 'should', 'account', 'customer', 'please', 'thank', 'thanks', 'hello', 'help']);

export function summarizeConversation(turns: ConversationTurn[], opts: { maxDigestTurns?: number } = {}): ConversationSummary {
  const maxDigest = opts.maxDigestTurns ?? 3;
  const actionItems: ActionItem[] = [];
  const decisions: Decision[] = [];
  const sentiment: SentimentPoint[] = [];
  const openQuestions: string[] = [];
  let questionsAsked = 0;
  const topicCounts = new Map<string, { n: number; first: number }>();

  for (const t of turns) {
    const words = t.text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !TOPIC_STOP.has(w));
    for (const w of words) {
      const cur = topicCounts.get(w);
      if (cur) cur.n++;
      else topicCounts.set(w, { n: 1, first: t.offsetS });
    }
    for (const re of ACTION_PATTERNS) {
      const m = t.text.match(re);
      if (m) { actionItems.push({ text: m[0].trim().slice(0, 140), offsetS: t.offsetS, who: t.participantId }); break; }
    }
    for (const re of DECISION_PATTERNS) {
      const m = t.text.match(re);
      if (m) { decisions.push({ text: m[0].trim().slice(0, 140), offsetS: t.offsetS }); break; }
    }
    const q = t.text.match(/\?/g);
    if (q) {
      questionsAsked += q.length;
      const qm = t.text.match(/[^.!?]*\?/);
      if (qm && t.kind !== 'agent') openQuestions.push(qm[0].trim().slice(0, 120));
    }
    let score = 0;
    for (const w of NEGATIVE) if (t.text.toLowerCase().includes(w)) score -= 0.4;
    for (const w of POSITIVE) if (t.text.toLowerCase().includes(w)) score += 0.3;
    score = Math.max(-1, Math.min(1, score));
    sentiment.push({ offsetS: t.offsetS, score, label: score < -0.15 ? 'NEGATIVE' : score > 0.15 ? 'POSITIVE' : 'NEUTRAL' });
  }

  const topics: Topic[] = Array.from(topicCounts.entries())
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 8)
    .map(([topic, v]) => ({ topic, mentions: v.n, firstOffsetS: v.first }));

  const overall = sentiment.length ? sentiment.reduce((s, p) => s + p.score, 0) / sentiment.length : 0;
  const overallLabel: SentimentPoint['label'] = overall < -0.15 ? 'NEGATIVE' : overall > 0.15 ? 'POSITIVE' : 'NEUTRAL';

  // extractive digest: highest-signal turns (longest substantive content,
  // decisions and actions weighted), in chronological order
  const scored = turns.map((t, i) => ({
    t, i,
    w: t.text.length
      + (DECISION_PATTERNS.some(re => re.test(t.text)) ? 400 : 0)
      + (ACTION_PATTERNS.some(re => re.test(t.text)) ? 300 : 0),
  })).sort((a, b) => b.w - a.w).slice(0, maxDigest).sort((a, b) => a.i - b.i);
  const digest = scored.map(x => `${x.t.participantId}: "${x.t.text.slice(0, 90)}${x.t.text.length > 90 ? '…' : ''}"`).join(' → ');

  return {
    turns: turns.length,
    durationS: turns.length ? turns[turns.length - 1].offsetS - turns[0].offsetS : 0,
    topics, actionItems, decisions,
    sentiment: { overall, label: overallLabel, timeline: sentiment },
    digest,
    questionsAsked,
    openQuestions: openQuestions.slice(0, 5),
  };
}

// ---------- cross-conversation search ----------

export interface SearchHit {
  interactionId: string;
  offsetS: number;
  participantId: string;
  /** matching excerpt with the query terms */
  excerpt: string;
  score: number;
}

/** Simple lexical search across stored conversations (term overlap + idf-lite). */
export function searchConversations(
  corpus: { interactionId: string; turns: ConversationTurn[] }[],
  query: string,
  opts: { limit?: number } = {},
): SearchHit[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const conv of corpus) {
    for (const t of conv.turns) {
      const lower = t.text.toLowerCase();
      let score = 0;
      for (const term of terms) if (lower.includes(term)) score++;
      score /= terms.length;
      if (score >= 0.5) {
        const idx = terms.map(term => lower.indexOf(term)).filter(i => i >= 0);
        const start = idx.length ? Math.max(0, Math.min(...idx) - 40) : 0;
        hits.push({
          interactionId: conv.interactionId,
          offsetS: t.offsetS,
          participantId: t.participantId,
          excerpt: t.text.slice(start, start + 140),
          score,
        });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 20);
}