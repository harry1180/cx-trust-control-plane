// Licensing / usage telemetry for the CX Trust commercial editions
// (Core / Security / AI Governance / Fraud Defense / Enterprise).
//
// Metering only — NO billing. The meter records per-org per-day aggregates of
// governed interactions and exposes them (plus the static edition entitlement
// matrix) via GET /v1/licensing. Nothing is enforced at request time: the
// endpoint reports counters, limits and overage so ops/billing tooling can
// make its own decisions.
//
// Estimation note (minutesGoverned): for interactions that have ENDED, minutes
// are the exact startedAt→endedAt delta. For interactions still in flight
// (no endedAt) the current duration (record-time − startedAt) is counted and
// will be *revised upward* if the interaction continues — i.e. partial
// interactions are counted at their duration-so-far, a lower-bound estimate.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const METER_VERSION = 1;

// ---------- edition matrix (static, exported for tests + endpoint) ----------

export interface EditionFeatures {
  unlimited: boolean;
  maxInteractionsPerMonth: number | null;
  connectors: string[];
  alerting: boolean;
  aiAgentGovernance: boolean;
  fraudDefense: boolean;
  ssoScim: boolean;
  auditExport: boolean;
}

export const EDITION_FEATURES: Record<string, EditionFeatures> = {
  core: {
    unlimited: false,
    maxInteractionsPerMonth: 10_000,
    connectors: ['amazon-connect'],
    alerting: false,
    aiAgentGovernance: false,
    fraudDefense: false,
    ssoScim: false,
    auditExport: false,
  },
  security: {
    unlimited: false,
    maxInteractionsPerMonth: 100_000,
    connectors: ['amazon-connect', 'twilio', 'genesys'],
    alerting: true,
    aiAgentGovernance: false,
    fraudDefense: false,
    ssoScim: false,
    auditExport: true,
  },
  'ai-governance': {
    unlimited: false,
    maxInteractionsPerMonth: 250_000,
    connectors: ['amazon-connect', 'twilio', 'genesys', 'webhook'],
    alerting: true,
    aiAgentGovernance: true,
    fraudDefense: false,
    ssoScim: false,
    auditExport: true,
  },
  'fraud-defense': {
    unlimited: false,
    maxInteractionsPerMonth: 500_000,
    connectors: ['amazon-connect', 'twilio', 'genesys', 'webhook', 'siem'],
    alerting: true,
    aiAgentGovernance: true,
    fraudDefense: true,
    ssoScim: false,
    auditExport: true,
  },
  enterprise: {
    unlimited: true,
    maxInteractionsPerMonth: null,
    connectors: ['amazon-connect', 'twilio', 'genesys', 'webhook', 'siem', 'custom'],
    alerting: true,
    aiAgentGovernance: true,
    fraudDefense: true,
    ssoScim: true,
    auditExport: true,
  },
};

export type EditionName = keyof typeof EDITION_FEATURES;

/** Active edition from env; 'enterprise' by default (no limits in demo). */
export function activeEdition(): string {
  const e = process.env.CXTRUST_EDITION ?? 'enterprise';
  return EDITION_FEATURES[e] ? e : 'enterprise';
}

export function editionFeatures(edition: string = activeEdition()): EditionFeatures {
  return EDITION_FEATURES[edition] ?? EDITION_FEATURES.enterprise;
}

// ---------- usage model ----------

export interface UsageInteractionInput {
  organizationId: string;
  platform: string;
  channel: string;
  startedAt: string;
  endedAt?: string;
  peakRisk: number;
  participants: { kind: string }[];
  decisions: { allowed: boolean; latencyMs: number }[];
  agentGoverned?: boolean;
}

export interface DayCounters {
  interactionsGoverned: number;
  minutesGoverned: number;
  aiAgentsGoverned: number;
  policyEvaluations: number;
  policyDecisionsBlocked: number;
}

const AI_KINDS = new Set(['ENTERPRISE_AI', 'THIRD_PARTY_AI', 'EXTERNAL_AI']);

function emptyDay(): DayCounters {
  return {
    interactionsGoverned: 0,
    minutesGoverned: 0,
    aiAgentsGoverned: 0,
    policyEvaluations: 0,
    policyDecisionsBlocked: 0,
  };
}

function addInto(target: DayCounters, src: DayCounters): DayCounters {
  target.interactionsGoverned += src.interactionsGoverned;
  target.minutesGoverned += src.minutesGoverned;
  target.aiAgentsGoverned += src.aiAgentsGoverned;
  target.policyEvaluations += src.policyEvaluations;
  target.policyDecisionsBlocked += src.policyDecisionsBlocked;
  return target;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD (UTC ISO strings)
}

