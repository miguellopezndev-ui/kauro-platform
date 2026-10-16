# R-IC-PRIVACY — revision 009

Work order WO-IC-PRIVACY-009. Root problem R-IC-PRIVACY (root clock continues from
revision 008; every prior rejection and incident stands). Base commit
`27dbf10658454285262590fcea96ed011209299f`, tree
`202096dc40401596d241ebbe6282316f16af86a7`, verified at the start of the session.
Independent offline B03 preparation; spend USD 0; no publication, deployment,
CRM import, paid inference, messaging or controller change. Raw evidence is under
`evidence/` (not committed); this file holds the summaries and digests.

## 1. Diagnosis

The 13 September audit case `IC-egress-Segment-handles` / `IC-egress-Vendedor-handles`
(`audit/probe-residual.mjs`) put `HENDERSON7` and `NDEBELE8` in the lifecycle picklist
and in the Status column. The round-4 rule (`codeShaped`) called a digit-bearing token a
code when it was written in capitals (`CODE_UPPER`), when its digits were at least as
many as its letters, or when every letter run was vocabulary. Capitals and digit
dominance are shapes, and a surname in capitals has them; both tokens left as raw
options and raw L1 exemplars on the built baseline (reproduced here, §4).

Revision 008 had not separated a conforming rule from two partial repairs the brief
forbids: keeping digit dominance as an authorizer, and admitting every two-to-three
capital prefix before a separator and digits. Both are now sabotage mutations that the
suite kills (§6).

## 2. The rule (data policy 1.5.0)

`compactVerdict(token)` in `src/classifier/data-classifier.ts`, shared by every
channel. A whitespace-free token written with letters, digits and the separators
`_ - . / :` that carries a digit is judged whole, in this precedence:

1. **Migration Core file-id grammar** `^F-[0-9a-f]{12}$` (`F-1a5dfa29636d`): a code,
   admitted whole; the only grammar admitted as a whole token, and nothing wider
   (fourteen hex digits or a bare hex run are not it).
2. **Every letter run known → CODE.** A run is known when it is a single Latin letter
   (`A12`, `a12`, `4b`, `B2B`, `Q1`, `2024Q1`, `S0`, `C3`), a closed compact prefix in
   the first position immediately followed by its number with at most one separator
   (`SKU-0042`, `ISO-9001`, `PO_2024/07`, `ISO9001`), or a word of the label,
   enumeration or safe vocabulary, plurals and camel humps included (`tier1`, `phone2`,
   `level3`, `Tier2`, `nivel1`, `Address2`, `ClosedWon2`, `Custom_Field_2__c`).
   Stop words (`de`, `en`, `al`) are not words here.
3. **Otherwise → HANDLE**, `POTENTIAL_PII` on OPTION, LABEL, IDENTIFIER and
   `classifyValue`, whatever the case, length, script, separators or digit-to-letter
   ratio: `HENDERSON7`, `NDEBELE8`, `jkowalski1`, `mlopez01`, `okonkwo3`, `NDE-8`,
   `HEN_2024`, `wu2024`, `WU99`, `ndebelehenderson1234`, `ÑÁÑEZ7`, `müller7`,
   `Светлана7`, `田中7`, `k_ndebele_8`. A handle never stays UNKNOWN to avoid the call.

Not rules: a digit-to-letter ratio, capitals, two-to-three capitals before a separator,
and a bare ISO 3166/4217 code followed by digits (`US2024`, `ES-2024`, `EUR-01` are
handles; `US`, `ES`, `EUR` alone are still codes by the closed lists). The closed
compact-prefix list (`COMPACT_PREFIXES`) is semantic — business documents, product
codes, standards: `sku po so inv ord doc ref rfq rma qt lot sn pn tkt case prj opp ver
rev iso iec din ansi astm une ieee rfc gtin ean upc isbn duns naics cpv` — read
case-insensitively like the vocabulary words; personal-identifier prefixes (DNI, NIF,
SSN, VAT, IBAN) are deliberately absent. A prefix authorises the first run only
(`SKU-HENDERSON7` is a handle).

The name lists are still read over the letter runs first (`letterRuns` in
`namesPerson`), so `zuleika7` and `ZULEIKA7` are refused as the name they carry
(`reason: given name`), not merely as handles; `handle-letter-runs-unread` is killed by
that reason.

