// Which IdentityClient a page uses (design D-AUTH-2): the one `GET /api/v1/public/identity-config` announces, checked before it is built.
// The announcement is untrusted input: the fake is built only for an announcement that names it and gives a same-origin path, and an
// announcement of the live adapter yields "not available" until W-IDP-LIVE ships it, never a silent fallback to the fake.
import { isGetIdentityConfigResponse200 } from "../../api/generated.ts";
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

/**
 * Reads the api's announcement (the reply of getIdentityConfig, checked by its generated guard, D-GEN-1) into an IdentityConfig, or null.
 * The live provider (IDENTITY_PLATFORM) is the live adapter; the fake is usable only with the endpoint it is reached at, a path of this
 * origin (the api announces nothing else, B11 D-INT1-4). Anything the contract does not describe is null.
 */
export function readIdentityConfig(value: unknown): IdentityConfig | null {
  if (!isGetIdentityConfigResponse200(value)) return null;
  if (value.adapter === "IDENTITY_PLATFORM") return value.endpoint === undefined ? { adapter: "LIVE" } : null;
  return value.endpoint === undefined ? null : { adapter: "CONTRACT_FAKE", baseUrl: value.endpoint };
}
