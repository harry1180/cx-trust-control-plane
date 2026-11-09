// Behavioral feature extraction for conversational biometrics.
//
// PURE functions: same input -> same output, no I/O, no randomness, no
// thresholds baked in. Detectors (detectors.ts) own every threshold.
//
// WPM ESTIMATION (documented): turn duration is not directly observable from
// a transcript; we estimate the duration of a participant's own turn as the
// gap since THAT PARTICIPANT's previous turn (offset delta), bounded to
// 3..60 seconds. The bound keeps pauses/hold-time from producing absurd WPM.
// First turn has no prior reference, so it is excluded from WPM stats.

export interface BehaviorTurn {
  participantId: string;
  text: string;
  /** seconds into the interaction */
  offsetS: number;
  /** optional partial-transcript flag; partials are excluded by default */
  partial?: boolean;
}

export interface BehavioralFeatures {
  /** deltas between this participant's consecutive turn offsets */
  turnGaps: number[];
  meanGapS: number;
  gapVariance: number;
  /** population variance of turnGaps (0 when gaps are perfectly regular) */
  wordsPerMinute: number;
  /** variance/mean of per-turn WPM (0 when no dispersion or single turn) */
  burstiness: number;
  /** 0..1 max Jaccard-style 3-gram overlap between any two distinct turns */
  repetitionScore: number;
  /** fraction of turns containing an urgency marker */
  urgencyDensity: number;
  /** fraction of turns containing politeness markers (a FEATURE, not trust) */
  politenessScore: number;
  /** fraction of turns containing a question mark */
  questionRatio: number;
  /** fraction of turns where >50% of alphabetic chars are uppercase */
  allCapsRatio: number;
  /** compact descriptor of per-turn character-length pattern */
  charLenPattern: string;
}

export interface ParticipantFeatures {
  participantId: string;
  /** turns used for this participant's features (finals only) */
  turns: BehaviorTurn[];
  features: BehavioralFeatures;
}

const URGENCY_MARKERS = /\b(now|immediately|right away|today|hurry)\b|[!]/i;
const POLITENESS_MARKERS = /\b(please|thank(?:s| you)|sorry)\b/i;

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function normalize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
}

function ngrams(text: string, n = 3): Set<string> {
  const toks = normalize(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= toks.length; i++) {
    out.add(toks.slice(i, i + n).join(' '));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Fraction of turns containing any of the given regex markers. */
function markerFraction(turns: BehaviorTurn[], re: RegExp): number {
  if (turns.length === 0) return 0;
  return turns.filter((t) => re.test(t.text)).length / turns.length;
}

/** Compact char-length shape, e.g. "42|17|9|60" (per-turn char counts). */
function charLenPattern(turns: BehaviorTurn[]): string {
  return turns.map((t) => String(t.text.length)).join('|');
}

function extractForParticipant(participantId: string, turns: BehaviorTurn[]): ParticipantFeatures {
  const finals = turns.filter((t) => t.partial !== true);
  const sorted = [...finals].sort((a, b) => a.offsetS - b.offsetS);

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].offsetS - sorted[i - 1].offsetS);
  }

  // WPM: wordcount / estimated turn duration (gap since previous OWN turn,
  // bounded 3..60s). First turn excluded — no duration reference.
  const wpmPerTurn: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const dur = Math.min(60, Math.max(3, sorted[i].offsetS - sorted[i - 1].offsetS));
    const wc = words(sorted[i].text).length;
    wpmPerTurn.push((wc / dur) * 60);
  }
  const wpmMean = mean(wpmPerTurn);
  const wpmVar = variance(wpmPerTurn);

  // repetition: max pairwise 3-gram Jaccard across turns
  const gramSets = sorted.map((t) => ngrams(t.text));
  let maxOverlap = 0;
  for (let i = 0; i < gramSets.length; i++) {
    for (let j = i + 1; j < gramSets.length; j++) {
      const ov = jaccard(gramSets[i], gramSets[j]);
      if (ov > maxOverlap) maxOverlap = ov;
    }
  }

  // all-caps: a turn "shouts" when >50% of its alphabetic chars are uppercase
  const isAllCaps = (t: BehaviorTurn): boolean => {
    const letters = t.text.replace(/[^a-zA-Z]/g, '');
    if (letters.length < 4) return false; // ignore tiny turns like "OK"
    const upper = letters.replace(/[^A-Z]/g, '').length;
    return upper / letters.length > 0.5;
  };
  const allCapsRatio = sorted.length === 0 ? 0 : sorted.filter(isAllCaps).length / sorted.length;

  return {
    participantId,
    turns: sorted,
    features: {
      turnGaps: gaps,
      meanGapS: mean(gaps),
      gapVariance: variance(gaps),
      wordsPerMinute: wpmMean,
      burstiness: wpmMean === 0 ? 0 : wpmVar / wpmMean,
      repetitionScore: maxOverlap,
      urgencyDensity: markerFraction(sorted, URGENCY_MARKERS),
      politenessScore: markerFraction(sorted, POLITENESS_MARKERS),
      questionRatio: sorted.length === 0 ? 0 : sorted.filter((t) => t.text.includes('?')).length / sorted.length,
      allCapsRatio,
      charLenPattern: charLenPattern(sorted),
    },
  };
}

/** Group turns by participant and extract pure behavioral features per participant. */
export function extractFeatures(turns: BehaviorTurn[]): ParticipantFeatures[] {
  const byParticipant = new Map<string, BehaviorTurn[]>();
  for (const t of turns) {
    const list = byParticipant.get(t.participantId);
    if (list) list.push(t);
    else byParticipant.set(t.participantId, [t]);
  }
  return [...byParticipant.entries()].map(([pid, ts]) => extractForParticipant(pid, ts));
}

export { URGENCY_MARKERS, POLITENESS_MARKERS };
