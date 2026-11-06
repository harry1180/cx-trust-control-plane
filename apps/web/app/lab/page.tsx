// Test Lab page — CX red-team corpus runner + scorecard.

import LabRunner from './LabRunner';

export default function LabPage() {
  return (
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Test Lab</h2>
      <p style={{ color: 'var(--dim)', marginBottom: 16 }}>
        CX-specific red-team corpus (promptfoo/garak concepts, implemented natively) run
        against the live governance engine.
      </p>
      <LabRunner />
    </div>
  );
}