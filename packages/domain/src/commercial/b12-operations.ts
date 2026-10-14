/**
 * The journaled operations of package B12 that carry no registry command id (K2). The registry names CMD061..CMD064 only; the plan
 * (docs/design/B12-outreach-plan.md §R and companion §P) adds stateful routes with no catalogue id. Each is journaled under its own name:
 * command_journal.operation (0006) admits `^CMD[0-9]{3}$` OR exactly one of these names (0088 tail: an explicit list, never a pattern), so a
 * misspelt operation is refused by the database. The list is hand-maintained beside the generated CommandId (not a registry edit); the
 * migration tests compare it with the constraint, and a new B12 operation is added here and in a migration together.
 */
/** Outreach operations (plan companion §R): lanes L-DRAFT, L-AUTH, L-SEND, L-ACT, L-SOURCE. */
export const B12_OUTREACH_OPERATIONS = [
  "PutOutreachContent",
  "PublishSalesResource",
  "RegisterSenderIdentity",
  "VerifySenderIdentity",
  "RecordSenderRevocation",
  "PrepareOutreachReview",
  "RecordOutreachDiagnosis",
  "RevokeOutreachAuthorization",
  "WithdrawOutreachChannelPolicy",
  "RecordProspectSource",
  "RecordProspectContact",
] as const;

/** Owner and seller producers (plan companion §P): lane L-OWNER. */
export const B12_PRODUCER_OPERATIONS = [
  "RegisterSellerCandidate",
  "RecordSellerLegalReview",
  "PrepareSellerAgreement",
  "RecordAgreementSignature",
  "RecordSellerAssessment",
  "RecordConfidentialityAcceptance",
  "RecordSellerTaxDocument",
  "ChangePayoutDestination",
  "VerifyPayoutDestination",
  "PrepareServiceAssignment",
  "RecordAssistanceAgreement",
  "PrepareTerminationTerms",
  "PrepareTerminationManifest",
  // the producers of the attribution rows CMD046 and CMD047 consume (lane L-OWNER; 0087 widens the journal list by these two)
  "RecordClaimEvidence",
  "PrepareAttributionAllocation",
] as const;

export const B12_OPERATIONS = [...B12_OUTREACH_OPERATIONS, ...B12_PRODUCER_OPERATIONS] as const;
export type B12OperationId = (typeof B12_OPERATIONS)[number];

export function isB12Operation(value: string): value is B12OperationId {
  return (B12_OPERATIONS as ReadonlyArray<string>).includes(value);
}
