# ChangeProposals

A ChangeProposal (CP) is the route by which a decision changes the vendored authority registry
(`packages/contracts/registry/*.json`): D-34 §1.3 ("a change to a registry still goes through a ChangeProposal and a new version"),
A3 §1.4 and §2 (the change-record fields of 01 §Authority and change control, 28 §How a change is made and 20 §Review output).

**A proposal is not authority.** Nothing in this folder changes what the platform enforces. The registry stays byte-identical to its
recorded provenance until an item is adopted.

## Files

- `CP-xx-<NAME>.md`: the change record (the A3 §2 fields), one section per item, the owner's signature block.
- `CP-xx.registry-delta.json`: each item's exact change as a subset of JSON Patch (RFC 6902: `test`, `add`, `replace`), written against
  the registry bytes named in `base`. `tools/test/change-proposals.test.mjs` checks that the base is the vendored registry, that every
  replaced value is proved by a `test` first, that nothing is removed or overwritten, that no path is changed by two items (of the
  same or of another proposal), that each item has a closed status and a traceable approval, and that the resulting registry, of each
  proposal and of all of them together, is still accepted by the contracts generator.

## Status of an item

| Status | Meaning |
|---|---|
| `APPROVED_AWAITING_REISSUE` | The substance was decided by the owner, or is already stated by the authority or the law. It waits for adoption, and takes effect only with its `activation`. |
| `CONDITIONAL` | The principle is decided; a value, a fact or a professional check listed in `pending` is missing. Not adoptable yet. |
| `PROPOSED` | Not approved: a recommendation awaiting the owner, or an item the owner deferred (`deferred`), whose current registry text stays. Writing it here decides nothing. |

`ADOPTED` is not used until the first adoption (below); the test refuses it.

CP-02 adds, beside the status, a `class` with a fourth value, `BLOCKED_EXTERNAL` (status `CONDITIONAL`): not adoptable even with the
owner's decision until counsel, the accountant, a provider or a tool fact answers. An approved CP-02 item that must name vocabulary of a
CP-01 item not yet approved declares it under `reserves` (`tools/test/cp02-api-contracts.test.mjs` refuses any other mention). CP-02's
delta is generated from `CP-02.api.json` by `tools/cp02.mjs`.

Each item also carries:

- `approval`: who decided, when, the record, and since the CP-01 owner resolution the `decision` in the owner's terms (`APPROVED`,
  `APPROVED_WITH_CHANGES`, `CONTENT_APPROVED_LEGAL_EFFECT_CONDITIONAL`, `DESIGN_APPROVED_PUBLICATION_CONDITIONAL`,
  `PARAMETERS_APPROVED_ACTIVATION_BLOCKED`) and its `basis` (earlier records).
- `deferred` (only on a `PROPOSED` item): the owner postponed it; the current registry text stays.
- `activation`: what must be implemented, tested or published by its own procedure before the adopted item takes effect. An approved
  item is adopted in the coordinated re-issue only together with its activation; a business authorization is not a deployment.

## Adoption

1. The owner decides the items in the proposal's decision block (date and words, with the decision record in
   `docs/authority/decisions/`), or rejects them. A formal external signature is added only where a procedure requires one.
2. The authority re-issue applies the decided items' operations to the registry, sets the new edition label, and records the new hashes
   and the proposal in `PROVENANCE.json` (`source`). This is the step the generator's message calls "re-vendor from the authority and
   record the new hash"; it is never a silent edit.
3. In the same change: the generated contracts are regenerated; every copy of a changed value is updated with its drift test (domain
   constants, SQL checks, the web's policy snapshot, the public words); legal texts change only by their own procedure
   (`docs/legal/CHANGE-REQUESTS-CP-01.md`).
4. The adopted items move to `ADOPTED` with the provenance hash, and the test is extended to check them against the registry.

Issued quotes, accepted terms, existing retention records and earned commissions keep the version they were created under: adoption is
prospective.

## Re-issue candidate

`reissue-candidate/` (Order 19A, `docs/design/ORDER19A-REISSUE-CANDIDATE.md`) prepares the coordinated re-issue of CP-01 and CP-02 as one
verifiable candidate, without adopting anything: the combined delta in apply order, every place where two items meet with its resolution,
two profiles (`adoption`: the approved items; `build`: plus the conditional ones, for the implementing orders with the activation off),
each with its candidate registry hashes, generated contracts, served document and web client, and each item's state and the orders or
gates that must satisfy its conditions. It is built by `tools/reissue/reissue.mjs` and checked by `tools/test/reissue-candidate.test.mjs`;
the proposal rules above read only the deltas at this folder's top level, so they see CP-01 and CP-02 alone. Steps 2 to 4 of the adoption
apply the candidate's items, never anything else.
