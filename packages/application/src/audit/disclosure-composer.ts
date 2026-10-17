/**
 * The DisclosureComposer of this edition (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §7, D8-CMA-6;
 * owner manual 11/07): the server-side truth CMD025 ApprovePlan compares the caller's acknowledged disclosures against. It is computed
 * from records alone — the plan's mapping effects and the validation receipt's counts — so it is deterministic, calls no core and reads
 * no customer value:
 *
 *   - one safe token per mapping, `<intent kind>:<target object>.<target field>:<physical source rows the receipt counted>`;
 *   - `includesClear` is true when any token discloses a CLEAR operation (a value the plan removes);
 *   - `disclosuresHash` is the SHA-256 of the canonical JSON of the plan hash, the receipt hash and the tokens, so a disclosure set
 *     names the exact plan and the exact evidence it describes and cannot be replayed onto another.
 *
 * `disclosureItemsOf` and `disclosuresHashOf` are the two halves, exported so a reader of an approval (a B13 report's material
 * decisions, order 6) composes the same set from the same records and checks it against the approval's recorded hash.
 */
import { canonicalBytes, rawDigest, type Sha256Hex } from "@kauro/contracts";
import type { PlanBody } from "@kauro/domain";
import type { DisclosureComposer, DisclosureSet } from "../ports/plan-services.js";

/** The disclosure tokens of a plan body, given the physical source rows its validation receipt counted. */
export function disclosureItemsOf(body: Pick<PlanBody, "mappings">, physicalSourceRows: number): readonly string[] {
  return body.mappings.map((m) => `${m.intent.kind}:${m.targetObject}.${m.targetField}:${physicalSourceRows}`);
}

/** The hash an approval records for the disclosure set of `planHash` over `receiptHash`. */
export function disclosuresHashOf(planHash: string, receiptHash: string, items: readonly string[]): Sha256Hex {
  return rawDigest(canonicalBytes({ planHash, receiptHash, items: [...items] })) as Sha256Hex;
}

const composer: DisclosureComposer = {
  async compose(_uow, plan, body, receipt): Promise<DisclosureSet> {
    const items = disclosureItemsOf(body, receipt.counts.physicalSourceRows);
    const disclosuresHash = disclosuresHashOf(plan.bodyHash, receipt.receiptHash, items);
    return { disclosuresHash, items, includesClear: items.some((item) => item.startsWith("CLEAR:")) };
  },
};

export const disclosureComposer: DisclosureComposer = Object.freeze(composer);
