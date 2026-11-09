// Threat Graph — links interaction-level signals into a campaign-detecting graph.
//
// Node types: PARTICIPANT, PHONE, AGENT, INTERACTION, DETECTION, CAMPAIGN
// Edge types: CALLED_FROM, DETECTED_IN, SHARED_VOICE_SIGNATURE, SHARED_SCRIPT,
//             SAME_DESTINATION, SAME_AGENT
//
// DEMO LIMITATION (documented): the "shared script" signal is implemented as
// "the two interactions raised the same detection code". A production system
// would correlate actual transcript semantics (embedding similarity over the
// fraud-script spans, n-gram overlap, etc.); same-code overlap is a proxy good
// enough for the demo corpus. Likewise the demo voiceSignatureHash is
// synthetic-provider-based: every synthetic=true customer call shares one hash.
// This is the demo's signal, NOT a production voiceprint — real voiceprints are
// per-identity acoustic embeddings, not a flag over the TTS provider.

import { createHash } from 'node:crypto';
import type { Detection, GovernanceSnapshot, Participant } from '@cxtrust/core';

export type NodeType =
  | 'PARTICIPANT'
  | 'PHONE'
  | 'AGENT'
  | 'INTERACTION'
  | 'DETECTION'
  | 'CAMPAIGN';

export type EdgeType =
  | 'CALLED_FROM'
  | 'DETECTED_IN'
  | 'SHARED_VOICE_SIGNATURE'
  | 'SHARED_SCRIPT'
  | 'SAME_DESTINATION'
  | 'SAME_AGENT';

export interface GraphNode {
  key: string; // `${type}:${id}`
  type: NodeType;
  id: string;
  meta: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  meta: Record<string, unknown>;
}

export interface AddInteractionOptions {
  phone?: string;
  voiceSignatureHash?: string;
  destinationAccount?: string;
}

export interface Campaign {
  campaignId: string; // 'camp-<hash>'
  interactionIds: string[];
  sharedSignals: string[];
  phoneNumbers: string[];
  firstSeen: string;
  lastSeen: string;
  totalRisk: number; // max risk across member interactions
  description: string;
}

export interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  campaigns: Campaign[];
  topSharedSignals: string[];
}

interface InteractionRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  platform: string;
  risk: number;
  codeSet: string[]; // detection codes raised
  codeCategories: Record<string, string>; // code -> category
  voiceSignatureHash?: string;
  destinationAccount?: string;
  agentIds: string[];
  scenario?: string;
}

