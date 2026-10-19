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
    return [
      { source: "/:path*", headers: STATIC_SECURITY_HEADERS.map(({ key, value }) => ({ key, value })) },
      // the faces (Order 10) live under versioned paths (/fonts/inter-4.1/…): a new release is a new path, so a file never changes in place
      ...["/fonts/inter-4.1/:file", "/fonts/jetbrains-mono-2.304/:file"].map((source) => ({ source, headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] })),
    ];
  },
};

export default config;
