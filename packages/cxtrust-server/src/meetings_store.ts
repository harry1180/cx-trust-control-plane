// Meeting store — sqlite persistence for meetings (diarized transcripts,
// summaries). Separate table, same DatabaseSync pattern as the governance
// store. Transcripts are stored as JSON; segments are re-hydrated.

export interface MeetingRow {
  meetingId: string;
  organizationId: string;
  title: string;
  startedAt: string;
  durationS: number;
  language?: string;
  diarization: string;
  recordingUrl?: string;
  segmentsJson: string;
  summaryJson?: string;
  createdAt: string;
}

export class MeetingStore {
  private db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }; exec(sql: string): void };
  constructor(db: { prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }; exec(sql: string): void }) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        meetingId TEXT PRIMARY KEY,
        organizationId TEXT NOT NULL,
        title TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        durationS REAL NOT NULL,
        language TEXT,
        diarization TEXT NOT NULL,
        recordingUrl TEXT,
        segmentsJson TEXT NOT NULL,
        summaryJson TEXT,
        createdAt TEXT NOT NULL
      )
    `);
  }

  upsert(m: MeetingRow): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO meetings
      (meetingId, organizationId, title, startedAt, durationS, language, diarization, recordingUrl, segmentsJson, summaryJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(m.meetingId, m.organizationId, m.title, m.startedAt, m.durationS,
      m.language ?? null, m.diarization, m.recordingUrl ?? null,
      m.segmentsJson, m.summaryJson ?? null, m.createdAt);
  }

  get(meetingId: string): MeetingRow | undefined {
    return this.db.prepare('SELECT * FROM meetings WHERE meetingId = ?').get(meetingId) as MeetingRow | undefined;
  }

  list(opts?: { organizationId?: string; limit?: number }): MeetingRow[] {
    const rows = (opts?.organizationId
      ? this.db.prepare('SELECT * FROM meetings WHERE organizationId = ? ORDER BY startedAt DESC').all(opts.organizationId)
      : this.db.prepare('SELECT * FROM meetings ORDER BY startedAt DESC').all()) as MeetingRow[];
    return rows.slice(0, opts?.limit ?? 100);
  }

  delete(meetingId: string): void {
    this.db.prepare('DELETE FROM meetings WHERE meetingId = ?').run(meetingId);
  }
}