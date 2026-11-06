// Proxy for CX Trust connector adapters (Connect :8799, Twilio :8800,
// Genesys :8801). The browser never talks to adapters directly; this server-
// side route does, so adapter ports need not be exposed to the browser.
// ?adapter=twilio|connect|genesys & path=/...
// For twilio POST /twilio/configure this forwards credentials verbatim;
// they are never logged here.

import { NextRequest, NextResponse } from 'next/server';

const ADAPTER_PORTS: Record<string, string> = {
  twilio: '8800',
  connect: '8799',
  genesys: '8801',
  nice: '8802',
  five9: '8803',
  cisco: '8804',
  avaya: '8805',
};

export async function GET(req: NextRequest) {
  return proxy(req);
}

export async function POST(req: NextRequest) {
  return proxy(req);
}

async function proxy(req: NextRequest) {
  const adapter = req.nextUrl.searchParams.get('adapter') ?? '';
  const path = req.nextUrl.searchParams.get('path') ?? '/';
  const port = ADAPTER_PORTS[adapter];
  if (!port) {
    return NextResponse.json({ error: 'unknown adapter' }, { status: 400 });
  }
  let body: string | undefined;
  if (req.method !== 'GET') body = await req.text();
  // Connect adapter public-mode auth: when the adapter runs with
  // CXTRUST_CONNECT_TOKEN set, the proxy injects the header server-side so
  // the console UI keeps working without the browser ever seeing the token.
  const token = adapter === 'connect' ? process.env.CXTRUST_CONNECT_TOKEN : undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: req.method,
      headers: { 'content-type': 'application/json', ...(token ? { 'x-cxtrust-token': token } : {}) },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    const text = await res.text();
    return new NextResponse(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
  } catch {
    return NextResponse.json({ error: 'adapter unreachable' }, { status: 503 });
  }
}
