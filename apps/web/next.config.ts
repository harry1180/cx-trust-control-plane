import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // VPS deployment: Traefik serves this app under https://<host>/console
  // (router cxtrust-web for pages; cxtrust-web-root rewrites the app's
  // root-absolute /_next and /api calls under the same prefix), so Next must
  // honour the base path. Set basePath: "" for local `next dev` at the root.
  basePath: "/console",
};

export default nextConfig;
