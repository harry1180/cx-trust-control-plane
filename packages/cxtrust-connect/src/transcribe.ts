// Amazon Transcribe live-call analytics STT provider for the CX Trust
// Connect adapter.
//
// Architecture (real AWS path):
//   Connect LMA media stream (KVS consumer) → PCM audio →
//   Amazon Transcribe StartStreamTranscription (live call analytics) →
//   transcript events → Turn objects → governance API.
//
// Implements the `SpeechToTextProvider` seam using
// @aws-sdk/client-transcribe-streaming. Credentials come from the standard
// AWS SDK chain (env / profile / SSO) — never from this repo.
//
// Degradation is explicit: without credentials/network the provider throws a
// labeled error (no silent fallback to scripted output).
//
// Offline testing: `parseTranscriptEvent` unit tests + `PlaybackAudioSource`
// feed real WAV audio through the identical provider path.

import type { SpeechToTextProvider, Turn } from './index.ts';

/** Audio source abstraction: live media stream or WAV file playback. */
export interface AudioSource {
  /** 16kHz mono 16-bit PCM chunks */
  chunks(): AsyncIterable<Buffer>;
}

/** Parsed utterance produced by the STT stream. */
export interface SttUtterance {
  speaker: 'CUSTOMER' | 'AGENT';
  text: string;
  offsetS: number;
  confidence: number;
}

export interface TranscribeConfig {
  region?: string;
  /** language code, default en-US */
  languageCode?: string;
  /** enable live call analytics (speaker partition + channel definitions) */
  liveCallAnalytics?: boolean;
}

export class TranscribeLiveCallProvider implements SpeechToTextProvider {
  readonly id = 'amazon-transcribe-live-call-analytics';
  private cfg: TranscribeConfig;

  constructor(cfg: TranscribeConfig = {}) {
    this.cfg = {
      region: process.env.AWS_REGION ?? 'us-east-1',
      languageCode: 'en-US' as const,
      liveCallAnalytics: true,
      ...cfg,
    } as TranscribeConfig & { languageCode: 'en-US' | 'en-GB' | 'es-US' };
  }

  async *transcribe(input: {
    contactId: string;
    customerPhoneNumber?: string;
    audioSource?: AudioSource;
    metadata?: Record<string, unknown>;
  }): AsyncIterable<Turn> {
    if (!input.audioSource) {
      throw new Error(
        `[${this.id}] no audio source provided — live transcription requires a ` +
        'real media stream or PlaybackAudioSource. Use ScriptedCallTranscriber for demos.',
      );
    }

    const { TranscribeStreamingClient, StartStreamTranscriptionCommand } =
      await import('@aws-sdk/client-transcribe-streaming');

    const client = new TranscribeStreamingClient({ region: this.cfg.region });
    const lca = this.cfg.liveCallAnalytics;

    const audioStream = async function* (src: AudioSource) {
      for await (const chunk of src.chunks()) {
        yield { AudioChunk: new Uint8Array(chunk) };
      }
    };

    const command = new StartStreamTranscriptionCommand({
      LanguageCode: (this.cfg.languageCode ?? 'en-US') as 'en-US',
      MediaEncoding: 'pcm' as const,
      MediaSampleRateHertz: 16000,
      AudioStream: audioStream(input.audioSource) as never,
      ...(lca
        ? {
            EnableChannelIdentification: true,
            ChannelDefinitions: [
              { ChannelId: 0, ParticipantRole: 'CUSTOMER' as const },
              { ChannelId: 1, ParticipantRole: 'AGENT' as const },
            ],
            ShowSpeakerLabel: true,
          }
        : {}),
    });

    // The SDK consumes AudioStream while streaming results; credential or
    // network failures throw BEFORE audio is consumed — that error propagates
    // as a labeled failure to the adapter, which surfaces it to governance.
    const response = await client.send(command);

    for await (const event of response.TranscriptResultStream ?? []) {
      for (const u of parseTranscriptEvent(event as never)) {
        yield { text: u.text, speaker: u.speaker, offsetS: u.offsetS };
      }
    }
  }
}

/**
 * WAV file → 16kHz mono PCM chunk source for offline tests and playback:
 * feeds the STT provider exactly what a live media stream would deliver.
 */
export class PlaybackAudioSource implements AudioSource {
  private wav: Buffer;
  constructor(wav: Buffer) {
    this.wav = wav;
  }

  async *chunks(): AsyncIterable<Buffer> {
    const start = wavDataOffset(this.wav);
    const chunkMs = 100;
    const bytesPerMs = (16000 * 2) / 1000; // 16kHz mono 16-bit
    const size = Math.floor(chunkMs * bytesPerMs);
    for (let i = start; i < this.wav.length; i += size) {
      yield this.wav.subarray(i, Math.min(i + size, this.wav.length));
      await new Promise(r => setTimeout(r, chunkMs)); // real-time pacing
    }
  }
}

/** Find the data-chunk offset of a standard WAV file (defaults to 44). */
export function wavDataOffset(buf: Buffer): number {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 44;
  // search for the 'data' chunk header
  for (let i = 12; i < Math.min(buf.length - 8, 4096); i += 1) {
    if (buf.toString('ascii', i, i + 4) === 'data') {
      return i + 8;
    }
  }
  return 44;
}

/** Collect utterances from a Transcribe transcript event (exported for tests). */
export function parseTranscriptEvent(ev: {
  TranscriptEvent?: {
    Transcript?: {
      Results?: Array<{
        IsPartial?: boolean; ChannelId?: number; StartTime?: number;
        Alternatives?: Array<{ Transcript?: string; Items?: Array<{ Confidence?: number }> }>;
      }>;
    };
  };
}): SttUtterance[] {
  const out: SttUtterance[] = [];
  const results = ev.TranscriptEvent?.Transcript?.Results ?? [];
  for (const r of results) {
    if (r.IsPartial) continue;
    for (const alt of r.Alternatives ?? []) {
      const text = (alt.Transcript ?? '').trim();
      if (!text) continue;
      const items = alt.Items ?? [];
      const confidence = items.length
        ? items.reduce((s, i) => s + (i.Confidence ?? 0), 0) / items.length
        : 0.8;
      out.push({
        speaker: r.ChannelId === 1 ? 'AGENT' : 'CUSTOMER',
        text,
        offsetS: Math.round((r.StartTime ?? 0) * 10) / 10,
        confidence,
      });
    }
  }
  return out;
}