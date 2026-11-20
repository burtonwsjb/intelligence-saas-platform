import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security-headers";

function hostedRuntime(): boolean {
  const explicit = process.env.ISP_ENV?.trim().toLowerCase();
  if (explicit === "staging" || explicit === "production") {
    return true;
  }
  if (explicit === "local" || explicit === "test") {
    return false;
  }
  return process.env.NODE_ENV === "production";
}

const nextConfig: NextConfig = {
  transpilePackages: ["@isp/auth", "@isp/billing", "@isp/contracts", "@isp/db", "@isp/shared"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({ hosted: hostedRuntime() }),
      },
      // Keep the app, the admin console (API docs and keys) and the API terms
      // out of search even if a crawler ignores robots.txt.
      ...["/admin/:path*", "/admin", "/app/:path*", "/app", "/api-terms"].map((source) => ({
        source,
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      })),
    ];
  },
};

export default nextConfig;
