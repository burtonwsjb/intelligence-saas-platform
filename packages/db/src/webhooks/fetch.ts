import { assertPublicWebhookUrl, assertRedirectTargetSafe } from "./ssrf.js";

/**
 * Default tenant webhook fetch. Redirects are not followed automatically.
 */
export async function safeWebhookFetch(input: {
  url: string;
  body: string;
  headers: Record<string, string>;
}): Promise<{ status: number; bodyText: string }> {
  assertPublicWebhookUrl(input.url);
  const response = await fetch(input.url, {
    method: "POST",
    headers: input.headers,
    body: input.body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    assertRedirectTargetSafe(response.headers.get("location"), new URL(input.url));
    return {
      status: response.status,
      bodyText: "redirect_not_followed",
    };
  }
  return {
    status: response.status,
    bodyText: await response.text(),
  };
}
