# Destination permission boundary — R-MC-TYPE, R-MC-ENUM, R-MC-PIPELINE (MC-04), release 2.0.3

Base `ed09809ba3749ea84f0eecd85bf1b09f29b31d82` (2.0.2, unreleased). Producer repair recovered from the retained
candidate `dcbdb64eec57c04b7a43c57705d853ca76468374` (tree `08cf2362…`, work order WO-MC-TARGET-20260915-01), completed
per WO-MC-TARGET-20260925-01 (contract-bound verification, label rule, date/instant rule).

## Defects

| id | on ed09809 | now |
|---|---|---|
| R-MC-TYPE | a type token outside the implemented families (`time`, `future_scalar`, any unknown token) authorised any TEXT write; the package verified | plan refused before any record (`DESTINATION_FIELD_UNKNOWN`), every mapped field |
| R-MC-ENUM | an enumeration with no captured option (restricted, or restriction UNKNOWN) took every source value; source `allowedValues` acted as the eligibility set | EMPTY / UNKNOWN vocabulary: plan refused; KNOWN: an active option's **value** only, per record (`DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN`); OPEN (non-restricted, no options): delivered |
| label | a value equal to an option's display label was delivered as the label | label admits nothing; map the source value onto the option value explicitly |
| date/instant | DATE into any DATETIME field | kept only for HUBSPOT (evidence: import qualification corpus Q1-create, `closedate`); refused for SALESFORCE |
| verifier | `verifyPackage` had no destination evidence; unsafe packages verified | additive `VerifyOptions.targetContract` / `requireTargetContract`: body re-hashed, bound to the package digest and mode, plan re-decided (`instancePlan`), every emitted cell checked (`instanceFinding`) — `target.*` checks; default call unchanged (structural only, establishes nothing about eligibility) |
| R-MC-PIPELINE (found on 2cb54e2) | the 2.0.3 vocabulary rule read HubSpot `dealstage` and `pipeline` as properties: enumerations with no option (HubSpot keeps them in its pipelines, `externalOptions`) and no stated restriction, so UNKNOWN; every HubSpot deal plan was refused (`DESTINATION_FIELD_UNKNOWN`), the adapter requiring both to create a deal. Found by HSP-TARGET-01 (import) against portal 51872453, which stopped before its first write | `pipelineVocabulary`: for a HUBSPOT DEAL plan the contract's pipelines are the vocabulary — a pipeline's internal name, a stage's internal name, value only; a stage is eligible only inside the pipeline the record names; no captured pipeline leaves both unknown and the plan refused. Plan and `instanceFinding`, so run and verifier alike. Corpus Q1 maps its labels onto the internal names (`valueMap`) |

Shared rule: `src/run/validate-destination.ts` (`familyAdmits`, `instanceVocabulary`, `vocabularyAdmits`, `instancePlan`,
`instanceFinding`); verifier side `src/verify/target-evidence.ts`. CLI: `verify --target-contract <file>
[--require-target-contract]`; `run` verifies its staged package against the contract it was given.

## Tests

| case | test file :: title | on ed09809 | now |
|---|---|---|---|
| MC-04 matrix (25 vectors, 48 mode cases) | test/target-permission.test.ts :: MC-04 destination permission matrix: 25 vectors, 48 mode cases | 48 fail (behavioural, 0 harness errors) | pass |
| CLI | test/target-permission.test.ts :: the verify command takes the trusted contract | n/a | pass |
| rule level | test/target-boundary.test.ts (recovered, label case inverted, date/instant case added) | n/a | pass |
| inverted | test/mc3-reopen-validation.test.ts :: a type token this engine cannot place authorises no write…; an option label admits nothing… | asserted the defect | pass |
| R-MC-PIPELINE (7 cases) | test/target-pipeline-vocabulary.test.ts :: R-MC-PIPELINE: HubSpot deal pipeline and stage take their vocabulary from the captured pipelines | n/a (2cb54e2: 5 of 7 fail, the 2 fail-closed controls pass) | pass |

## Evidence invalidated

Every producer closure includes `src/`, so the campaign sealed for 2.0.2 does not cover 2.0.3; see
`docs/release/EQUIVALENCE_2.0.3.md`.
