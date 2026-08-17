import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@isp/contracts", "@isp/shared"],
};

export default nextConfig;
