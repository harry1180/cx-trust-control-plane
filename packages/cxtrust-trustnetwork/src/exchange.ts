// TrustNetworkNode — an organization's node in the federated trust network.
//
// REST contract (bidirectional):
//   POST /trustnet/sync
//     { organizationId, since?, signals: TrustSignal[] }
//     → { signals: TrustSignal[] }   (partner signals newer than `since`)
//
// Privacy: every outbound signal must pass validateSignal; failing ones are
// stripped (with a recorded drop), never sent. Sync failures are recorded on
// the node and never thrown, so the exchange loop stays alive.

import { validateSignals, validateSignal, type TrustSignal } from './types.ts';
import { mergeSignals } from './federation.ts';

export interface PartnerEndpoint {
  organizationId: string;
  /** Base URL, e.g. https://partner.example.com */
  endpoint: string;
  /**
   * Env var name holding the partner API token. Tokens are read from the
   * environment at request time — never hardcoded, never logged.
   */
  apiTokenEnv: string;
  /** Partner trust score 0..1 used by reputation weighting. Default 0.5. */
  trustScore?: number;
}

export interface SyncOutcome {
  partner: string;
  ok: boolean;
  pushed: number;
  pulled: number;
  stripped: number;
  error?: string;
}

export interface ExchangeResult {
  outcomes: SyncOutcome[];
  /** All signals now known locally (local + pulled, deduped by signalId). */
  signals: TrustSignal[];
}

export interface SyncRequestBody {
  organizationId: string;
  since?: string;
  signals: TrustSignal[];
}

export interface SyncResponseBody {
  signals: TrustSignal[];
}

export interface ExchangeOptions {
  /** Only push/pull signals created after this ISO timestamp. */
  since?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function resolvePartnerToken(partner: PartnerEndpoint): string {
  const name = partner.apiTokenEnv;
  const token = process.env[name];
  if (!token) throw new Error(`partner ${partner.organizationId}: env ${name} not set`);
  return token;
}

/** Strip any signal that fails the privacy validator; count drops. */
export function sanitizeOutbound(signals: TrustSignal[]): { clean: TrustSignal[]; stripped: number } {
  const clean: TrustSignal[] = [];
  let stripped = 0;
  for (const s of signals) {
    if (validateSignal(s).ok) clean.push(s);
    else stripped++;
  }
  return { clean, stripped };
}

export class TrustNetworkNode {
  readonly organizationId: string;
  /** signalId → signal (local + pulled, deduped). */
  private signals = new Map<string, TrustSignal>();
  /** Recorded sync failures — never thrown. */
  readonly syncLog: SyncOutcome[] = [];

  constructor(organizationId: string, initialSignals: TrustSignal[] = []) {
    this.organizationId = organizationId;
    for (const s of initialSignals) {
      if (validateSignal(s).ok) this.signals.set(s.signalId, { ...s });
    }
  }

  /** Locally publish a signal (validated; invalid ones are refused). */
  publish(signal: TrustSignal): boolean {
    if (!validateSignal(signal).ok) return false;
    const existing = this.signals.get(signal.signalId);
    // First writer wins on identity; org-forced at the transport layer anyway.
    if (existing) return false;
    this.signals.set(signal.signalId, { ...signal, organizationId: signal.organizationId });
    return true;
  }

  listSignals(since?: string): TrustSignal[] {
    const all = [...this.signals.values()];
    if (!since) return all;
    const t = Date.parse(since);
    return all.filter(s => Date.parse(s.createdAt) > t);
  }

  /** Merge inbound signals (dedupe by signalId, first writer wins). */
  ingest(incoming: TrustSignal[]): { added: number; rejected: number } {
    const { accepted, rejected } = validateSignals(incoming);
    const before = this.signals.size;
    for (const s of accepted) {
      if (!this.signals.has(s.signalId)) this.signals.set(s.signalId, { ...s });
    }
    return { added: this.signals.size - before, rejected: rejected.length };
  }

  /**
   * Serve the inbound side of the contract: accept signals from a partner org
   * (filtered to those that pass validation) and return our signals for them.
   */
  handleSync(body: SyncRequestBody): SyncResponseBody {
    this.ingest(body.signals ?? []);
    return { signals: this.listSignals(body.since) };
  }

  /**
   * Full exchange round: push clean local signals to each partner, pull
   * theirs back, merge locally. Failures are recorded and never thrown.
   */
  async exchange(partners: PartnerEndpoint[], opts: ExchangeOptions = {}): Promise<ExchangeResult> {
    const doFetch = opts.fetchImpl ?? fetch;
    const since = opts.since;
    const outcomes: SyncOutcome[] = [];
    for (const partner of partners) {
      const outcome: SyncOutcome = { partner: partner.organizationId, ok: false, pushed: 0, pulled: 0, stripped: 0 };
      try {
        const { clean, stripped } = sanitizeOutbound(this.listSignals(since));
        outcome.stripped = stripped;
        const body: SyncRequestBody = { organizationId: this.organizationId, signals: clean };
        if (since) body.since = since;
        const token = resolvePartnerToken(partner);
        const res = await doFetch(`${partner.endpoint.replace(/\/$/, '')}/trustnet/sync`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SyncResponseBody;
        outcome.pushed = clean.length;
        const { accepted } = validateSignals(data.signals ?? []);
        const { added } = this.ingest(accepted);
        outcome.pulled = added;
        outcome.ok = true;
      } catch (err) {
        outcome.error = String((err as Error)?.message ?? err);
      }
      outcomes.push(outcome);
      this.syncLog.push(outcome);
    }
    return { outcomes, signals: this.listSignals() };
  }
}

// Re-export for convenience of embedders.
export { mergeSignals };
