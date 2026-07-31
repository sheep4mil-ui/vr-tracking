import type { NextConfig } from "next";

const pagesBasePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath: pagesBasePath,
  assetPrefix: pagesBasePath || undefined,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
