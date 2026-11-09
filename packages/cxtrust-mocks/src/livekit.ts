// Mock connector entrypoints (run one per port):
//   node src/livekit.ts  → :8806
//   node src/pipecat.ts  → :8807

import { serveMockAdapter } from './index.ts';

const PORT = Number(process.env.CXTRUST_LIVEKIT_PORT ?? 8806);
serveMockAdapter({ key: 'livekit', port: PORT, platform: 'livekit', label: 'LiveKit Mock', secretEnv: 'CXTRUST_LIVEKIT_SECRET' })
  .listen(PORT, () => console.log(`livekit mock listening on :${PORT}`));