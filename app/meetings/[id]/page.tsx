// Meeting detail page (dynamic route).
import MeetingDetail from './MeetingDetail';

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Meeting · {id}</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        Diarized transcript · clickable timestamps · summary, action items, decisions ·
        ask-this-meeting · in-meeting search.
      </p>
      <MeetingDetail meetingId={id} />
    </div>
  );
}
