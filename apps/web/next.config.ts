import type { NextConfig } from "next";
import { isHostedRuntime } from "@isp/shared";
import { securityHeaders } from "./lib/security-headers";

const nextConfig: NextConfig = {
  transpilePackages: ["@isp/auth", "@isp/billing", "@isp/contracts", "@isp/db", "@isp/shared"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({ hosted: isHostedRuntime() }),
      },
    ];
  },
};

export default nextConfig;