// (rounding helper intentionally omitted — counters are exact)

export interface LicensingReport {
  organizationId: string;
  edition: string;
  counters: { day: DayCounters; monthToDate: DayCounters };
  limits: EditionFeatures;
  overage: { interactionsOver: number | null };
  meterVersion: number;
}

// ---------- sink registration (index.ts wires persist() → meter) ----------

export type UsageSink = (interactionId: string, ev: UsageInteractionInput) => void;
const sinks: UsageSink[] = [];

/** Register a usage sink; returns an unregister fn (ws.ts pattern). */
export function registerUsageSink(fn: UsageSink): () => void {
  sinks.push(fn);
  return () => {
    const i = sinks.indexOf(fn);
    if (i >= 0) sinks.splice(i, 1);
  };
}

/** Fire-and-forget emit from the persistence path; sink errors are swallowed. */
export function emitUsageInteraction(interactionId: string, ev: UsageInteractionInput): void {
  for (const fn of sinks) {
    try { fn(interactionId, ev); } catch { /* metering must never break the API */ }
  }
}

/**
 * One-call hook for index.ts persist(): derive the usage event from a live
 * GovernanceSnapshot (structural — avoids importing @cxtrust/core here).
 */
export function emitFromSnapshot(
  interactionId: string,
  snap: {
    interaction: { organizationId: string; platform: string; channel: string; startedAt: string; endedAt?: string };
    participants: { kind: string }[];
    decisions: { allowed: boolean; latencyMs: number }[];
    risk: { overall: number };
  },
): void {
  emitUsageInteraction(interactionId, {
    organizationId: snap.interaction.organizationId,
    platform: snap.interaction.platform,
    channel: snap.interaction.channel,
    startedAt: snap.interaction.startedAt,
    endedAt: snap.interaction.endedAt,
    peakRisk: snap.risk.overall,
    participants: snap.participants.map(p => ({ kind: p.kind })),
    decisions: snap.decisions.map(d => ({ allowed: d.allowed, latencyMs: d.latencyMs })),
    agentGoverned: snap.participants.some(p => AI_KINDS.has(p.kind)),
  });
}

// ---------- module-level active meter (index.ts routes read this) ----------

let activeMeter: UsageMeter | null = null;

export function setActiveMeter(m: UsageMeter | null): void { activeMeter = m; }
export function getActiveMeter(): UsageMeter | null { return activeMeter; }

// ---------- UsageMeter ----------

