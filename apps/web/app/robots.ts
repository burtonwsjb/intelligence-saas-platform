import type { MetadataRoute } from "next";

/**
 * Search engines may index the public marketing pages only. The signed-in
 * app, the admin console (including the API docs and key pages) and the API
 * terms stay out of search (owner 2026-11-20: "hide the api").
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/app", "/api", "/api-terms", "/developers", "/onboarding", "/workspace-unavailable"],
    },
  };
}
