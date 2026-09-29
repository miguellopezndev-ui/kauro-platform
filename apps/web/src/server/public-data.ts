import "server-only";
import type { Publication } from "../public/capabilities.ts";
import { publicationAddress } from "./config/site-origins.ts";
import { readPublication } from "./publication-reader.ts";

/**
 * The capability publication for one page render (D-TOPO-2): read from the deployment's public origin on every request, never cached, so a
 * page cannot show a service as open after the api stopped admitting it. A publication that cannot be read is UNAVAILABLE, and every page
 * words that as "cannot be read right now".
 */
export async function loadPublication(): Promise<Publication> {
  return readPublication(publicationAddress());
}
