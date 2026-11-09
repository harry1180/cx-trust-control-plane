// Meetings pipeline tests: ask/search/diarization logic (unit) + API flow
// against a mocked asr-worker (no model download in CI).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/index.ts';
import { SqliteStore } from '../src/store.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as http from 'node:http';
import {
  applyDiarization, askMeeting, searchMeetings, summarizeMeeting, wordTimeline,
  type Meeting, type MeetingSegment,
} from '@cxtrust/convintel/src/all.ts';

// ---------- unit: diarization + ask + search ----------

const segs: MeetingSegment[] = [
  { start: 0, end: 5, text: 'We decided to approve the refund of two hundred dollars.', speaker: '' },
  { start: 5, end: 9, text: 'The refund will arrive within five business days.', speaker: '' },
  { start: 9, end: 13, text: 'I will send the confirmation email today.', speaker: '' },
];

test('applyDiarization with provider turns assigns speakers by coverage', () => {
  const { segments, diarization } = applyDiarization(segs, [
    { start: 0, end: 6, speaker: 'Alice' },
    { start: 6, end: 13, speaker: 'Bob' },
  ]);
  assert.equal(diarization, 'provider');
  assert.equal(segments[0].speaker, 'Alice');
  assert.equal(segments[1].speaker, 'Bob');
  assert.equal(segments[2].speaker, 'Bob');
});

test('applyDiarization without turns is honest: diarization=none, single speaker', () => {
  const { segments, diarization } = applyDiarization(segs, undefined);
  assert.equal(diarization, 'none');
  assert.ok(segments.every(s => s.speaker === 'SPEAKER_0'));
});

const meeting: Meeting = {
  meetingId: 'MTG-T1', title: 'Refund sync', organizationId: 'org', startedAt: new Date().toISOString(),
  durationS: 13, diarization: 'provider',
  segments: applyDiarization(segs, [
    { start: 0, end: 6, speaker: 'Alice' },
    { start: 6, end: 13, speaker: 'Bob' },
  ]).segments,
  createdAt: new Date().toISOString(),
};

test('askMeeting answers with citations + clickable timestamps; honest unanswerable', () => {
  const a = askMeeting(meeting, 'what refund amount was approved?');
  assert.equal(a.unanswerable, false);
  assert.ok(a.answer.includes('refund'));
  assert.ok(a.citations.length >= 1);
  assert.equal(a.citations[0].speaker, 'Alice');
  const b = askMeeting(meeting, 'quantum unicorns');
  assert.equal(b.unanswerable, true);
});

test('searchMeetings finds segments across meetings with timestamps', () => {
  const hits = searchMeetings([meeting], 'confirmation email');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].speaker, 'Bob');
  assert.equal(hits[0].start, 9);
});

test('summarizeMeeting extracts decisions/actions/topics + sentiment', () => {
  const s = summarizeMeeting(meeting);
  assert.ok(s.decisions.length >= 1);
  assert.ok(s.actionItems.length >= 1);
  assert.ok(s.topics.some(t => t.topic === 'refund'));
  assert.ok(['NEGATIVE', 'NEUTRAL', 'POSITIVE'].includes(s.sentiment.label));
  assert.equal(s.durationS, 13);
});

test('wordTimeline flattens word timestamps with speaker attribution', () => {
  const withWords: Meeting = {
    ...meeting,
    segments: meeting.segments.map((s, i) => ({
      ...s,
      words: [{ start: s.start, end: s.start + 1, word: 'hello', speaker: undefined }],
    })),
  };
  const tl = wordTimeline(withWords);
  assert.equal(tl.length, 3);
  assert.equal(tl[0].speaker, 'Alice');
});

// ---------- API flow with a MOCK asr-worker ----------

const FAKE_ASR = {
  language: 'en',
  segments: [
    { start: 0, end: 4, text: 'We approved the refund of two hundred dollars.', words: [{ start: 0, end: 0.5, word: 'We' }] },
    { start: 4, end: 8, text: 'I will send the confirmation email today.', words: [{ start: 4, end: 4.5, word: 'I' }] },
  ],
  durationS: 8,
};

let server: Server;
let asrServer: http.Server;
let base = '';

test.before(async () => {
  // spin a fake asr-worker on a free port
  asrServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(FAKE_ASR));
  });
  await new Promise<void>(r => asrServer.listen(0, () => r()));
  process.env.ASR_SIDECAR_URL = `http://127.0.0.1:${(asrServer.address() as AddressInfo).port}`;

  server = createApi({ port: 0, store: new SqliteStore(':memory:') });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after(() => {
  server.close();
  asrServer.close();
  server.closeAllConnections?.();
  asrServer.closeAllConnections?.();
});

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('API: transcribe → persisted meeting with diarization + summary; ask + search work', async () => {
  const t = await req('POST', '/v1/meetings/transcribe', {
    title: 'Refund sync', audio_base64: 'ZmFrZQ==', // fake bytes; the mock ASR ignores them
    diarizationTurns: [{ start: 0, end: 5, speaker: 'Alice' }, { start: 5, end: 8, speaker: 'Bob' }],
    recordingUrl: 'https://example.com/rec.m4a',
  });
  assert.equal(t.status, 201);
  assert.equal(t.json.diarization, 'provider');
  assert.ok(t.json.summary);
  const id = String(t.json.meetingId);

  const list = await req('GET', '/v1/meetings');
  assert.equal((list.json.meetings as { meetingId: string; sentimentLabel?: string }[]).length, 1);
  const label = (list.json.meetings as { sentimentLabel?: string }[])[0].sentimentLabel;
  assert.ok(label === undefined || ['NEGATIVE', 'NEUTRAL', 'POSITIVE'].includes(label), `sentiment label ${label}`);

  const ask = await req('GET', `/v1/meetings/${id}/ask?q=${encodeURIComponent('what was approved?')}`);
  assert.equal(ask.status, 200);
  assert.equal((ask.json as { unanswerable: boolean }).unanswerable, false);

  const search = await req('GET', `/v1/meetings/${id}/search?q=confirmation`);
  assert.equal(search.status, 200);
  assert.ok(((search.json as { hits: unknown[] }).hits).length >= 1);

  const cross = await req('GET', '/v1/meetings-search?q=refund');
  assert.equal(cross.status, 200);
  assert.ok(((cross.json as { hits: { meetingId: string }[] }).hits)[0].meetingId === id);

  const del = await req('DELETE', `/v1/meetings/${id}`);
  assert.equal(del.status, 200);
});