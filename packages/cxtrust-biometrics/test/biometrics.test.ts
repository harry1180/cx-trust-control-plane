// Contract tests for behavioral biometrics detection.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures } from '../src/features.ts';
import {
  analyzeBehavior,
  roboCadence,
  scriptFollowing,
  urgencyEscalation,
  wpmAnomaly,
} from '../src/detectors.ts';

function ctx() {
  return { interactionId: 'i-1', now: '2026-01-01T00:00:00Z', offsetS: 0 };
}

function botTurns(gap = 2.0, n = 5): Parameters<typeof extractFeatures>[0] {
  return Array.from({ length: n }, (_, i) => ({
    participantId: 'bot',
    text: 'please verify your account now',
    offsetS: 10 + i * gap,
  }));
}

test('extractFeatures: pure and deterministic — same input, same output twice', () => {
  const turns = botTurns();
  const a = JSON.stringify(extractFeatures(turns));
  const b = JSON.stringify(extractFeatures(turns));
  assert.equal(a, b);
});

test('robo_cadence fires on perfectly regular 2.0s-gap bot turns (>=4 turns)', () => {
  const pf = extractFeatures(botTurns(2.0, 5))[0];
  assert.equal(pf.features.turnGaps.length, 4);
  assert.equal(pf.features.gapVariance, 0);
  const d = roboCadence(pf, ctx());
  assert.ok(d);
  assert.equal(d.code, 'robo_cadence');
  assert.ok(d.evidence.some((e) => e.text.includes('gap variance')));
  assert.equal(d.providerId, 'behavioral-v1');
});

test('robo_cadence does NOT fire on human-varied gaps', () => {
  const gaps = [3.2, 7.5, 2.1, 11.8, 4.4, 6.9, 2.7];
  const turns = gaps.map((g, i) => ({
    participantId: 'human',
    text: `hi there, how are you doing today? turn ${i}`,
    offsetS: 10 + gaps.slice(0, i + 1).reduce((a, b) => a + b, 0),
  }));
  const pf = extractFeatures(turns)[0];
  assert.equal(roboCadence(pf, ctx()), null);
});

test('robo_cadence returns null on insufficient data (3 turns)', () => {
  const pf = extractFeatures(botTurns(2.0, 3))[0];
  assert.equal(roboCadence(pf, ctx()), null);
});

test('script_following fires on repeated-script turns with low question ratio', () => {
  const script = 'do not be alarmed this is your bank security team calling about your account today';
  const turns = Array.from({ length: 5 }, (_, i) => ({
    participantId: 'scammer',
    text: `${script} step ${i % 2 === 0 ? 'one' : 'two'}`, // heavy 3-gram overlap
    offsetS: 10 + i * 9,
  }));
  const pf = extractFeatures(turns)[0];
  assert.ok(pf.features.repetitionScore > 0.6, `repetition=${pf.features.repetitionScore}`);
  const d = scriptFollowing(pf, ctx());
  assert.ok(d);
  assert.equal(d.code, 'script_following');
});

test('script_following does NOT fire on varied natural conversation', () => {
  const texts = [
    'hi, I was calling because my card stopped working at the store yesterday',
    'oh no, that sounds annoying, did you try the ATM as well maybe',
    'yes I did, and it also declined there, which was strange honestly',
    'okay, let me take a look at the account and see what I can find out',
    'thanks, I appreciate you checking that for me right now',
  ];
  const turns = texts.map((t, i) => ({ participantId: 'human', text: t, offsetS: 10 + i * 8 }));
  const pf = extractFeatures(turns)[0];
  assert.equal(scriptFollowing(pf, ctx()), null);
});

test('script_following returns null on insufficient data (2 turns)', () => {
  const turns = [
    { participantId: 'p', text: 'do not be alarmed this is your bank security team calling', offsetS: 10 },
    { participantId: 'p', text: 'do not be alarmed this is your bank security team calling', offsetS: 20 },
  ];
  const pf = extractFeatures(turns)[0];
  assert.equal(scriptFollowing(pf, ctx()), null);
});

test('urgency_escalation fires on escalating urgency corpus', () => {
  const texts = [
    'hello, this is a routine call about your account service',
    'could you confirm your details when you have a moment please',
    'listen, I need you to move the money NOW',
    'we must act IMMEDIATELY before it is too late!',
    'do it right away, hurry, the police are coming!',
    'TODAY, NOW, move the funds immediately or else!',
  ];
  const turns = texts.map((t, i) => ({ participantId: 'p', text: t, offsetS: 10 + i * 8 }));
  const pf = extractFeatures(turns)[0];
  const d = urgencyEscalation(pf, ctx());
  assert.ok(d, `firstThird/lastThird not escalating?`);
  assert.equal(d.code, 'urgency_escalation');
});

