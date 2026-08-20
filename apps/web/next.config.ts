import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@isp/auth", "@isp/billing", "@isp/contracts", "@isp/db", "@isp/shared"],
};

export default nextConfig;