export class UsageMeter {
  private orgs = new Map<string, Map<string, DayCounters>>();
  // Last-counted totals per interaction: persist() fires per snapshot, so
  // re-records apply DELTAS (participants/decisions accrue mid-interaction).
  private counted = new Map<string, { org: string; day: string; ai: number; evals: number; blocked: number; minutes: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private unregister: () => void;
  readonly filePath: string;

  constructor(filePath: string = process.env.CXTRUST_USAGE_DB ?? './data/usage.json') {
    this.filePath = filePath;
    this.load();
    this.unregister = registerUsageSink(this.recordUsage.bind(this));
    this.timer = setInterval(() => this.flush(), 60_000);
    // Never keep the process alive just for the flush timer.
    this.timer.unref?.();
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
        orgs?: Record<string, Record<string, DayCounters>>;
      };
      for (const [org, days] of Object.entries(raw.orgs ?? {})) {
        const m = new Map<string, DayCounters>();
        for (const [day, counters] of Object.entries(days)) m.set(day, { ...emptyDay(), ...counters });
        this.orgs.set(org, m);
      }
    } catch {
      // Corrupt/legacy file: start clean rather than fail startup.
      this.orgs = new Map();
    }
  }

  /** Record one governed interaction. */
  recordInteraction(ev: UsageInteractionInput): DayCounters {
    const day = dayKey(ev.startedAt);
    let days = this.orgs.get(ev.organizationId);
    if (!days) { days = new Map(); this.orgs.set(ev.organizationId, days); }
    const d = days.get(day) ?? emptyDay();

    d.interactionsGoverned += 1;
    const start = Date.parse(ev.startedAt);
    const end = ev.endedAt !== undefined ? Date.parse(ev.endedAt) : Date.now();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      d.minutesGoverned += (end - start) / 60_000;
    }
    let ai = ev.participants.filter(p => AI_KINDS.has(p.kind)).length;
    if (ev.agentGoverned && ai === 0) ai = 1;
    d.aiAgentsGoverned += ai;
    d.policyEvaluations += ev.decisions.length;
    d.policyDecisionsBlocked += ev.decisions.filter(x => !x.allowed).length;
    days.set(day, d);
    return d;
  }

  /**
   * Sink entry point for the persist() path: idempotent with delta
   * accounting. persist() runs on every snapshot, so the first call records
   * the full event and later calls only apply what ACCRUED since the last
   * one (new participants, new decisions, longer duration). This keeps
   * counters correct for interactions whose AI participants join / decisions
   * land after the initial snapshot. Test-code callers that pass a fixed
   * event twice see no change (deltas are zero).
   */
  recordUsage(interactionId: string, ev: UsageInteractionInput): void {
    const prev = this.counted.get(interactionId);
    let ai = ev.participants.filter(p => AI_KINDS.has(p.kind)).length;
    if (ev.agentGoverned && ai === 0) ai = 1;
    const evals = ev.decisions.length;
    const blocked = ev.decisions.filter(x => !x.allowed).length;
    const start = Date.parse(ev.startedAt);
    const end = ev.endedAt !== undefined ? Date.parse(ev.endedAt) : Date.now();
    const minutes = Number.isFinite(start) && Number.isFinite(end) && end > start
      ? (end - start) / 60_000
      : 0;

    if (!prev) {
      this.counted.set(interactionId, { org: ev.organizationId, day: dayKey(ev.startedAt), ai, evals, blocked, minutes });
      this.recordInteraction(ev);
      return;
    }
    // Delta vs what was already counted for this interaction.
    const dAi = Math.max(0, ai - prev.ai);
    const dEvals = Math.max(0, evals - prev.evals);
    const dBlocked = Math.max(0, blocked - prev.blocked);
    const dMinutes = Math.max(0, minutes - prev.minutes);
    if (dAi === 0 && dEvals === 0 && dBlocked === 0 && dMinutes === 0) return;
    prev.ai = ai; prev.evals = evals; prev.blocked = blocked; prev.minutes = minutes;
    this.applyDelta(ev.organizationId, dayKey(ev.startedAt), dAi, dEvals, dBlocked, dMinutes);
  }

  private applyDelta(org: string, day: string, ai: number, evals: number, blocked: number, minutes: number): void {
    let days = this.orgs.get(org);
    if (!days) { days = new Map(); this.orgs.set(org, days); }
    const d = days.get(day) ?? emptyDay();
    d.aiAgentsGoverned += ai;
    d.policyEvaluations += evals;
    d.policyDecisionsBlocked += blocked;
    d.minutesGoverned += minutes;
    days.set(day, d);
  }

  /** Counters for the current UTC day + calendar month-to-date. */
  counters(organizationId: string, now: Date = new Date()): { day: DayCounters; monthToDate: DayCounters } {
    const days = this.orgs.get(organizationId);
    const today = dayKey(now.toISOString());
    const month = today.slice(0, 7);
    const day = (days?.get(today) ?? emptyDay());
    const mtd = emptyDay();
    if (days) {
      for (const [k, v] of days) if (k.slice(0, 7) === month) addInto(mtd, v);
    }
    return { day: { ...day }, monthToDate: mtd };
  }

  licensing(organizationId: string, now: Date = new Date()): LicensingReport {
    const edition = activeEdition();
    const feats = editionFeatures(edition);
    const { day, monthToDate } = this.counters(organizationId, now);
    const over = feats.maxInteractionsPerMonth === null
      ? null
      : Math.max(0, monthToDate.interactionsGoverned - feats.maxInteractionsPerMonth);
    return {
      organizationId,
      edition,
      counters: { day, monthToDate },
      limits: feats,
      overage: { interactionsOver: over },
      meterVersion: METER_VERSION,
    };
  }

  /** Month-to-date counters per org (ADMIN summary). */
  summary(now: Date = new Date()): Record<string, DayCounters> {
    const out: Record<string, DayCounters> = {};
    for (const org of this.orgs.keys()) out[org] = this.counters(org, now).monthToDate;
    return out;
  }

  /** Atomic persistence: write tmp file, fsync-free rename over the target. */
  flush(): void {
    if (this.closed) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const payload = {
        meterVersion: METER_VERSION,
        savedAt: new Date().toISOString(),
        orgs: Object.fromEntries([...this.orgs.entries()].map(([org, days]) => [org, Object.fromEntries(days)])),
      };
      const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.filePath); // atomic on POSIX + Windows same-volume
    } catch (err) {
      console.error(`[usage] flush failed: ${String((err as Error)?.message ?? err)}`);
    }
  }

  close(): void {
    this.unregister();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.flush(); // final write BEFORE marking closed
    this.closed = true;
  }
}
