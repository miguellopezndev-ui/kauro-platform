/**
 * Names and digests the execution control plane mints (package B08; docs/design/B08-audit-approval-jobs.md D8-PUB-1, D8-STG-5,
 * D8-VER-1). Pure functions: a redelivered step computes the same name, so a delivery copy is written once under its generation-0
 * precondition and found again, never duplicated.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import type { ExpectedAuthority } from "@kauro/application";

/** Platform domain of a delivery copy's name component (the object grammar admits only UUID components; D8-STG-5's shape). */
export const DELIVERY_OBJECT_NAME_DOMAIN = "KAURO_DELIVERY_OBJECT_NAME_V1";
/** Platform domain of the authority the platform supplies a verification (its digest is the verification row's evidence). */
export const EXPECTED_AUTHORITY_DOMAIN = "KAURO_EXPECTED_AUTHORITY_V1";

function uuidV8Of(hex: string): string {
  const bytes = Buffer.from(hex.slice(0, 32), "hex");
  bytes[6] = 0x80 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The delivery copy of a staged artifact under the package's own prefix `delivery/{agency}/{project}/{package}/` (D8-PUB-1). */
export function deliveryObjectNameOf(deliveryPrefix: string, sourceObjectName: string): string {
  if (!deliveryPrefix.startsWith("delivery/") || !deliveryPrefix.endsWith("/")) throw new TypeError("a delivery prefix is the package's own");
  return `${deliveryPrefix}${uuidV8Of(rawDigest(canonicalBytes({ domain: DELIVERY_OBJECT_NAME_DOMAIN, version: 1, payload: { deliveryPrefix, sourceObjectName } })))}`;
}

/** KAURO_EXPECTED_AUTHORITY_V1 over the authority the platform supplied the verifier, artifacts ordered by object name. */
export function expectedAuthorityHashOf(expected: ExpectedAuthority): Sha256Hex {
  const requiredArtifacts = expected.requiredArtifacts
    .map((a) => ({ role: a.role, objectName: a.objectName, generation: a.generation, sha256: a.sha256, byteLength: a.byteLength }))
    .sort((a, b) => (a.objectName < b.objectName ? -1 : a.objectName > b.objectName ? 1 : 0));
  return rawDigest(canonicalBytes({ domain: EXPECTED_AUTHORITY_DOMAIN, version: 1, payload: { ...expected, requiredArtifacts } }));
}
