// Meetings hub page.
import MeetingsClient from './MeetingsClient';

export default function MeetingsPage() {
  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Meetings</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Post-meeting intelligence: transcription (faster-whisper, local), speaker
        diarization, word-level timestamps, summaries, action items, decisions,
        topics, sentiment — searchable and askable. Timestamps link back into the
        recording when a recording URL is attached.
      </p>
      <MeetingsClient />
    </div>
  );
}
