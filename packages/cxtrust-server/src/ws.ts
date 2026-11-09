// WebSocket streaming for live governance deltas.
//
//   ws://host/ws?api_key=...   (or Sec-WebSocket-Protocol: <key>)
//
// Client sends:  {type:'subscribe', interactionId} | {type:'subscribe_all', organizationId}
// Server sends:  {type:'subscribed', ...}
//                {type:'snapshot', interactionId, snapshot}   (throttled: ≤1 per 150ms/session)
//                {type:'decision', interactionId, decision}
//                {type:'incident', interactionId, incident}
//                {type:'ended', interactionId}
//
// The broadcaster registry is intentionally module-level: index.ts calls
// notifyEvent()/notifySnapshot() from inside its handlers, and every
// attachServerWs()-attached server fans frames out to its own clients.

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Server } from 'node:http';
import type { GovernanceSnapshot, PolicyDecision, Incident } from '@cxtrust/core';

const MAX_CLIENTS = 64;
const SNAPSHOT_MIN_INTERVAL_MS = 150;
const HEARTBEAT_MS = 30_000;

export type WsFrame = Record<string, unknown>;
export type Broadcaster = (interactionId: string, frame: WsFrame) => void;

const broadcasters = new Set<Broadcaster>();

/** Register a broadcaster; returns an unregister fn. Called by attachServerWs. */
export function registerBroadcaster(fn: Broadcaster): () => void {
  broadcasters.add(fn);
  return () => { broadcasters.delete(fn); };
}

interface SubClient {
  ws: WebSocket;
  interactionId?: string;
  organizationId?: string;
  alive: boolean;
}

interface AttachOpts {
  validateKey?: (key: string) => boolean;
}

// Throttle/coalesce state per interaction: dirty flag + timer ⇒ at most one
// snapshot frame per 150ms per session, always carrying the latest snapshot.
const pendingSnapshots = new Map<string, { last: number; timer: NodeJS.Timeout | null }>();

function fanout(interactionId: string, frame: WsFrame) {
  for (const b of broadcasters) b(interactionId, frame);
}

/** Broadcast a non-snapshot delta (decision / incident / ended). */
export function notifyEvent(
  ev: 'decision' | 'incident' | 'ended',
  interactionId: string,
  payload?: PolicyDecision | Incident,
) {
  const frame: WsFrame = { type: ev, interactionId };
  if (payload !== undefined) frame[ev] = payload;
  fanout(interactionId, frame);
}

/** Broadcast a snapshot delta, coalesced to ≤1 frame per 150ms per session. */
export function notifySnapshot(interactionId: string, session: { snapshot(): GovernanceSnapshot }) {
  const st = pendingSnapshots.get(interactionId) ?? { last: 0, timer: null };
  pendingSnapshots.set(interactionId, st);
  const send = () => {
    st.timer = null;
    st.last = Date.now();
    fanout(interactionId, { type: 'snapshot', interactionId, snapshot: session.snapshot() });
  };
  const wait = SNAPSHOT_MIN_INTERVAL_MS - (Date.now() - st.last);
  if (wait <= 0) {
    send();
  } else if (!st.timer) {
    st.timer = setTimeout(send, wait);
    st.timer.unref?.();
  }
}

function extractKey(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams.get('api_key');
  if (q) return q;
  // Sec-WebSocket-Protocol: client passes the token as the first subprotocol.
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string' && proto.length > 0) return proto.split(',')[0]!.trim();
  return null;
}

function sendTo(client: SubClient, frame: WsFrame) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(frame));
  }
}

export function attachServerWs(server: Server, opts: AttachOpts = {}): void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<SubClient>();
  let closed = false;

  const unregister = registerBroadcaster((interactionId, frame) => {
    for (const c of clients) {
      if (c.interactionId === interactionId || c.organizationId) sendTo(c, frame);
    }
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* terminating next round */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (closed) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Client cap — reject beyond MAX_CLIENTS with 503.
    if (clients.size >= MAX_CLIENTS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Auth: no keys configured (validateKey missing/absent) ⇒ allow.
    const key = extractKey(req);
    if (opts.validateKey) {
      if (key === null || !opts.validateKey(key)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const client: SubClient = { ws, alive: true };
      clients.add(client);
      ws.on('pong', () => { client.alive = true; });
      ws.on('close', () => { clients.delete(client); });
      ws.on('error', () => { clients.delete(client); });
      ws.on('message', (data: unknown) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(String(data)); } catch {
          return sendTo(client, { type: 'error', error: 'invalid JSON' });
        }
        if (msg.type === 'subscribe' && typeof msg.interactionId === 'string') {
          client.interactionId = msg.interactionId;
          delete client.organizationId;
          sendTo(client, { type: 'subscribed', interactionId: msg.interactionId });
        } else if (msg.type === 'subscribe_all' && typeof msg.organizationId === 'string') {
          client.organizationId = msg.organizationId;
          delete client.interactionId;
          sendTo(client, { type: 'subscribed', organizationId: msg.organizationId });
        } else {
          sendTo(client, { type: 'error', error: 'unknown message type' });
        }
      });
    });
  });

  server.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    unregister();
    for (const c of clients) c.ws.terminate();
    clients.clear();
  });
}
