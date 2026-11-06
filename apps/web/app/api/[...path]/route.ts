import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, { params }: Context): Promise<Response> {
  const { path } = await params;
  // A Vercel preview has no local Fastify service. Avoid forwarding sensitive
  // login requests to localhost when an external backend is not configured.
  if (process.env.VERCEL && !process.env.API_INTERNAL_URL) {
    return Response.json(
      { error: 'Bản xem thử chưa kết nối máy chủ dữ liệu. Quản trị viên cần cấu hình API_INTERNAL_URL.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const hostport = process.env.API_INTERNAL_HOSTPORT;
  const upstream = process.env.API_INTERNAL_URL || (hostport ? `http://${hostport}` : 'http://127.0.0.1:4000');
  const url = new URL(`/api/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`, upstream);
  const headers = new Headers(request.headers);
  // Let the HTTP client set the upstream authority and body framing.
  for (const name of ['host', 'connection', 'content-length', 'transfer-encoding']) headers.delete(name);

  try {
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
