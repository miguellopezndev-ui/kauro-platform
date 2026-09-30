/**
 * The DisclosureComposer of this edition (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §7, D8-CAU-6;
 * owner manual 11/07): the server-side truth CMD025 ApprovePlan compares the caller's acknowledged disclosures against. It is computed
 * from records alone — the plan's mapping effects and the validation receipt's counts — so it is deterministic, calls no core and reads
 * no customer value:
 *
 *   - one safe token per mapping, `<intent kind>:<target object>.<target field>:<physical source rows the receipt counted>`;
 *   - `includesClear` is true when any token discloses a CLEAR operation (a value the plan removes);
 *   - `disclosuresHash` is the SHA-256 of the canonical JSON of the plan hash, the receipt hash and the tokens, so a disclosure set
 *     names the exact plan and the exact evidence it describes and cannot be replayed onto another.
 */
import { canonicalBytes, rawDigest, type Sha256Hex } from "@kauro/contracts";
import type { DisclosureComposer, DisclosureSet } from "../ports/plan-services.js";

const composer: DisclosureComposer = {
  async compose(_uow, plan, body, receipt): Promise<DisclosureSet> {
    const items = body.mappings.map((m) => `${m.intent.kind}:${m.targetObject}.${m.targetField}:${receipt.counts.physicalSourceRows}`);
    const disclosuresHash = rawDigest(canonicalBytes({ planHash: plan.bodyHash, receiptHash: receipt.receiptHash, items })) as Sha256Hex;
    return { disclosuresHash, items, includesClear: items.some((item) => item.startsWith("CLEAR:")) };
  },
};

export const disclosureComposer: DisclosureComposer = Object.freeze(composer);
