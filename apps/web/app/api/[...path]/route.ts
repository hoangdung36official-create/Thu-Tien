import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, { params }: Context): Promise<Response> {
  try {
    const { path } = await params;
    const rawUrl = process.env.API_INTERNAL_URL?.trim();
    const rawHostport = process.env.API_INTERNAL_HOSTPORT?.trim();
    const candidates = [rawUrl, rawHostport ? `http://${rawHostport}` : undefined, process.env.VERCEL ? undefined : 'http://127.0.0.1:4000'].filter((value): value is string => !!value);
    let upstream: URL | null = null;
    for (const candidate of candidates) {
      try {
        upstream = new URL(candidate.includes('://') ? candidate : `http://${candidate}`);
        break;
      } catch {}
    }
    if (!upstream) {
      return Response.json(
        { error: 'Máy chủ dữ liệu chưa có địa chỉ kết nối hợp lệ' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const url = new URL(`/api/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`, upstream);
    const headers = new Headers(request.headers);
    // Let the HTTP client set the upstream authority and body framing.
    for (const name of ['host', 'connection', 'content-length', 'transfer-encoding']) headers.delete(name);
    headers.set('x-vincent-public-origin', request.nextUrl.origin);
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      cache: 'no-store',
      redirect: 'manual',
      signal: request.signal,
    });
    const outgoing = new Headers(response.headers);
    // Node fetch decompresses the response; stale encoding/length corrupts PDFs.
    for (const name of ['connection', 'transfer-encoding', 'content-encoding', 'content-length']) outgoing.delete(name);
    outgoing.set('Cache-Control', 'no-store');
    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers: outgoing,
    });
  } catch (error) {
    console.error('Vincent API upstream unavailable', error);
    return Response.json({ error: 'Máy chủ dữ liệu đang tạm thời không phản hồi' }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as HEAD, proxy as OPTIONS };
