// Server-side API routes the browser console calls. These proxy to the CX
// Trust API service so the browser never needs the API key or, later, the
// network location of the governance service.

import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.CXTRUST_API_URL ?? 'http://127.0.0.1:8787';
const API_KEY = process.env.CXTRUST_API_KEY;

function headers(): HeadersInit {
  return { 'content-type': 'application/json', ...(API_KEY ? { 'x-api-key': API_KEY } : {}) };
}

async function proxy(req: NextRequest, path: string): Promise<NextResponse> {
  const method = req.method;
  let body: string | undefined;
  if (method !== 'GET' && method !== 'DELETE') {
    body = await req.text();
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: headers(),
      body,
      cache: 'no-store',
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return NextResponse.json({ error: 'CX Trust API unreachable', apiBase: API_BASE }, { status: 503 });
  }
}

export async function GET(req: NextRequest) {
  return proxy(req, req.nextUrl.searchParams.get('path') ?? '/');
}

export async function POST(req: NextRequest) {
  return proxy(req, req.nextUrl.searchParams.get('path') ?? '/');
}