test('urgency_escalation does NOT fire on constant-low urgency', () => {
  const texts = [
    'hi, quick question about my balance today',
    'sure, could you tell me the amount please',
    'it says pending right now, that is odd',
    'okay thanks, one more thing if I may',
    'no worries, that is all for today',
    'great, have a good day',
  ];
  const turns = texts.map((t, i) => ({ participantId: 'p', text: t, offsetS: 10 + i * 8 }));
  const pf = extractFeatures(turns)[0];
  assert.equal(urgencyEscalation(pf, ctx()), null);
});

test('wpm_anomaly fires on 400 WPM turns (TTS/tape-speed)', () => {
  // each turn: 40 words arriving 6s after the previous own turn => 400 WPM
  const words40 = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const turns = Array.from({ length: 5 }, (_, i) => ({
    participantId: 'tape',
    text: words40,
    offsetS: 10 + i * 6,
  }));
  const pf = extractFeatures(turns)[0];
  assert.ok(pf.features.wordsPerMinute > 350, `wpm=${pf.features.wordsPerMinute}`);
  const d = wpmAnomaly(pf, ctx());
  assert.ok(d);
  assert.equal(d.code, 'wpm_anomaly');
  assert.ok(d.evidence.some((e) => e.text.includes('WPM')));
});

test('wpm_anomaly does NOT fire on normal-pace speech', () => {
  // ~150 WPM: 15 words per 6s gap
  const words15 = Array.from({ length: 15 }, (_, i) => `word${i}`).join(' ');
  const turns = Array.from({ length: 5 }, (_, i) => ({
    participantId: 'human',
    text: words15,
    offsetS: 10 + i * 6,
  }));
  const pf = extractFeatures(turns)[0];
  assert.ok(pf.features.wordsPerMinute > 100 && pf.features.wordsPerMinute < 220);
  assert.equal(wpmAnomaly(pf, ctx()), null);
});

test('analyzeBehavior: insufficient data (2-turn conversation) returns empty', () => {
  const turns = [
    { participantId: 'a', text: 'hello there', offsetS: 5 },
    { participantId: 'b', text: 'hi, how can I help you today', offsetS: 8 },
  ];
  assert.deepEqual(analyzeBehavior(turns, ctx()), []);
});

test('analyzeBehavior: multi-participant isolation — bot flagged, human not', () => {
  const turns: Parameters<typeof extractFeatures>[0] = [
    ...botTurns(2.0, 5),
    ...Array.from({ length: 5 }, (_, i) => ({
      participantId: 'human',
      text: `sure, let me look into that account for you now, one moment please`,
      offsetS: 12 + i * 9.7, // varied gaps, human cadence
    })),
  ];
  const dets = analyzeBehavior(turns, ctx());
  const flagged = dets.filter((d) => d.code === 'robo_cadence');
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].participantId, 'bot');
  assert.ok(!dets.some((d) => d.code === 'robo_cadence' && d.participantId === 'human'));
});

test('analyzeBehavior: partial turns are excluded from features', () => {
  const turns = [
    ...botTurns(2.0, 5),
    { participantId: 'bot', text: 'interrupting partial nonsense', offsetS: 20, partial: true },
  ];
  const pf = extractFeatures(turns)[0];
  assert.equal(pf.turns.length, 5);
  const dets = analyzeBehavior(turns, ctx());
  assert.ok(dets.some((d) => d.code === 'robo_cadence'));
});

test('urgency_escalation returns null on insufficient data (<6 turns)', () => {
  const texts = ['move NOW', 'move NOW!', 'do it TODAY immediately', 'hurry right away'];
  const turns = texts.map((t, i) => ({ participantId: 'p', text: t, offsetS: 10 + i * 5 }));
  const pf = extractFeatures(turns)[0];
  assert.equal(urgencyEscalation(pf, ctx()), null);
});

test('wpm_anomaly returns null on insufficient data (2 turns)', () => {
  const turns = [
    { participantId: 'p', text: 'hello there friend', offsetS: 10 },
    { participantId: 'p', text: 'second very fast turn with many words here', offsetS: 11 },
  ];
  const pf = extractFeatures(turns)[0];
  assert.equal(wpmAnomaly(pf, ctx()), null);
});
