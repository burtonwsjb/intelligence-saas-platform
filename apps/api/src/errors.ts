export function jsonError(
  code: string,
  message: string,
  status: 401 | 402 | 403 | 429,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
