# Amendment A2 — brand and identifiers: Kavo → Kauro

Status: applied to every artifact produced from 2026-09-19 on; proposed to the authority as a versioned amendment (the R2 edition
and the AUTONOMY-A1 amendment predate the rename of 2026-09-15 and still say Kavo). Owner decision (2026-09-19): "nothing must
reference kavo, only kauro".

## Rules

1. The product, company and public brand are **Kauro**. No new file, package, repository, identifier, domain string, document or
   user-facing text uses "Kavo"/"kavo".
2. Normative identifiers defined by the R2 text are renamed one-to-one, same semantics, same versions:

   | R2 identifier | Kauro identifier |
   |---|---|
   | `KAVO_SOURCE_REVISION_V1` | `KAURO_SOURCE_REVISION_V1` |
   | `KAVO_TARGET_BODY_V1` | `KAURO_TARGET_BODY_V1` |
   | `KAVO_PLAN_BODY_V1` | `KAURO_PLAN_BODY_V1` |
   | `KAVO_CONFIG_FRAGMENT_V1` | `KAURO_CONFIG_FRAGMENT_V1` |
   | `KAVO_DECISION_EVIDENCE_V1` | `KAURO_DECISION_EVIDENCE_V1` |
   | `KAVO_PLAN_APPROVAL_V1` | `KAURO_PLAN_APPROVAL_V1` |
   | `KAVO_PROVIDER_REQUEST_V1` | `KAURO_PROVIDER_REQUEST_V1` |
   | `KAVO_QUOTE_TERMS_V1` | `KAURO_QUOTE_TERMS_V1` |
   | `KAVO_DELIVERY_MANIFEST_V1` | `KAURO_DELIVERY_MANIFEST_V1` |
   | `urn:kavo:r2:contracts` | `urn:kauro:r2:contracts` |
   | repository `kavo-platform` | `kauro-platform` |
   | repositories `kavo-migration-core`, `kavo-intelligence-core` | `kauro-migration-core`, `kauro-intelligence-core` (GitHub rename by the owner; npm package names follow in their next published version) |
   | command roles `KAVO_OWNER`, `KAVO_OWNER_OR_SECURITY_SERVICE` | `KAURO_OWNER`, `KAURO_OWNER_OR_SECURITY_SERVICE` |
   | support case state `WAITING_KAVO` | `WAITING_KAURO` |

   `@kauro/contracts` exports `R2_DOMAIN_ALIASES` so a reader of the authority text can map a digest domain to its Kauro name.
3. The vendored registry files under `packages/contracts/registry/` remain byte-identical to the authority (their hashes are the
   provenance). The generator emits the Kauro identifiers; a consumer never sees a Kavo identifier from this platform.
4. Internal identifiers of the construction service on the owner's host (Linux users, `/srv/kavo`, systemd units, the codename
   in its runtime) are renamed in a dedicated runtime round with a ledger migration and a full re-qualification; that round
   re-issues the authority package with this amendment attached.

## Why

The name "Kavo" collides with an existing HubSpot marketplace app (kavo.ai) and with registered dental-equipment trademarks
(KaVo). The owner renamed the project on 2026-09-15; the acceptance program and the runtime were not re-issued at the time.
