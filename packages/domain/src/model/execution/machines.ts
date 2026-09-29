/**
 * Platform state machines of processing authority (package B08; docs/design/B08-audit-approval-jobs.md §8.2). The registry lists
 * the Job machine (used exactly as vendored; model/state-machines resolves it from STATE_MACHINES); 07 "Job and attempt states"
 * and "Package and import states" name the states of a processing attempt and of a package version without a machine, so they
 * are declared here in the registry's own shape and under the registry's unlisted-transition policy — as B06 declared EndClient
 * and Project and B09 its commerce machines — and migrations 0019 (ProcessingAttempt) and 0020 (PackageVersion) seed exactly the
 * same initial states and edges into kauro.state_machines / kauro.state_transitions (the persistence test proves equality).
 *
 * Every event name is unique per (machine, from state), so `transition(machine, from, event)` is a function. The edges B08 does
 * not perform name their later owner (B13 replacement, B16 incident and deletion) in the matrix owner table (tools/matrix.mjs).
 */
import type { StateMachine } from "@kauro/contracts";

const POLICY = "REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED";

export type ExecutionPlatformMachineName = "ProcessingAttempt" | "PackageVersion";

export const EXECUTION_PLATFORM_MACHINES: ReadonlyArray<StateMachine> = Object.freeze([
  {
    contract: "ProcessingAttempt",
    initial: "CREATED",
    terminal: ["COMMITTED", "ABANDONED", "FAILED"],
    transitions: [
      { from: "CREATED", event: "fence_claimed", to: "CLAIMED", guard: "The attempt owns its job's JOB_ATTEMPT lease: owner the attempt, fence the attempt's, subject the job's input binding, cost authority the authorization (D8-ATT-1).", effect: "The attempt may record its launch intent." },
      { from: "CLAIMED", event: "launch_intent", to: "STARTING", guard: "Identity and staging prefix recorded, the job holds the ACTIVE slot (KA082), the lease is the attempt's and nothing cancelled the job (KA080, KA081).", effect: "The worker host may create the provider job by identity, outside any transaction (D8-HOST-1)." },
      { from: "STARTING", event: "provider_start_observed", to: "RUNNING", guard: "The attempt's identity is observed running under the attempt's fence.", effect: "The job leaves ADMITTED for RUNNING." },
      { from: "RUNNING", event: "manifest_submitted", to: "STAGED", guard: "The control plane read the manifest from the attempt's own prefix and recorded it under the fence (KA080; D8-STG-3).", effect: "The package version is born STAGED; the job is VERIFYING." },
      { from: "STAGED", event: "verification_started", to: "VERIFYING", guard: "The attempt still owns the lease at its fence (KA080).", effect: "Read-backs and the verifier run against the platform's authority." },
      { from: "VERIFYING", event: "publication_committed", to: "COMMITTED", guard: "The publication transaction commits with the job READY (D8-PUB-2).", effect: "The attempt's package is the job's published package." },
      { from: "CLAIMED", event: "attempt_abandoned", to: "ABANDONED", guard: "Cancellation, a lapsed lease or a takeover.", effect: "Nothing was launched; the lease may be taken over at fence + 1." },
      { from: "STARTING", event: "attempt_abandoned", to: "ABANDONED", guard: "The identity is observed terminal or proved absent after the host's creation horizon.", effect: "Its objects stay private for the janitor." },
      { from: "RUNNING", event: "attempt_abandoned", to: "ABANDONED", guard: "Same.", effect: "Same." },
      { from: "STAGED", event: "attempt_abandoned", to: "ABANDONED", guard: "Cancellation before verification.", effect: "The staged package is REVOKED with its evidence kept." },
      { from: "VERIFYING", event: "attempt_abandoned", to: "ABANDONED", guard: "Cancellation or authority lost before publication.", effect: "Same." },
      { from: "STARTING", event: "attempt_failed", to: "FAILED", guard: "The host REFUSED the launch.", effect: "The job may fail as unrecoverable_start_error." },
      { from: "RUNNING", event: "attempt_failed", to: "FAILED", guard: "A classified terminal cause (S035).", effect: "The job fails with that exact cause." },
      { from: "STAGED", event: "attempt_failed", to: "FAILED", guard: "The submitted manifest is invalid.", effect: "Same." },
      { from: "VERIFYING", event: "attempt_failed", to: "FAILED", guard: "A read-back differs or the verifier answers INVALID (S061).", effect: "The job fails by verification_failure; the package is REVOKED with its evidence kept." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "PackageVersion",
    initial: "STAGED",
    terminal: ["DELETED"],
    transitions: [
      { from: "STAGED", event: "verification_valid", to: "VERIFIED_PRIVATE", guard: "A VALID verification of this package and every staging read-back equal (KA084).", effect: "Delivery copies are made, still private (D8-PUB-1)." },
      { from: "VERIFIED_PRIVATE", event: "package_published", to: "AVAILABLE", guard: "The publication guard D8-PUB-2 (KA080, KA081, KA084), with the job READY, the attempt COMMITTED and the authorization DELIVERED in the same transaction.", effect: "The only edge that makes a package downloadable." },
      { from: "STAGED", event: "publication_denied", to: "REVOKED", guard: "Verification INVALID, cancellation or authority lost; evidence kept.", effect: "Never AVAILABLE; kept private for reconciliation." },
      { from: "VERIFIED_PRIVATE", event: "publication_denied", to: "REVOKED", guard: "Same.", effect: "Same." },
      { from: "AVAILABLE", event: "package_replaced", to: "RETIRED", guard: "A newer AVAILABLE version of the job's scope (B13).", effect: "The newer version is delivered instead." },
      { from: "AVAILABLE", event: "authority_revoked", to: "REVOKED", guard: "Incident or dispute policy restricts further service (B16; 07 \"Reversal after delivery\").", effect: "Downloads stop; evidence kept." },
      { from: "AVAILABLE", event: "package_deleted", to: "DELETED", guard: "Effective retention deadline reached or deletion (B16).", effect: "Artifacts deleted; a tombstone remains." },
      { from: "RETIRED", event: "package_deleted", to: "DELETED", guard: "Same.", effect: "Same." },
      { from: "REVOKED", event: "package_deleted", to: "DELETED", guard: "Private evidence past its retention (STAGING_JANITOR; B16).", effect: "Same." },
    ],
    unlistedTransition: POLICY,
  },
]);
