'use client';

// Seeds the demo corpus through the API (8 charter scenarios → real
// governance runs → persisted in the evidence store), then refreshes.

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const SCENARIOS = [
  'normal-customer', 'deepfake-ato', 'unknown-ai-caller', 'verified-agent-passport',
  'prompt-injection', 'agent-over-limit', 'pci-leak', 'fraud-campaign',
];

export default function SeedButton() {
  const r = useRouter();
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');

  async function seed() {
    setState('running');
    for (const id of SCENARIOS) {
      await fetch('/api/cxtrust?path=/v1/scenarios/' + id, { method: 'POST' });
    }
    setState('done');
    r.refresh();
  }

  return (
    <div style={{ margin: '12px 0' }}>
      <button className="btn btn-primary" onClick={() => { void seed(); }} disabled={state === 'running'}>
        {state === 'idle' && 'Seed demo corpus (run 8 scenarios through the API)'}
        {state === 'running' && 'Seeding — running scenarios through the governance engine…'}
        {state === 'done' && 'Seeded ✓ — re-run to add another corpus'}
      </button>
      <span style={{ color: 'var(--dim)', fontSize: 12, marginLeft: 10 }}>
        Each run creates real governed interactions persisted in the evidence store.
      </span>
    </div>
  );
}