Genuinely UNKNOWN stays UNKNOWN: bare short capitals outside the ISO lists (`LEE`,
`WU`, `LIM`) as options and values; their Status FIELD_MAPPING task is ABSTAINED with
`EGRESS_BLOCKED_UNKNOWN`, no physical request, no Status source mapping, while the
deterministic fields still reach PROPOSAL_READY / SYSTEM_DRAFT. A digit-bearing token
with other punctuation (`Zq7#kL`) is outside the compact grammar and stays UNKNOWN too.
The kernel contract and the UNKNOWN semantics did not change.

Callers inspected: source headers (`LABEL`), file ids and sheets (`IDENTIFIER`),
target labels / api names / object names / types (`LABEL` / `IDENTIFIER`), target
options (`OPTION` through `classifyOption`), memory patterns (`LABEL`) and types,
repair `validationCodes` (`IDENTIFIER`) and `allowedValues` (`OPTION`), values
(`classifyValue`), and the egress re-read (`textChannels`, `exemplarReadsSafe`). A
dropped option is absent, never replaced by a token the model could select; a
contaminated source column is withheld whole while the task proceeds; safe members of a
mixed list stay. A vendor field whose api name is an ambiguous digit-bearing token
(`CB2_Segment__c`, `Sq1_Status__c`) survives by targetRef with its api name masked
(`api_…`), its label and options intact. `contract-adapter.ts` discards picklist
labels before transport and is outside scope: the label vector is a classifier guard,
not option-label transport minimization, and IC-05 coverage is not claimed complete.

## 3. Scoped references (masking policy 1.3.0) and versions

`maskKey` is `HMAC(egressSecret, digestOf(['mask', MASKING_POLICY_VERSION,
profileHash, agencyId, clientId, projectRevisionId, projectRevisionHash]))`.
`BuildEnvelopeInput.tenant` is required; `redactMetadata` refuses a blank scope
(`CONTRACT_VIOLATION`). Equal text in equal scope under an equal key is one stable
token; a change of agency, client, revision (id or hash), profile or key separates the
references; nothing of the scope travels, no reversible encoding and no unkeyed digest
is used. The kernel propagates `context.tenant` and the project revision into every
envelope build; egress binding, budgets, compiler permissions and real MC validation
are untouched.

`DATA_POLICY_VERSION` 1.4.0 → 1.5.0, `MASKING_POLICY_VERSION` 1.2.0 → 1.3.0,
`INTELLIGENCE_CORE_VERSION` 0.3.0 → 0.4.0 in `src/contracts/versions.ts`,
`package.json` and `package-lock.json`. Both policy versions are in the ledger run
identity (`RUN_CREATED.versions`) and in `IntelligenceResult.provenance`. Package
scripts, dependency identities, MC 2.0.1 compatibility and vendor bytes are unchanged
(CONTRACTS-01 PASS).

**Evidence invalidation.** Any classification or masking observation recorded under
data policy ≤ 1.4.0 or masking policy ≤ 1.2.0 — the round-4 probe replays and the
13 September audit records among them — describes another contract. The reviewer's
earlier executions are historical evidence; the revision-009 results below were run in
this session.

## 4. Baseline reproduction and replays

Setup (evidence `audit/setup-mc.sh`, `audit/setup-ic.sh`): the historical MC checkout
`ed09809ba3749ea84f0eecd85bf1b09f29b31d82` (tree `f5c28dbb…`) was cloned from the
read-only mirror and built from `src/` only with modules copied from the candidate's
materialized `node_modules` (fflate 0.8.3, libphonenumber-js 1.13.12, typescript 5.9.3;
`test/` needs fast-check, which is not materialized — recorded adaptation, no npm
cache, no network). The IC baseline was `git archive`d from the mirror at `27dbf10`
and built the same way; the candidate copy is the working tree. IC's real validation
fixture keeps the vendored MC 2.0.1 throughout. The original probes are kept verbatim
(`audit/original/`); the path adapter is a run directory with `mc` and `ic` symlinks
(`audit/run-probes.sh`); the only text change per probe is the recorded subject sha,
plus — on the candidate only — the tenant that `buildEnvelope` now requires in
`probe-ic-semantics.mjs` (adapter diffs beside each probe).

