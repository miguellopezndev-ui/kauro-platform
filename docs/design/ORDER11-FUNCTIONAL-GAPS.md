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

## F-02. Approval and quote as one moment (proposal)

**Design.** Today an approver approves the plan (CMD025), and then an owner or the billing role asks for the quote (CreateQuote) before
paying. The owner asked for a better journey if this sequence adds friction. Proposed: approving a plan issues its quote at once, on the
approved scope, so the person who pays finds the quote waiting; the quote stays formal (14 days, policy `quoteDays`) and nothing is
charged until it is paid. **What a fix would touch.** ApprovePlan's effect (issue the quote in the same unit of work, or enqueue it),
CreateQuote's actor rule, the quote's audit trail, tests. **Status.** Proposal for the owner; not implemented.

## F-03. Self-serve free check from the public site (changes A3 §3.2)

**Decision.** The owner, 2026-10-20: "Check a file free" opens a page on the free check; from there the visitor creates an account or
signs in and continues; a short progressive eligibility step comes before real files; the contact form stays as an alternative. A3 §3.2
sends the call to action to the fit form first. **What it needs.** An amendment to A3 §3.2; the eligibility step's fields recorded where
the onboarding records the buyer type (A3 §3.7) and the agreements (CMD002); the free check's budget and capacity states shown before
upload (A3 §3.2 pause rule; open question Q-4 on 90% versus exhausted). **Status.** Design and simulation only.

## F-04. A read of the health check's findings (P-07)

**Design.** The results page shows each finding with its count, its population, examples, the consequence and the fix. **Code.** The API
has no read of the check's findings or of the plan's body (research/kauro-baseline.md §5.1). **Needs.** A findings read model and its
contract, scoped to the tenant, with examples drawn without exposing more data than the plan needs.

## F-05. A read of the estimate after the check

**Design.** After the check, an estimate from the service, the measured units and the current price policy. **Code.** The units are read
inside CreateQuote (`billableUnitsOf`) and the price by `baseCentsOf` (`packages/application/src/commercial/quotes/create-quote.ts:329-330`);
no read exposes them before a quote. **Needs.** A read that returns the measured units and the policy price for the project's service,
marked as an estimate, never a reservation.

## F-06. A read of the project's activity (D-UI13-1)

**Design.** Activity lists typed events (files sealed, check ready, plan revision proposed or approved, quote issued, transfer received,
package verified, downloaded, stage result returned, deletion stage done), each with actor, time and reference. **Code.** No activity
read exists. **Needs.** A tenant-scoped event read built from the existing audit records.

## F-07. Sign-in, sign-up and recovery as the owner decided

**Decision.** Google or email and a password of at least 12 characters checked against breached passwords; verified email; Kauro's own
TOTP always, also after Google; recovery codes; risk-differentiated recovery (an admin may start a member's recovery, never disable the
factor; owners and accounts without another admin recover through Kauro with independent checks and a person's approval; no recovery
without reliable evidence). **Code.** The identity provider is undecided (research/kauro-baseline.md Q-8: Google Identity Platform in code,
Cognito in A9); no sign-up, enrolment, recovery or session-list screens exist (UI50 is blocked). **Needs.** The provider decision, the
flows and their abuse tests (impersonation, administrative abuse, loss of the owner, fraudulent recovery).

## F-08. The registration needs a page the site does not have

**Rule in force.** Data Processing Policy §8.1 and the internal data manual §5.3 (A-01): account registration and the contact form show
an unticked authorisation checkbox with links to the Policy and the Privacy notice, and keep user, document version, date and time as
proof; commercial messages are a separate, optional, unticked choice (A-14). **Gap.** The registry publishes the Service terms (UI45),
the Privacy notice (UI46) and the Data processing terms (UI47), but no page for the Data Processing Policy
(`docs/legal/DATA_PROCESSING_POLICY.md`). **Design in Order 11.** Create account (P-05) shows the required checkbox and the optional one,
linking the Policy at a proposed `/legal/data-processing-policy`. **Needs.** A registry addition for the Policy's page (legal text
published by its own procedure), and the consent record at registration (F-07). The approved contact form should be checked against the
same rule when the public site is next changed.

## F-09. Output preferences for "Clean your data" (proposal)

**Design.** The owner asked whether optional output choices add value. Proposed in Fields, for "Clean your data" only and never required:
the file type (as uploaded, or all CSV in UTF-8) and phone numbers (as in the file, or international format where the country is known).
**Code.** The plan's body has no place for such preferences. **Needs.** Fields in the plan's contract and the core's CLEAN output, decided
with the cores' owner; no change to their algorithms is implied by the design. **Status.** Proposal.
