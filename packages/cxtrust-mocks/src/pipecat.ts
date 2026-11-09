// Mock connector entrypoint (run one per port):
//   node src/pipecat.ts  → :8807

import { serveMockAdapter } from './index.ts';

const PORT = Number(process.env.CXTRUST_PIPECAT_PORT ?? 8807);
serveMockAdapter({ key: 'pipecat', port: PORT, platform: 'pipecat', label: 'Pipecat Mock', secretEnv: 'CXTRUST_PIPECAT_SECRET' })
  .listen(PORT, () => console.log(`pipecat mock listening on :${PORT}`));