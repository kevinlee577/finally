import type { NextConfig } from "next";

/**
 * Static export: `next build` writes a fully static site to `frontend/out/`,
 * which the Dockerfile copies to `/app/static` for FastAPI to serve (PLAN §11).
 * Everything is same-origin, so API calls are plain relative `/api/*` paths.
 */
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
