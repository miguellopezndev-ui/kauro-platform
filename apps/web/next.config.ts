import { join } from "node:path";
import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/server/security-headers";

// The workspace root: output file tracing and Turbopack resolve the pnpm workspace packages (isolated linker) from there.
const workspaceRoot = join(import.meta.dirname, "..", "..");

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
  poweredByHeader: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  // No image optimizer: logos come re-encoded from the api's safe media pipeline (CMD008) and no remote image is ever fetched
  // (08 "Quarantine and malware boundaries"; GHSA-2xp9-vwfh-vxw4 was an unauthenticated RCE in the optimizer).
  images: { unoptimized: true },
  async headers() {
    return [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS.map(({ key, value }) => ({ key, value })) }];
  },
};

export default config;