| probe | baseline 27dbf10 | candidate |
| --- | --- | --- |
| `probe-residual.mjs` IC-egress-Segment-handles | holds=false, hits `HENDERSON7`,`NDEBELE8`, options SAFE_STRUCTURAL_METADATA | holds=true, hits `[]`, options POTENTIAL_PII, PROPOSAL_READY / SYSTEM_DRAFT |
| IC-egress-Vendedor-handles | holds=false (same) | holds=true (same) |
| IC-egress-Segment-control | holds=true, hits `Active`,`Inactive` | holds=true, unchanged |
| MC-instance-type-time / future_scalar, MC-empty-enum-0, MC-clear-nillable-TRUE | holds=false | holds=false — incidental MC observations preserved, not repaired here (the two CLEAR cases are the triage's excluded hypotheses) |
| `probe-ic-semantics.mjs` (8: SEM-*, PRIV-option-Zuleika/Svetlana/Active, two-contact-files) | 8 hold, 0 harness errors | 8 hold, 0 harness errors |
| `probe-ic-api.mjs` (10: API-01, API-02, cancel, deadline, null-evidence, future-receipt, malformed-receipt, crash-durable-answer, redelivery-policy, provider-recovery) | 10 hold, 0 harness errors | 10 hold, 0 harness errors |

Residual totals: baseline `{cases:10, violations:6, harnessErrors:0}`; candidate
`{cases:10, violations:4, harnessErrors:0}` — the four remaining are MC's.

## 5. Checks run on the final code (this session, observed)

- `npm run build`: exit 0.
- `node tools/run-tests.mjs` (complete IC suite): 350 tests, 350 pass, 0 fail
  (`evidence/test-suite.log`). New: `test/privacy-revision-009.test.ts` (23 tests:
  the compact rule and its precedence, the two forbidden partial repairs, case/script/
  separator handles, ISO-code-plus-digits, useful controls of every channel, UNKNOWN
  controls, name-list precedence by reason; envelope: mixed list without substitute,
  memory-pattern LABEL handle, repair validationCodes/allowedValues handles,
  availability of `CB2_Segment__c` / `Sq1_Status__c`; references: cross-profile /
  tenant / revision / key separation, no tenant in bytes, unscoped build refused;
  public API with real MC 2.0.1: audit reproduction on the wire, useful control,
  UNKNOWN abstention, six scoped runs, provenance and run-identity versions).
  Updated with rationale, not removed: `privacy-classifier.test` R2R-PC-02
  (`jkowalski1`/`mlopez01`/`okonkwo3` now POTENTIAL_PII, never UNKNOWN by omission),
  `privacy-envelope.test` (handles recorded as PII against the target; policy
  versions 1.3.0 / 1.5.0; scope passed to `buildEnvelope`), and the tenant added to
  every test `buildEnvelope` call.
- `npm run contracts:check`: CONTRACTS-01 PASS (`evidence/contracts-check.log`).
- Focused sabotage (`node tools/sabotage.mjs --only …`, DIAGNOSTIC, never
  qualifying; `evidence/sabotage-diagnostic.{log,json}`): unmutated baseline 350
  pass; `handle-treated-as-code` KILLED (15 failures), `handle-letter-runs-unread`
  KILLED (1), `numeric-dominance-authorises` KILLED (4), `any-short-prefix-admitted`
  KILLED (4), `handle-left-unknown-in-value` KILLED (9),
  `handle-left-unknown-in-metadata` KILLED (12), `iso-code-plus-digits-admitted`
  KILLED (2), `mask-key-unscoped` KILLED (2). The privacy inventory grows from 26 to
  32 mutations (76 in all); the two existing handle anchors were re-anchored on the
  new implementation with their truth kept; no case was removed. The remaining 68
  mutations were not executed in this session (full qualification is separate work).
- Sealed positive-control patch: saved to
  `evidence/positive-control-useful-vocabulary-009.patch`; `git apply --check` against
  the final candidate exits 0 (`evidence/positive-control-apply-check.txt`); both
  context lines are verbatim at `src/classifier/data-classifier.ts:553–554`.
- Local reproduction of the two sealed checks with a **builder stand-in**
  `vectors.json` (the private fixtures are withheld; the stand-in proves the
  mechanics only, `evidence/audit/sealed/`): USEFUL-VOCABULARY on the candidate
  `{passed:true, usefulCases:38}`; the patch applied to a separate copy (offset 87
  lines), rebuilt, fails on `useful OPTION rejected` (exit 1). PACKED-RULE-AND-SCOPE
  on the packed candidate installed by tar into a materialized consumer with the
  baseline's `dist/test/support/fixtures.js` adapter: `{passed:true, usefulCases:38,
  optionRuns:22, transportDenialRuns:21, adapterLabelGuardRuns:1, scopeRuns:6,
  positiveRuns:6, unknownRuns:1, totalRuns:35, packageVerified:true,
  installedVersion:"0.4.0"}`; the identical check on a tarball packed from the
  baseline fails on `personal source column was not withheld` (exit 1). Tarball
  sha256: candidate (working tree) `575e67b7…8649`, baseline `115f8de8…6421`
  (`evidence/audit/sealed/out/tarballs.sha256`).

Not run here: full sabotage qualification, `npm run architecture`,
`tools/consumer-check.mjs`; none is claimed.

## 6. Mutation counts and open gates

| inventory | before | after |
| --- | --- | --- |
| `tools/sabotage-inventory/privacy.mjs` | 26 | 32 (2 re-anchored, 6 added) |
| whole inventory | 151 | 157 (see §7: the "70 → 76" first written here was a stale count) |
| executed this session | — | 8 selected, 8 KILLED, 0 SURVIVED |

Open and unaccepted: provider qualification (IC-2), publication/distribution, complete
outbound logging coverage, live-provider egress evidence, full IC-05 option-label
transport coverage, full architecture qualification, `tools/consumer-check.mjs`
installer conversion, B03 closure. Architecture PASS is not claimed.

## 7. Revision 009b — the independent review of 0.4.0 (c8f67d6) and its repair

The review of commit `c8f67d6` (data policy 1.5.0, core 0.4.0) returned FAIL with two
blocking findings, both reproduced here on the built c8f67d6 before any edit
(`evidence/probe-review-bypass.before.log`, cwd-relative `dist/src/index.js`):

- **PRIVACY-009-CASE-BYPASS.** `knownRun` admitted a camel compound whose humps were
  single Latin letters: `nG1`, `wU99`, `yN1`, `xStatus1`, `nG-1`, `aB2B` were CODE,
  SAFE_STRUCTURAL_METADATA on OPTION/LABEL/IDENTIFIER and vouched as
  SAFE_LOW_CARDINALITY_SEMANTICS values. Capitalisation was authorising through the
  split it caused.
- **PRIVACY-009-LENGTH-BYPASS.** `COMPACT_TOKEN` stopped at 64 characters and
  `classifyMetadataText` returned FREE_TEXT above 96 characters before the handle rule:
  `'qz'.repeat(48)+'7'` (97 chars) was FREE_TEXT on every channel and as a value;
  `'ab'.repeat(40)+'-12'` and `'z'.repeat(70)+'1'` were UNKNOWN as metadata and
  FREE_TEXT as values. The column carrying such a handle was not withheld.

Repair (data policy 1.5.1, core 0.4.1; `src/classifier/data-classifier.ts`, the two
anchor lines of `classifyMetadataText` verbatim):

- `compoundHump`: a camel hump beside a digit is a vocabulary word of at least two
  letters; a single letter is a symbol only when it is the whole run (`B2B`, `Q1`,
  `2024Q1`, `S0`, `A12`, `a12`, `4b`, `n1`, `y1` stay codes; `ClosedWon2`,
  `closedWon2`, `OptIn2`, `TierLevel1`, `Phone2Mobile` stay codes; `nG1`, `wU99`,
  `yN1`, `xStatus1`, `statusX1`, `nGo1`, `okWu2`, `jKowalski1`, `nG2024Q1` are handles).
- `COMPACT_TOKEN` has no length cap; the handle rule is read before the metadata length
  rule (long text without a handle is still FREE_TEXT; long text ending in a handle is
  POTENTIAL_PII). `classifyValue` already read the handle rule before its length rule
  and only needed the cap removed.
- After the repair (`evidence/probe-review-bypass.after.log`): all six camel vectors
  and all three long vectors are POTENTIAL_PII on OPTION, LABEL, IDENTIFIER and as
  values (`HANDLE`); every other line of the probe — the useful OPTION/LABEL/IDENTIFIER
  controls, the handles of §2 and the UNKNOWN controls — is byte-identical to the
  pre-repair run (`diff` of lines 11–45: empty).

Observation, not changed: a digit-free two-letter camel token (`yN`, no digit) is still
admitted by the identifier grammars and by `enumerationToken`'s camel split; it is
outside the compact rule the brief defines (a letter run *beside a digit*) and is
recorded here as an open shape for a later revision, not silently widened or narrowed.

Checks run on the final 009b code (observed this session):

- `npm run build`: exit 0. `node tools/run-tests.mjs`: 353 tests, 353 pass, 0 fail
  (`evidence/test-suite-009b.log`); `test/privacy-revision-009.test.ts` is now 26 tests
  (+3: the camel bypass, the length bypass, and both on the envelope — options dropped
  without substitute, no exemplar, Active withheld with the handle);
  `privacy-envelope.test` asserts data policy 1.5.1.
- `npm run contracts:check`: CONTRACTS-01 PASS (`evidence/contracts-check-009b.log`).
- Focused sabotage, DIAGNOSTIC (`evidence/sabotage-diagnostic-009b.{log,json}`):
  unmutated 353 pass; 11 selected, 11 KILLED, 0 SURVIVED —
  `handle-treated-as-code` (18 failures), `handle-letter-runs-unread` (1),
  `numeric-dominance-authorises` (6), `any-short-prefix-admitted` (5),
  `handle-left-unknown-in-value` (12), `handle-left-unknown-in-metadata` (15),
  `iso-code-plus-digits-admitted` (3), `mask-key-unscoped` (2), and the three new
  anchors `camel-hump-single-letter-admitted` (2), `compact-token-length-capped` (2),
  `metadata-length-read-before-handle` (2). Privacy inventory 32 → 35; whole inventory
  157 → 160 (benchmark 34, compiler 10, core 25, kernel 36, privacy 35, transport 20 —
  the tool's own listing; the "70 → 76" in §6 above and in the threat model was stale
  and is corrected). The remaining 149 mutations were not executed; nothing qualifies.
- Sealed positive-control patch: `git apply --check` against the final 009b candidate
  exits 0 (`evidence/positive-control-apply-check-009b.txt`); anchors at
  `src/classifier/data-classifier.ts` `classifyMetadataText` lines, verbatim.
- Local reproduction of the sealed checks with the builder stand-ins
  (`evidence/audit/sealed/run-sealed-local-009b.{sh,log}`, `out-009b/`; not the
  withheld fixtures): USEFUL-VOCABULARY on the candidate `{passed:true,
  usefulCases:38}`; the patch on a separate copy, rebuilt, exits 1 on `useful OPTION
  rejected`. PACKED-RULE-AND-SCOPE on the packed candidate in a materialized consumer
  with the 22-vector stand-in: `{passed:true, usefulCases:38, optionRuns:22,
  transportDenialRuns:21, adapterLabelGuardRuns:1, scopeRuns:6, positiveRuns:6,
  unknownRuns:1, totalRuns:35, packageVerified:true}`; with the 25-vector
  review stand-in (`private-standin-review`: + `nG1`/`wU99`, + the 97-character
  handle beside `Active` kept, + `yN1`/`xStatus1` beside `SKU-0042` kept):
  `{passed:true, optionRuns:25, transportDenialRuns:24, totalRuns:38,
  packageVerified:true}`. Controls: the baseline tarball fails on `personal source
  column was not withheld` (exit 1); the reviewed c8f67d6 tarball
  (`575e67b7…8649`) with the review stand-in fails on the same assertion at the
  `nG1`/`wU99` vector (exit 1) — the review's finding reproduced through the sealed
  mechanics, and closed by 009b. Tarball digests in `out-009b/tarballs.sha256`.

Not run here: full sabotage qualification, `npm run architecture`,
`tools/consumer-check.mjs`; none is claimed. Architecture PASS, B03 closure, provider
qualification and publication remain unaccepted.

## Resumen para el propietario (es)

Revisión 009 de R-IC-PRIVACY: un token con dígitos ya solo es código cuando cada
tramo de letras es conocido (letra suelta, prefijo cerrado como SKU/ISO/PO, o palabra
del vocabulario); en cualquier otro caso es un identificador personal y no sale ni
como opción, ni como etiqueta, ni como valor. Las referencias opacas quedan ligadas
al secreto, la agencia, el cliente, la revisión y el perfil. Los tres casos de
auditoría IC se reproducen en la base y quedan corregidos en el candidato; 350 pruebas
pasan; ocho sabotajes dirigidos mueren. Sin gasto, sin publicación; la calificación
completa y el proveedor real siguen pendientes.

Revisión 009b: la revisión independiente encontró dos escapes — un cambio de mayúscula
dentro del tramo (`nG1`, `wU99`) y la longitud (un identificador de 97 caracteres pasaba
como texto libre). Ambos quedan cerrados (política de datos 1.5.1, núcleo 0.4.1): 353
pruebas pasan, once sabotajes dirigidos mueren, la columna contaminada se retiene. Sigue
sin gasto ni publicación; la calificación completa no se reclama.
