// The owner's private-screen review (Order 11): a separate Next project that is never part of the product. It mounts the web's real screens
// and the prototypes of the screens not built yet, with synthetic data, at their real application paths on the review edge
// (tools/review/serve.mjs), which sends it the private paths only; its own assets live under /__review/assets so they never meet the
// product's. Its index and viewer are at /__review/private.
// It resolves its packages through apps/web (node_modules is a junction made by tools/review/private/link.mjs), so it adds no dependency.
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");

export default {
  assetPrefix: "/__review/assets",
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
};
