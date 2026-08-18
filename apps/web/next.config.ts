import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@isp/auth", "@isp/contracts", "@isp/db", "@isp/shared"],
};

export default nextConfig;
