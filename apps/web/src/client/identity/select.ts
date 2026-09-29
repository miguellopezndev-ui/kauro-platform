// Which IdentityClient a page uses (design D-AUTH-2): the one `GET /api/v1/public/identity-config` announces, checked before it is built.
// The announcement is untrusted input: the fake is built only for an announcement that names it and gives a same-origin path, and an
// announcement of the live adapter yields "not available" until W-IDP-LIVE ships it, never a silent fallback to the fake.
import type { FetchLike } from "../api-client.ts";
import { ContractFakeIdentityClient, fetchIdentityTransport } from "./contract-fake.ts";
import type { IdentityConfig, Selection } from "./port.ts";

export function selectIdentityClient(config: IdentityConfig, fetch: FetchLike): Selection {
  switch (config.adapter) {
    case "CONTRACT_FAKE":
      try {
        return { kind: "CLIENT", client: new ContractFakeIdentityClient(fetchIdentityTransport(fetch, config.baseUrl)) };
      } catch (error) {
        if (error instanceof RangeError) return { kind: "CONFIG_REFUSED" };
        throw error;
      }
    case "LIVE":
      return { kind: "LIVE_NOT_AVAILABLE" };
  }
}

/** Reads an announcement of unknown shape into an IdentityConfig, or null. */
export function readIdentityConfig(value: unknown): IdentityConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record["adapter"] === "LIVE" && keys.length === 1) return { adapter: "LIVE" };
  if (record["adapter"] === "CONTRACT_FAKE" && keys.length === 2 && typeof record["baseUrl"] === "string") return { adapter: "CONTRACT_FAKE", baseUrl: record["baseUrl"] };
  return null;
}
