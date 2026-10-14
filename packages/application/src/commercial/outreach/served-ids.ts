/** The B12 command ids the api serves (kit K2): CMD061..CMD064 then the operations plan companion §R names without a catalogue id. */
export const B12_SERVED_COMMAND_IDS = [
  "CMD061",
  "CMD062",
  "CMD063",
  "CMD064",
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