export class ThreatGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private edgesByKey = new Set<string>();
  private interactions = new Map<string, InteractionRecord>();
  /** voiceSignatureHash -> interaction ids */
  private byVoiceHash = new Map<string, string[]>();
  /** detection code -> interaction ids */
  private byCode = new Map<string, string[]>();
  /** destinationAccount -> interaction ids */
  private byDestination = new Map<string, string[]>();
  /** agentId -> interaction ids */
  private byAgent = new Map<string, string[]>();

  // ---------- node / edge primitives ----------

  private node(type: NodeType, id: string, meta: Record<string, unknown> = {}): string {
    const key = `${type}:${id}`;
    if (!this.nodes.has(key)) this.nodes.set(key, { key, type, id, meta });
    return key;
  }

  private link(from: string, to: string, type: EdgeType, meta: Record<string, unknown> = {}) {
    const k = `${from}|${type}|${to}`;
    if (this.edgesByKey.has(k)) return;
    this.edgesByKey.add(k);
    this.edges.push({ from, to, type, meta });
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.length;
  }

  nodesOfType(type: NodeType): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.type === type);
  }

  // ---------- ingestion ----------

  addInteraction(snapshot: GovernanceSnapshot, opts: AddInteractionOptions = {}): void {
    const ix = snapshot.interaction;
    const id = ix.interactionId;
    if (this.interactions.has(id)) return; // idempotent per interaction

    const rec: InteractionRecord = {
      id,
      startedAt: ix.startedAt,
      endedAt: ix.endedAt,
      platform: ix.platform,
      risk: snapshot.risk?.overall ?? 0,
      codeSet: [...new Set(snapshot.detections.map((d) => d.code))],
      codeCategories: {},
      voiceSignatureHash: opts.voiceSignatureHash,
      destinationAccount: opts.destinationAccount,
      agentIds: [...new Set(snapshot.participants.map((p) => p.agentId).filter((a): a is string => !!a))],
      scenario: (ix.metadata?.scenario as string | undefined) ?? undefined,
    };
    this.interactions.set(id, rec);

    const ixNode = this.node('INTERACTION', id, { platform: rec.platform, scenario: rec.scenario });

    // PARTICIPANT nodes, keyed by kind+classification so the same fraudster
    // persona recurring across interactions collapses into one node.
    for (const p of snapshot.participants) {
      const pid = participantKey(p);
      const pNode = this.node('PARTICIPANT', pid, {
        kinds: new Set<string>(),
        classifications: new Set<string>(),
      });
      const n = this.nodes.get(pNode)!;
      (n.meta.kinds as Set<string>).add(p.kind);
      (n.meta.classifications as Set<string>).add(p.classification);
      this.link(pNode, ixNode, 'CALLED_FROM', { participantId: p.participantId });
      if (p.agentId) {
        rec.agentIds.push(p.agentId);
        const aNode = this.node('AGENT', p.agentId);
        this.link(aNode, ixNode, 'SAME_AGENT');
        const list = this.byAgent.get(p.agentId) ?? [];
        list.push(id);
        this.byAgent.set(p.agentId, list);
      }
    }
    rec.agentIds = [...new Set(rec.agentIds)];

    // PHONE node
    if (opts.phone) {
      const phNode = this.node('PHONE', opts.phone);
      this.link(ixNode, phNode, 'CALLED_FROM', { direction: 'origination' });
    }

    // DETECTION nodes (deduped by code), linked into this interaction
    const seenCodes = new Set<string>();
    for (const d of snapshot.detections) {
      if (!seenCodes.has(d.code)) {
        seenCodes.add(d.code);
        rec.codeCategories[d.code] = d.category;
        const dNode = this.node('DETECTION', d.code, { category: d.category, title: d.title });
        this.link(dNode, ixNode, 'DETECTED_IN');
      }
    }
    for (const code of rec.codeSet) {
      const list = this.byCode.get(code) ?? [];
      list.push(id);
      this.byCode.set(code, list);
    }

    // destination account
    if (opts.destinationAccount) {
      const dNode = this.node('PHONE', `dest:${opts.destinationAccount}`, { destinationAccount: true });
      this.link(ixNode, dNode, 'SAME_DESTINATION');
      const list = this.byDestination.get(opts.destinationAccount) ?? [];
      list.push(id);
      this.byDestination.set(opts.destinationAccount, list);
    }

    // SHARED_* edges with prior interactions
    if (opts.voiceSignatureHash) {
      rec.voiceSignatureHash = opts.voiceSignatureHash;
      const prior = this.byVoiceHash.get(opts.voiceSignatureHash) ?? [];
      for (const other of prior) {
        this.link(`INTERACTION:${id}`, `INTERACTION:${other}`, 'SHARED_VOICE_SIGNATURE', { voiceSignatureHash: opts.voiceSignatureHash });
      }
      prior.push(id);
      this.byVoiceHash.set(opts.voiceSignatureHash, prior);
    }

    // SHARED_SCRIPT: same detection code (demo proxy for similar transcript —
    // see file header for the production approach). Restricted to
    // FRAUD-category codes: two interactions sharing e.g. `synthetic_voice`
    // share a voice provider, not a script, and welding every TTS call into
    // one component would erase the benign/fraud boundary.
    for (const code of rec.codeSet) {
      if (rec.codeCategories[code] !== 'FRAUD') continue;
      for (const other of this.byCode.get(code) ?? []) {
        if (other === id) continue;
        this.link(`INTERACTION:${id}`, `INTERACTION:${other}`, 'SHARED_SCRIPT', { code });
      }
    }

    // SAME_DESTINATION edges
    if (opts.destinationAccount) {
      for (const other of this.byDestination.get(opts.destinationAccount) ?? []) {
        if (other === id) continue;
        this.link(`INTERACTION:${id}`, `INTERACTION:${other}`, 'SAME_DESTINATION', { destinationAccount: opts.destinationAccount });
      }
    }

    // SAME_AGENT edges
    for (const agentId of rec.agentIds) {
      for (const other of this.byAgent.get(agentId) ?? []) {
        if (other === id) continue;
        this.link(`INTERACTION:${id}`, `INTERACTION:${other}`, 'SAME_AGENT', { agentId });
      }
    }
  }

  // ---------- campaign detection ----------

  /**
   * Connected components (union-find) over SHARED_* interaction edges.
   * Components with >= minInteractions members are campaigns.
   */
  findCampaigns(minInteractions = 3): Campaign[] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = parent.get(x) ?? x;
      if (r !== x) {
        r = find(r);
        parent.set(x, r);
      }
      return r;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const id of this.interactions.keys()) parent.set(id, id);
    for (const e of this.edges) {
      if (e.type === 'SHARED_VOICE_SIGNATURE' || e.type === 'SHARED_SCRIPT' || e.type === 'SAME_DESTINATION') {
        const [, a] = e.from.split(':');
        const [, b] = e.to.split(':');
        union(a, b);
      }
    }

    const groups = new Map<string, string[]>();
    for (const id of this.interactions.keys()) {
      const root = find(id);
      const g = groups.get(root) ?? [];
      g.push(id);
      groups.set(root, g);
    }

    const campaigns: Campaign[] = [];
    for (const members of groups.values()) {
      if (members.length < minInteractions) continue;
      const signals = new Map<string, number>();
      const phones: string[] = [];
      let firstSeen = '';
      let lastSeen = '';
      let totalRisk = 0;
      const codes = new Map<string, number>();
      for (const id of members) {
        const rec = this.interactions.get(id)!;
        if (!firstSeen || rec.startedAt < firstSeen) firstSeen = rec.startedAt;
        const end = rec.endedAt ?? rec.startedAt;
        if (!lastSeen || end > lastSeen) lastSeen = end;
        totalRisk = Math.max(totalRisk, rec.risk);
        for (const code of rec.codeSet) codes.set(code, (codes.get(code) ?? 0) + 1);
        if (rec.voiceSignatureHash) {
          const label = `voice:${rec.voiceSignatureHash.slice(0, 12)}`;
          signals.set(label, (signals.get(label) ?? 0) + 1);
        }
        if (rec.destinationAccount) signals.set(`destination:${rec.destinationAccount}`, (signals.get(`destination:${rec.destinationAccount}`) ?? 0) + 1);
      }
      // shared signals = detection codes present in >1 member + voice/dest signals
      const sharedSignals = [
        ...[...codes.entries()].filter(([, c]) => c > 1).map(([c]) => `code:${c}`),
        ...signals.keys(),
      ];
      const topCode = [...codes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const campaignId = `camp-${createHash('sha256').update(members.slice().sort().join('|')).digest('hex').slice(0, 12)}`;
      campaigns.push({
        campaignId,
        interactionIds: members.slice().sort(),
        sharedSignals: sharedSignals.sort(),
        phoneNumbers: phones,
        firstSeen,
        lastSeen,
        totalRisk,
        description: `Coordinated activity across ${members.length} interactions on ${rec_platforms(members, this.interactions)}; strongest shared signal: ${topCode ?? 'n/a'} (max risk ${totalRisk}).`,
      });
    }
    return campaigns.sort((a, b) => b.totalRisk - a.totalRisk);
  }

  /** Compact summary for UI consumption. */
  graphSummary(minInteractions = 3): GraphSummary {
    const signalCounts = new Map<string, number>();
    for (const e of this.edges) {
      if (e.type === 'SHARED_VOICE_SIGNATURE') {
        const k = `voice:${String(e.meta.voiceSignatureHash ?? '').slice(0, 12)}`;
        signalCounts.set(k, (signalCounts.get(k) ?? 0) + 1);
      } else if (e.type === 'SHARED_SCRIPT') {
        const k = `script:${String(e.meta.code)}`;
        signalCounts.set(k, (signalCounts.get(k) ?? 0) + 1);
      } else if (e.type === 'SAME_DESTINATION') {
        const k = `destination:${String(e.meta.destinationAccount)}`;
        signalCounts.set(k, (signalCounts.get(k) ?? 0) + 1);
      }
    }
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      campaigns: this.findCampaigns(minInteractions),
      topSharedSignals: [...signalCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k),
    };
  }
}

function rec_platforms(members: string[], interactions: Map<string, InteractionRecord>): string {
  const set = new Set<string>();
  for (const m of members) {
    const r = interactions.get(m);
    if (r) set.add(r.platform);
  }
  return [...set].join(', ');
}

/** Participant node identity: kind+classification persona, not per-interaction id. */
function participantKey(p: Participant): string {
  return `${p.kind}|${p.classification}`;
}

export type { Detection };
