/**
 * The command-layer outcomes of CMD058 ChangeCapability and CMD059 RestrictCapability (package B18; B06 D-OUT-1), composed by
 * commercial/outcomes into the closed catalogue of each route with the transport, admission and authentication fragments and the
 * corporate owner access.
 */
import { problemOutcome as outcome, type ProblemOutcome } from "../../api/outcome-kit.js";

const CAPABILITY_NOT_FOUND = outcome("COMMAND", "NOT_FOUND", null, "the capability is unknown");
const STALE = outcome("COMMAND", "STALE_VERSION", null, "expectedVersion is not the capability current version; the current safe version and state come back", { current: "ALWAYS" });

/** CMD058: the capability, then its version, then its acceptance (a version never promotes), then a profile that changes something. */
export const CHANGE_CAPABILITY_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  CAPABILITY_NOT_FOUND,
  STALE,
  outcome("COMMAND", "PRECONDITION_FAILED", "CAPABILITY_NOT_ACCEPTED", "the capability has no independent acceptance (DESIGN or IMPLEMENTED_UNACCEPTED): a version never promotes it to a sellable state", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "CAPABILITY_PROFILE_UNCHANGED", "the profile hash is one the capability or one of its versions already holds"),
  // S078: the qualification predicates, one reason each (a CLEAN mode capability is outside them)
  outcome("COMMAND", "PRECONDITION_FAILED", "QUALIFICATION_EVIDENCE_UNKNOWN", "a cited qualification evidence hash is not a recorded vendor qualification"),
  outcome("COMMAND", "PRECONDITION_FAILED", "QUALIFICATION_TOOL_MISMATCH", "a cited qualification was recorded for another tool"),
  outcome("COMMAND", "PRECONDITION_FAILED", "QUALIFICATION_PROFILE_MISMATCH", "a cited qualification covers another profile than the version's profile hash"),
  outcome("COMMAND", "PRECONDITION_FAILED", "QUALIFICATION_FAILED", "a cited qualification did not pass"),
  outcome("COMMAND", "PRECONDITION_FAILED", "QUALIFICATION_EXPORT_BACK_MISSING", "a cited qualification has no export-back evidence"),
]);

/** CMD059: the capability, then its version, then a state the Capability machine can restrict from. */
export const RESTRICT_CAPABILITY_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  CAPABILITY_NOT_FOUND,
  STALE,
  outcome("COMMAND", "PRECONDITION_FAILED", "CAPABILITY_NOT_RESTRICTABLE", "the capability is already SUSPENDED or still in DESIGN: there is nothing to restrict", { current: "ALWAYS" }),
]);
