# MC-3 reopened — 2026-09-11

The independent audit `KAURO_AUDITORIA_MC_IC_20260911_V1.md` (sha256
`e5858e39fdf1808d51aaca95012ff67de70801c72119498830b0dcad8121a2d8`, evidence
bundle `f5d340df55671ecb126a5d851e46b44f539c44d96e4a92a381166fa9bd6d1610`)
reproduced seven material findings on `a2a549031de85d95be8645dd9c5156dfff2050a0`
(release v2.0.1). By the protocol (P17.4) a reproduced material defect
reopens the stage; the published release and its verdict of
2026-09-11T13:26:04Z stay as history, unchanged and unmoved. This branch is
the reopened MC-3; it ends in a new immutable release, never in an edit of
v2.0.1.

| finding | severity | state | change |
| --- | --- | --- | --- |
| MC-01 executed mode not bound to the attestation | ALTA | repaired | configuration mode == contract instance mode checked before any source read, every import mode |
| MC-02 matching authority from another object | CRÍTICA | repaired | record mapping → object; every field lookup restricted to that object; `locateField` removed |
| MC-03 hashed inputs not re-verified at the engine boundary | ALTA | repaired | profile and contract round-tripped through their loaders (schema, version, recomputed digest) and deep-frozen |
| MC-04 destination validation ignores instance constraints | CRÍTICA | see `docs/work/` note of the validation lot | validation consumes the attested TargetContract: object/field presence, writeability per import mode, type, limits, vocabularies; UNKNOWN never authorises |
| MC-04b HubSpot object writeability had no source (found by the vendor gate on the repaired candidate: every HubSpot writing run refused with `DESTINATION_MODE_UNSUPPORTED`, object flags `UNKNOWN` from both property readers) | CRÍTICA | repaired | the collector captures the portal's access grant (`POST /oauth/v2/private-apps/get/access-token-info`: portal, app, scopes; never the token) as `access-grant.json`, capture manifest version 2; `parseHubSpotAccessGrant` reads it back as one more hashed artifact of the same portal and the object flags come from `crm.objects.<object>.write` (present → TRUE, absent → FALSE, no grant → UNKNOWN as before); the HubSpot bundle of portal 51872453 was recaptured (the 2026-09-04 capture kept aside), HSP-TARGET-01 gains C6, and the campaign was resealed |
| MC-05 grouping separators accepted anywhere | ALTA | repaired | explicit numeric grammar for the declared separators; anything else INVALID/preserved |
| MC-06 years 0–99 shifted; serial overflow → NaN | ALTA | repaired | literal years; finiteness, calendar and range validation; `TRANSFORMATION_VERSION` 1.2.0 |
| MC-07 release verifier accepts foreign dossiers | ALTA | see the dossier lot note | closed schemas per asset class, archives opened and inventoried, flags derived from facts, package compared with an independent reconstruction |

## Version

`CORE_VERSION` 2.0.1 → 2.0.2 and tag `v2.0.2`: the engine's behaviour
changed (matching authority, destination validation, transformations). The
package format stays 2.0.0 and every contract whose content did not change
keeps its version; `TRANSFORMATION_VERSION` moves to 1.2.0 because every
`changes.csv` row names it. This is a new release of a reopened stage, not a
version exception.

## Invalidation

Per the audit's conservation matrix: matching/validation evidence for
HUBSPOT/SALESFORCE UPDATE/UPSERT paths, packages whose profile or contract
hash was not the hash of its body, and every semantics/determinism/package
baseline that exercises NUMBER, DATE or DATETIME fields are renewed. The
capacity producer's closure includes `src/`, so the capacity campaign is
sealed and run again for this candidate; vendor runs are repeated where the
matching or validation path changed. Nothing measured on v2.0.1 is
re-stamped onto this candidate.
