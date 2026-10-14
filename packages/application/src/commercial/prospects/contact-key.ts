/**
 * The contact key of a business address (plan docs/design/B12-outreach-plan.md A14; lane L-SOURCE): sha256 of KAURO_PROSPECT_CONTACT_V1 and
 * the case-folded NFC address, the same for every recorder, seller, prospect and sender route, so an opt-out survives reassignment,
 * reimport and provider change. The derivation lives in the domain (contactKeyOf, which the database repeats as kauro.prospect_contact_key,
 * KA095); this module is the application's one entry to it. D-33: the key reads no segment and no buyer type.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { contactKeyOf } from "@kauro/domain";

/** The normalized address and its key, or null when the text is not a business address. */
export function contactKey(address: string): { readonly address: string; readonly key: Sha256Hex } | null {
  return contactKeyOf(address);
}
