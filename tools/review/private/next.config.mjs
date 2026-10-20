// The owner's private-screen review (Order 11): a separate Next project that is never part of the product. It mounts the web's real screens
// and the prototypes of the screens not built yet, with synthetic data, under /__review/private on the review edge (tools/review/serve.mjs).
// It resolves its packages through apps/web (node_modules is a junction made by tools/review/private/link.mjs), so it adds no dependency.
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");

export default {
  basePath: "/__review/private",
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
};
