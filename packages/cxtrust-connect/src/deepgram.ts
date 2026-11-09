// Deepgram live speech-to-text provider for the CX Trust Control Plane.
//
// Opens a bidirectional WebSocket to Deepgram's streaming STT endpoint
// (wss://api.deepgram.com/v1/listen, linear16 16kHz mono), pumps AudioSource
// PCM chunks as binary frames, and parses final Results messages into Turn
// objects for the governance pipeline.
//
// Config:
//   CXTRUST_DEEPGRAM_KEY   auth token (read at request time — never logged)
//   CXTRUST_DEEPGRAM_MODEL model, default nova-2
//   CXTRUST_DEEPGRAM_URL   endpoint override (tests use ws:// mock servers)
//
// Degradation is explicit: without a key the provider throws a labeled error
// before connecting (no silent fallback to scripted output). WS/network
// failures surface as labeled errors with status detail.
//
// MOCK testing: tests point CXTRUST_DEEPGRAM_URL at a local ws:// server that
// mimics the Deepgram Results message shape. No real Deepgram call is made.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';
import type { SpeechToTextProvider, Turn } from './index.ts';
import type { AudioSource } from './transcribe.ts';
export { PlaybackAudioSource, wavDataOffset } from './transcribe.ts';

const LABEL = '[deepgram-stt]';

export interface DeepgramConfig {
  /** WS endpoint override (default wss://api.deepgram.com/v1/listen; CXTRUST_DEEPGRAM_URL) */
  baseUrl?: string;
  /** model, default nova-2 (CXTRUST_DEEPGRAM_MODEL) */
  model?: string;
  /**
   * When true, ONLY the CXTRUST_DEEPGRAM_KEY env var is consulted — the
   * .deepgram-key file fallback is skipped. Used by tests that assert the
   * no-credentials labeled failure while a real key file exists on disk.
   */
  ignoreKeyFile?: boolean;
}

/** One parsed Deepgram Results message (subset we consume). */
export interface DeepgramResultsMessage {
  type: 'Results';
  is_final?: boolean;
  start?: number;
  end?: number;
  channel?: {
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
  };
}

/** Parse a Deepgram Results message into Turns (exported for MOCK tests). */
export function parseDeepgramResults(msg: DeepgramResultsMessage): Turn[] {
  if (msg.type !== 'Results' || !msg.is_final) return [];
  const text = (msg.channel?.alternatives?.[0]?.transcript ?? '').trim();
  if (!text) return [];
  return [{
    text,
    speaker: 'CUSTOMER',
    offsetS: Math.round((msg.start ?? 0) * 10) / 10,
  }];
}

export class DeepgramLiveSTTProvider implements SpeechToTextProvider {
  readonly id = 'deepgram-live-stt';
  private cfg: DeepgramConfig;

  constructor(cfg: DeepgramConfig = {}) {
    this.cfg = cfg;
  }

  async *transcribe(input: {
    contactId?: string;
    callSid?: string;
    customerPhoneNumber?: string;
    audioSource?: AudioSource;
    metadata?: Record<string, unknown>;
  }): AsyncIterable<Turn> {
    // key resolution: env first, then a local .deepgram-key file (gitignored)
    // so long keys never have to survive a shell paste
    let key = process.env.CXTRUST_DEEPGRAM_KEY;
    if (!key && !this.cfg.ignoreKeyFile) {
      const here = dirname(fileURLToPath(import.meta.url));
      for (const p of [resolve(here, '../.deepgram-key'), resolve(here, '.deepgram-key'), resolve(here, '../../.deepgram-key')]) {
        try {
          const v = readFileSync(p, 'utf8').trim().split(String.fromCharCode(10))[0];
          if (v) { key = v; break; }
        } catch { /* not present */ }
      }
    }
    if (!key) {
      throw new Error(
        `${LABEL} CXTRUST_DEEPGRAM_KEY not set (env or .deepgram-key file) — live transcription unavailable (no silent fallback)`,
      );
    }
    if (!input.audioSource) {
      throw new Error(
        `${LABEL} no audio source provided — live transcription requires a real ` +
        'media stream or PlaybackAudioSource (no scripted fallback).',
      );
    }

    const model = this.cfg.model ?? process.env.CXTRUST_DEEPGRAM_MODEL ?? 'nova-2';
    const base = this.cfg.baseUrl
      ?? process.env.CXTRUST_DEEPGRAM_URL
      ?? 'wss://api.deepgram.com/v1/listen';
    const url = `${base}?encoding=linear16&sample_rate=16000&channels=1&interim_results=false&model=${encodeURIComponent(model)}`;

    const ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });

    // ---- queue of parsed turns + failure state (wake-based generator loop)
    const turns: Turn[] = [];
    let wake: (() => void) | null = null;
    let streamErr: Error | null = null;
    let closed = false;
    let gracefulClosing = false;
    const notify = () => { const w = wake; wake = null; if (w) w(); };

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return; // keepalive/meta binary frames ignored
      try {
        const msg = JSON.parse(data.toString('utf8')) as DeepgramResultsMessage;
        turns.push(...parseDeepgramResults(msg));
      } catch {
        // non-JSON control frame — ignore
      }
      notify();
    });
    ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
      streamErr = new Error(`${LABEL} endpoint rejected the stream (HTTP ${res.statusCode ?? 'unknown'}) from ${base}`);
      notify();
    });
    ws.on('error', (err: Error) => {
      streamErr = new Error(`${LABEL} websocket error for ${base}: ${err.message}`);
      notify();
    });
    ws.on('close', (code: number) => {
      closed = true;
      if (!gracefulClosing) {
        streamErr = streamErr ?? new Error(
          `${LABEL} connection closed unexpectedly by the remote end (code ${code}) — live transcription stream terminated`,
        );
      }
      notify();
    });

    const opened = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', err => reject(new Error(`${LABEL} websocket error for ${base}: ${err.message}`)));
      ws.once('unexpected-response', (_req: unknown, res: { statusCode?: number }) =>
        reject(new Error(`${LABEL} endpoint rejected the stream (HTTP ${res.statusCode ?? 'unknown'}) from ${base}`)));
    });
    try {
      await opened;
    } catch (err) {
      try { ws.terminate(); } catch { /* ignore */ }
      throw err;
    }

    // pump AudioSource chunks as binary WS frames; graceful close at source end
    void (async () => {
      try {
        for await (const chunk of input.audioSource!.chunks()) {
          if (ws.readyState !== WebSocket.OPEN) break;
          await new Promise<void>((resolve, reject) => {
            ws.send(chunk, err => (err ? reject(err) : resolve()));
          });
        }
        // graceful close: Deepgram flushes finals after CloseStream
        gracefulClosing = true;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        ws.close();
      } catch (err) {
        streamErr = streamErr ?? new Error(`${LABEL} audio pump failed: ${(err as Error).message}`);
        try { ws.terminate(); } catch { /* ignore */ }
      } finally {
        notify();
      }
    })();

    try {
      for (;;) {
        while (turns.length > 0) {
          yield turns.shift()!;
        }
        if (streamErr) throw streamErr;
        if (closed && gracefulClosing) return;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }
}
