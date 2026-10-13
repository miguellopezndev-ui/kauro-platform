import "server-only";
import { uploadOriginOrNull } from "../security-headers.ts";

// The only reader of KAURO_UPLOAD_ORIGIN (D-SCR-3, D-SEC-2): the one origin the provider's upload session may live on. Read on each call;
// absent or malformed means no upload origin: the upload screen says uploads are unavailable and the policy names no foreign origin.

/** The configured upload origin, or null when the deployment names none (or names something that is not one https origin). */
export function uploadOrigin(): string | null {
  return uploadOriginOrNull(process.env["KAURO_UPLOAD_ORIGIN"]);
}
