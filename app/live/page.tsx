// Live Transcription — full-page redirect to the standalone TTV Live app.
//
// The app (ephemeral mic → faster-whisper → share-link viewers) runs as its
// own sidecar (compose project `ttv`, :8820) behind the same Traefik proxy
// and owns the whole viewport — no embedding, no console chrome:
//   host page     https://…/live          (sidecar `/`, prefix-stripped)
//   share links   https://…/live/<id>     (sidecar `/live/<id>`)
//   health probe  https://…/live-healthz  (sidecar `/healthz`)
// Transcripts live only in that service's memory and die with the session.

import { redirect } from 'next/navigation';

const LIVE_URL = process.env.NEXT_PUBLIC_LIVE_URL ?? 'https://governance.agenticalchemy.io';

export default async function LiveTranscriptionPage() {
  redirect(`${LIVE_URL}/live`);
}
