// Conversation intelligence tests — synthetic conversations only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeConversation, searchConversations, type ConversationTurn } from '../src/index.ts';

const turns: ConversationTurn[] = [
  { participantId: 'cust', kind: 'customer', offsetS: 0, text: 'Hi, I need help with a refund for my last order, this is the second time it was charged wrong and I am really frustrated.' },
  { participantId: 'agent', kind: 'agent', offsetS: 12, text: 'I can help with the refund. Let me check your purchase history first.' },
  { participantId: 'agent', kind: 'agent', offsetS: 40, text: 'I will issue the refund for the duplicated charge now. Your refund has been processed.' },
  { participantId: 'cust', kind: 'customer', offsetS: 60, text: 'Thank you, that was helpful. When will the money arrive?' },
  { participantId: 'agent', kind: 'agent', offsetS: 70, text: 'Within five business days. Anything else?' },
];

test('summary extracts topics, actions, decisions, sentiment', () => {
  const s = summarizeConversation(turns);
  assert.ok(s.turns === 5);
  assert.ok(s.topics.length >= 3);
  assert.ok(s.topics.some(t => t.topic === 'refund'));
  assert.ok(s.actionItems.length >= 2);
  assert.ok(s.actionItems.some(a => /issue the refund/.test(a.text)));
  assert.ok(s.decisions.length >= 1);
  assert.match(s.decisions[0].text, /refund has been processed/);
  assert.equal(s.questionsAsked, 2);
  assert.ok(s.sentiment.timeline.length === 5);
  // first turn is frustrated → negative; last turn neutral-ish
  assert.equal(s.sentiment.timeline[0].label, 'NEGATIVE');
  assert.ok(s.digest.includes('refund'));
  assert.ok(s.openQuestions.length >= 1);
});

test('empty conversation yields a valid empty summary', () => {
  const s = summarizeConversation([]);
  assert.equal(s.turns, 0);
  assert.equal(s.digest, '');
  assert.equal(s.sentiment.label, 'NEUTRAL');
});

test('cross-conversation search finds matching turns across interactions', () => {
  const corpus = [
    { interactionId: 'INT-A', turns },
    { interactionId: 'INT-B', turns: [
      { participantId: 'cust', kind: 'customer', offsetS: 0, text: 'I want to change my mailing address to a new one.' },
      { participantId: 'agent', kind: 'agent', offsetS: 10, text: 'Sure, updating your mailing address now.' },
    ] },
  ];
  const hits = searchConversations(corpus, 'refund duplicated charge');
  assert.ok(hits.length >= 1);
  assert.ok(hits.every(h => h.interactionId === 'INT-A'));
  const addr = searchConversations(corpus, 'mailing address');
  assert.ok(addr.some(h => h.interactionId === 'INT-B'));
  assert.ok(searchConversations(corpus, 'quantum teleportation fees').length === 0);
});