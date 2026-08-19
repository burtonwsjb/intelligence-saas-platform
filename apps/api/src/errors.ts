export function jsonError(
  code: string,
  message: string,
  status: 400 | 401 | 402 | 403 | 409 | 413 | 429,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
