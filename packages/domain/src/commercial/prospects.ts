/**
 * The prospect organization key (design D10-PROS-1; 18 "Prospect qualification"; 12 "Prospect record"; CMD045 failure "a suppressed
 * identity cannot be reactivated through spelling or duplicate-list import").
 *
 * KAURO_PROSPECT_ORGANIZATION_V1 is the domain-separated digest of the normalized business domain: trimmed, lower case, IDNA ASCII
 * through node:url's domainToASCII (UTS #46 mapping, so full-width and Unicode spellings meet their punycode form), without leading
 * `www.` labels and without the trailing root dot. One live prospect exists per key and suppression matches it, so every spelling
 * of one domain, and a re-imported list, lands on the same key. The digest is the canonical wrapper of reference/HASHING, like
 * B09's payment-intent and refund-effects digests.
 */
import { canonicalBytes, rawDigest, type Sha256Hex } from "@kauro/contracts";
import { domainToASCII } from "node:url";

export const PROSPECT_ORGANIZATION_DOMAIN = "KAURO_PROSPECT_ORGANIZATION_V1";

/** An LDH label: letters, digits and inner hyphens, 1..63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A top-level label has a letter (a numeric address is not a business domain). */
const TOP_LABEL = /[a-z]/;

/** The normalized business domain, or null when the text is not a business domain name (a URL, a single label, an address). */
export function normalizeOrganizationDomain(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /[\s/:@?#\\]/.test(trimmed)) return null;
  let ascii = domainToASCII(trimmed.toLowerCase()).toLowerCase();
  if (ascii.endsWith(".")) ascii = ascii.slice(0, -1);
  while (ascii.startsWith("www.")) ascii = ascii.slice(4);
  if (ascii.length === 0 || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (!TOP_LABEL.test(labels[labels.length - 1] as string)) return null;
  return ascii;
}

/** The organization key of a business domain under KAURO_PROSPECT_ORGANIZATION_V1, with the normalized domain; null when none. */
export function organizationKeyOf(text: string): { readonly domain: string; readonly key: Sha256Hex } | null {
  const domain = normalizeOrganizationDomain(text);
  if (domain === null) return null;
  return { domain, key: rawDigest(canonicalBytes({ domain: PROSPECT_ORGANIZATION_DOMAIN, version: 1, payload: { organizationDomain: domain } })) };
}
