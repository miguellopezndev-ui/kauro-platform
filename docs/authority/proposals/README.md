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
  replaced value is proved by a `test` first, that nothing is removed or overwritten, that no path is changed by two items, that each
  item has a closed status and a traceable approval, and that the resulting registry is still accepted by the contracts generator.

## Status of an item

| Status | Meaning |
|---|---|
| `APPROVED_AWAITING_REISSUE` | The substance was decided by the owner, or is already stated by the authority or the law. It waits only for adoption. |
| `CONDITIONAL` | The principle is decided; a value, a fact or a professional check listed in `pending` is missing. Not adoptable yet. |
| `PROPOSED` | A recommendation. It needs the owner's decision; writing it here decides nothing. |

`ADOPTED` is not used until the first adoption (below); the test refuses it.

## Adoption

1. The owner signs the items to adopt in the proposal's signature block (date and words), or rejects them.
2. The authority re-issue applies the signed items' operations to the registry, sets the new edition label, and records the new hashes
   and the proposal in `PROVENANCE.json` (`source`). This is the step the generator's message calls "re-vendor from the authority and
   record the new hash"; it is never a silent edit.
3. In the same change: the generated contracts are regenerated; every copy of a changed value is updated with its drift test (domain
   constants, SQL checks, the web's policy snapshot, the public words); legal texts change only by their own procedure
   (`docs/legal/CHANGE-REQUESTS-CP-01.md`).
4. The adopted items move to `ADOPTED` with the provenance hash, and the test is extended to check them against the registry.

Issued quotes, accepted terms, existing retention records and earned commissions keep the version they were created under: adoption is
prospective.
