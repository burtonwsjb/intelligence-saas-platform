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
    ];
  },
};

export default nextConfig;
