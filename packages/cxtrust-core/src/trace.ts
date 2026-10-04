// Trace & span instrumentation for the governance loop.
// OTel-concept-shaped (traceId/spanId/parent, durationMs, attrs) but
// dependency-free and isomorphic. Spans are recorded around every session
// stage so the console can render a waterfall and aggregate P50/95/99.

export type SpanStage =
  | 'ASR' | 'DETECT' | 'RISK' | 'POLICY' | 'ENFORCE'
  | 'EVIDENCE' | 'TOOL' | 'RAG' | 'LLM' | 'TTS' | 'AUTH' | 'OTHER';

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  interactionId: string;
  stage: SpanStage;
  name: string;
  startedAt: string;
  durationMs: number;
  attrs?: Record<string, string | number | boolean>;
  error?: string;
}

export interface SpanRecorder {
  record(span: Span): void;
  spans(): Span[];
}

/** Generate a W3C-ish 32-hex traceId / 16-hex spanId without deps. */
export function newTraceId(): string {
  const h = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${h()}${h()}${h()}${h()}`;
}

export function newSpanId(): string {
  return Math.floor(Math.random() * 0xffffffffffffffff).toString(16).padStart(16, '0');
}

/** Simple in-memory recorder; the server persists spans per interaction. */
export class MemorySpanRecorder implements SpanRecorder {
  private list: Span[] = [];
  record(span: Span) { this.list.push(span); }
  spans() { return [...this.list]; }
}

/** Timing helper: usage — const t = startSpan(rec, {...}); ...work...; endSpan(t, attrs?). */
export function startSpan(rec: SpanRecorder, init: {
  traceId: string; interactionId: string; stage: SpanStage; name: string;
  parentSpanId?: string; attrs?: Record<string, string | number | boolean>;
}): { spanId: string; t0: number } {
  return { spanId: newSpanId(), t0: performance.now() };
}

export function endSpan(
  rec: SpanRecorder,
  init: { traceId: string; interactionId: string; stage: SpanStage; name: string; parentSpanId?: string },
  started: { spanId: string; t0: number },
  attrs?: Record<string, string | number | boolean>,
  error?: string,
): Span {
  const span: Span = {
    spanId: started.spanId,
    traceId: init.traceId,
    parentSpanId: init.parentSpanId,
    interactionId: init.interactionId,
    stage: init.stage,
    name: init.name,
    startedAt: new Date().toISOString(),
    durationMs: Math.round((performance.now() - started.t0) * 100) / 100,
    ...(attrs ? { attrs } : {}),
    ...(error ? { error } : {}),
  };
  rec.record(span);
  return span;
}

/** Percentiles over a numeric list (nearest-rank). */
export function percentiles(values: number[]): { p50: number; p95: number; p99: number } {
  if (!values.length) return { p50: 0, p95: 0, p99: 0 };
  const s = [...values].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
}

/** Aggregate latency by stage from a span list. */
export function latencyByStage(spans: Span[]): Record<string, { p50: number; p95: number; p99: number; count: number }> {
  const byStage = new Map<string, number[]>();
  for (const s of spans) {
    if (s.error) continue;
    const arr = byStage.get(s.stage) ?? [];
    arr.push(s.durationMs);
    byStage.set(s.stage, arr);
  }
  const out: Record<string, { p50: number; p95: number; p99: number; count: number }> = {};
  for (const [stage, vals] of byStage) out[stage] = { ...percentiles(vals), count: vals.length };
  return out;
}