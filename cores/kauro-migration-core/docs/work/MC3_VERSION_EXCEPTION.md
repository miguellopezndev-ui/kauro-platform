# The v2.0.0 tag incident, and the authorisation that resolves it

## What happened

On 2026-09-10, after MC-3 merged to `main` at `759bac3cb199` with all eleven CI
jobs green and the external receipt verified, the release was created on tag
`v2.0.0` **before its assets had been uploaded**.

This repository has immutable releases. A published release is sealed: assets
cannot be added afterwards. So the empty release was deleted, to be recreated as
a draft and published complete.

Deleting an immutable release **permanently reserves its tag name**. GitHub then
refuses to create that ref again — by `git push`, by `POST /git/refs`, and as a
side effect of publishing a draft release that names it:

    ! [remote rejected] v2.0.0 -> v2.0.0 (push declined due to repository rule violations)
    Cannot create ref due to creations being restricted.

Verified as specific to that name rather than a repository rule: a probe tag
`v2.0.0-probe` on the same commit pushed without complaint, and
`GET /repos/.../rulesets?includes_parents=true` returns one branch ruleset and
no tag ruleset. Disabling the repository's immutable-releases setting through
the API did not release the name either.

The tag name `v2.0.0` is therefore unusable in
`miguellopezndev-ui/kauro-migration-core`, and only GitHub support can free it.

The fault is not GitHub's. A release should be assembled as a draft and
published once, complete; creating it empty and deleting it is what cost the
name. §11 of `MC3_EXECUTION_STATE.md` now states the order that avoids it.

## The authorisation

The owner authorised, expressly and in writing, an exception to the canonical
documents and to the Migration Core sheet:

> Autorizo una excepción expresa al canónico y a la hoja de Migration Core:
> sustituir el requisito de release/tag `v2.0.0` por `v2.0.1`, debido a la
> eliminación de la release inmutable y la reserva de su etiqueta. Documenta el
> incidente y esta autorización. No dependas de soporte para cerrar MC-3.
>
> Actualiza coherentemente las referencias y automatizaciones afectadas,
> conservando las versiones de los contratos cuyo contenido no cambie. Esta
> autorización no rebaja ningún gate ni permite declarar el freeze manualmente.

Two limits are stated in it and both are honoured here: **no gate is lowered**,
and **the freeze is not declared by hand**. The four flags remain computed by
`tools/freeze-verdict.mjs` from the merged commit, the external CI receipt, the
branch ruleset, the annotated tag and the downloaded release assets.

## What moved, and what did not

The engine's behaviour did not change. What changed is the release's identity.

**Moved to 2.0.1** — three declarations and the documents that name the release:

| where | what |
| --- | --- |
| `src/version.ts:7` | `CORE_VERSION`, the single authoritative declaration |
| `package.json` | the npm package version |
| `package-lock.json` | npm's mirror of it, which had been stale at 1.0.2 |
| `tools/freeze-verdict.mjs:37` | the usage example of `--tag` |
| `docs/release/HANDOFF_TO_INTELLIGENCE.md`, `docs/work/GATES.md`, `docs/work/MC3_EXECUTION_STATE.md` | the sentences that name the release |

**Held at 2.0.0** — every version whose content did not change:

`PACKAGE_FORMAT_VERSION`, because the package layout is the same. A format
version that moves without its format moving is a false statement about
compatibility. Also `CONFIG_SCHEMA_VERSION`, both adapter spec versions, and the
prose in `src/artifacts/layout.ts`, `src/verify/import-rows.ts` and
`src/verify/verify-against-source.ts` that describes the format.

`tools/version-floors.mjs` holds `coreVersion: '2.0.0'` and is **not** moved: it
is a `>=` floor, so 2.0.1 clears it untouched. Moving it would begin failing any
tree that declares 2.0.0 and would break two pinned self-test expectations.

Every other declared version — target contract, parser, attestation, scratch
store, source profile, candidate set, identity rule, family schema, digest
serialisation, exclusion rule, capacity profiles, capacity evidence schema,
universe schema, receipt schema, subject, campaign, capture, provenance, SBOM —
is unchanged, because its content is unchanged.

## How the list was established

Not by grep. Seven independent sweeps over separate surfaces — the runtime, the
root configuration, `tools/`, the qualification tree, the tests, the documents,
and the DRIFT-01 rules themselves — and every occurrence a sweep proposed to
change was then given to a second reader whose instruction was to refute it.

That second pass overturned three proposals, and each overturn is worth keeping:

- **`tools/version-floors.mjs`** — the sweep read the doc comment as a statement
  of the release version. It glosses a floor.
- **`package-lock.json`** — the sweep proposed moving a literal that says
  `1.0.2`, which is neither the old nor the new version. It is stale npm
  bookkeeping that nothing reads. It was moved here anyway, deliberately, for
  coherence rather than because a tool requires it, and only because this change
  reseals the campaign regardless.
- **`qualification/candidate/universe-logs/architecture.log`** — the sweep
  proposed editing a captured log. Its digest and byte count are pinned in a
  tracked report; editing it would falsify the record. It changes only by the
  universe running again.

## What it costs

`CORE_VERSION` is a hash input in three places: the run id
(`src/run/run-migration.ts`), the candidate-set hash (`src/profile/candidate-set.ts`)
and the package manifest (`src/artifacts/write-package.ts`). So every run id,
every candidate-set hash and every package digest moves. Golden fixtures,
acceptance packages and the whole qualification campaign are regenerated.

`src/version.ts` and `package.json` are `SEMANTIC_RUNTIME`, so the execution
subject moves and the campaign sealed before this change is invalidated — by
design. Evidence belongs to the campaign it was taken in.

Two guards begin refusing artifacts recorded at core 2.0.0: a 2.0.1 build will
not verify a 2.0.0 package (`src/verify/verify-against-source.ts`) nor accept a
2.0.0 candidate set (`src/profile/candidate-set.ts`). Both are deliberate and
both are correct here: everything this release ships is produced by the 2.0.1
build.
