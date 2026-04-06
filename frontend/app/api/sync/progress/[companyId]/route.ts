/**
 * Phase 8 — Next.js SSE Proxy for Sync Progress
 *
 * Proxies the backend SSE stream to the browser without requiring the frontend
 * to connect directly to the backend on a different origin.
 *
 * GET /api/sync/progress/[companyId]?jobId=<jobId>
 *
 * Streams Server-Sent Events:
 *   data: {"jobId","state","progress","invoicesFetched","message","error"}\n\n
 *   heartbeat: data: {"type":"heartbeat"}\n\n every 15s
 */
import { type NextRequest } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL
  ?? process.env.NEXT_PUBLIC_API_URL
  ?? 'http://localhost:3001';

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
): Promise<Response> {
  const { companyId } = await params;
  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: 'jobId query param required' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Forward authorization cookies so the backend middleware can authenticate the user
  const cookieHeader = request.headers.get('cookie') ?? '';

  // Open SSE stream to backend
  const backendUrl = `${BACKEND_URL}/api/sync/progress/${encodeURIComponent(jobId)}?companyId=${encodeURIComponent(companyId)}`;
  let backendRes: Response;
  try {
    backendRes = await fetch(backendUrl, {
      headers: {
        cookie:  cookieHeader,
        accept:  'text/event-stream',
      },
      // @ts-expect-error — Node 18+ fetch supports duplex: 'half' for streaming
      duplex: 'half',
    });
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: { code: 'UPSTREAM_ERROR', message: 'Cannot reach backend' } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (!backendRes.ok || !backendRes.body) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 'UPSTREAM_ERROR', message: `Backend responded ${backendRes.status}` } }),
      { status: backendRes.status, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Interleave backend events with heartbeats to keep the connection alive
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const heartbeatInterval = setInterval(() => {
    void writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`));
  }, HEARTBEAT_INTERVAL_MS);

  void (async () => {
    try {
      const reader = backendRes.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } finally {
      clearInterval(heartbeatInterval);
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering for SSE
    },
  });
}
