export function jsonError(
  code: string,
  message: string,
  status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 429,
  requestId?: string | null,
): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (requestId) {
    headers["x-request-id"] = requestId;
  }
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        request_id: requestId ?? null,
      },
    }),
    { status, headers },
  );
}
