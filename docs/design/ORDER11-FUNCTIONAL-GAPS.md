# Order 11: functional gaps found while designing

Order 11 is design only. When a design that the owner asked for, or that the evidence supports, needs behaviour the code does not have,
or the code contradicts a decision in force, it is recorded here with its exact place and how to reproduce it. Nothing here was changed
in Order 11; later orders group the fixes with the other changes to the same components.

Each entry: what the design or the decision says; what the code does, with file and line; how to reproduce it; what a fix would touch;
how sure the finding is (read in the code, or reproduced).

## F-01. CLEAN asks for a destination contract it should not need

**Decision in force.** The owner, 2026-10-20: "Clean your data" is an independent service without a destination CRM; no artificial
target-setup step. A3 §3.3 and ToS §3.2 present CLEAN the same way.

**What the code does (read, not run).**
- Creating a CLEAN project needs no target instance: `packages/domain/src/model/project.ts:73-79` requires `targetInstanceRef` only when
  `mode !== "CLEAN"`. This part matches the decision.
- Starting the free check needs a confirmed, current target contract, with no mode exception. StartAudit (CMD020) takes
  `targetContractId` in its body (`packages/contracts/registry/commands.json:593-603`; `packages/application/src/audit/handlers/start-audit.ts:47`)
  and refuses `TARGET_STALE` unless that contract is confirmed, current and of the revision's project (`start-audit.ts:65-74`). The audit
  then records `target.bodyHash` as its `targetContractHash` (`start-audit.ts:84`).
- The plan compiler gives a CLEAN_ONLY draft a canonical hash that no stored contract carries:
  `packages/application/src/adapters/cores/intelligence/plan-compiler.ts:27-28` (`CLEAN_ONLY_TARGET_HASH`).
- CreatePlan, ApprovePlan and CreateQuote each lock the current contract by the hash the audit or plan carries and refuse `TARGET_STALE` when
  none is found: `packages/application/src/audit/handlers/create-plan.ts:86-87`, `packages/application/src/commands/handlers/approve-plan.ts:98`,
  `packages/application/src/commercial/quotes/create-quote.ts:186, 213`.

**Reproduction (for the order that fixes it).**
1. Create a CLEAN project without `targetInstanceRef` (accepted).
2. Upload and seal a revision.
3. Call StartAudit without a confirmed target contract of the project: expected per decision, the check starts; per code, 422
   `TARGET_STALE` (or a request-shape refusal, because `targetContractId` is a required field).
4. Whether a CLEAN project can reach a plan, an approval and a quote at all depends on which hash its audit and plan carry
   (`start-audit.ts:84` against `plan-compiler.ts:27-28`); the API tests create CLEAN-mode target contracts to get through
   (`apps/api/test/cmd018-cmd019-target-contract.test.ts:59`, per research/kauro-baseline.md §3). Not run in Order 11: to be confirmed by a test.

**What a fix would touch.** CMD020's fields (target optional for CLEAN), StartAudit, CreatePlan, ApprovePlan, CreateQuote and their tests,
and the plan hash rule for CLEAN; no change to the cores' algorithms is implied.

**Design in Order 11.** The CLEAN journey has no target-setup step: choose "Clean your data", upload, check, decide the plan, see the price,
buy, receive the cleaned files and their evidence. Optional output preferences are offered only where they add value (see the page
analysis).

**Certainty.** Read in the code, with line references; not reproduced by running it.
