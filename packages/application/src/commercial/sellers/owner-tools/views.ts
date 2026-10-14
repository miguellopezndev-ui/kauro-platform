/**
 * The views of the owner tools (lane L-OWNER; plan companion §P): what each producer answers. No view carries a destination digest, bank
 * or tax identifier, contact detail or proof reference (COMMERCIAL_FORBIDDEN_MEMBERS and the B06 list refuse them when the schemas are
 * built): a payout destination answers its masked label, its version and its state, never its details.
 */
import type { UtcInstant } from "@kauro/contracts";
import { RESPONSE_FIELD_VOCABULARY, type JsonSchema, type ViewDefinition } from "../../../api/response-schemas.js";
import { VIEW_MEMBER_KIT } from "../../../api/view-kit.js";

const { ID, VERSION, UTC, COUNT, LABEL } = RESPONSE_FIELD_VOCABULARY;
const { platform } = VIEW_MEMBER_KIT;
const BOOLEAN = Object.freeze({ type: "boolean" });
const enumOf = (values: ReadonlyArray<string>): JsonSchema => ({ type: "string", enum: [...values] });

export const SELLER_RECORD_KINDS = [
  "LEGAL_REVIEW",
  "ASSESSMENT",
  "CONFIDENTIALITY_ACCEPTANCE",
  "TAX_DOCUMENT",
  "SERVICE_ASSIGNMENT",
  "ASSISTANCE_AGREEMENT",
  "TERMINATION_TERMS",
  "TERMINATION_MANIFEST",
  "CLAIM_EVIDENCE",
] as const;
export type SellerRecordKind = (typeof SELLER_RECORD_KINDS)[number];

export interface SellerCandidateView {
  readonly sellerId: string;
  readonly version: number;
  readonly state: "CANDIDATE";
  readonly displayLabel: string;
  readonly createdAt: UtcInstant;
}

/** An append-only onboarding, assignment, termination or evidence record: its id, kind and seller (a record has no later version). */
export interface SellerRecordView {
  readonly recordId: string;
  readonly kind: SellerRecordKind;
  readonly sellerId: string;
  readonly version: 1;
  readonly recordedAt: UtcInstant;
}

export interface SellerAgreementRecordView {
  readonly agreementId: string;
  readonly sellerId: string;
  readonly agreementVersion: string;
  readonly version: number;
  readonly signed: boolean;
  readonly signedAt?: UtcInstant;
  readonly createdAt: UtcInstant;
}

export interface PayoutDestinationStatusView {
  readonly destinationId: string;
  readonly sellerId: string;
  readonly destinationVersion: number;
  readonly version: number;
  readonly state: "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "SUPERSEDED";
  readonly maskedLabel: string;
  readonly currency: "USD" | "COP";
  readonly changedAt: UtcInstant;
  /** The earliest instant an owner may verify it: 172 800 s after the change (Q10-5). */
  readonly verifiableFrom: UtcInstant;
  readonly verifiedAt?: UtcInstant;
  readonly rejectedAt?: UtcInstant;
}

export interface AttributionAllocationRecordView {
  readonly allocationId: string;
  readonly prospectId: string;
  readonly agencyId: string;
  readonly version: number;
  readonly shareCount: number;
  readonly frozen: false;
  readonly preparedAt: UtcInstant;
}

export const B12_PRODUCER_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
  {
    name: "SellerCandidateView",
    description: "RegisterSellerCandidate: the seller born CANDIDATE for one corporate identity. It acts only once CMD049 activates it.",
    contract: null,
    withheld: {},
    members: {
      sellerId: platform(true, ID, "The seller."),
      version: platform(true, VERSION, "Seller version."),
      state: platform(true, enumOf(["CANDIDATE"]), "A registered seller is a CANDIDATE."),
      displayLabel: platform(true, LABEL, "The seller's display label."),
      createdAt: platform(true, UTC, "The instant the database recorded the seller."),
    },
  },
  {
    name: "SellerRecordView",
    description: "The owner tools: one append-only record of a seller's onboarding, assignment, termination or claim evidence. Its content stays in the restricted record.",
    contract: null,
    withheld: {},
    members: {
      recordId: platform(true, ID, "The record."),
      kind: platform(true, enumOf(SELLER_RECORD_KINDS), "What the record is."),
      sellerId: platform(true, ID, "The seller the record belongs to."),
      version: platform(true, VERSION, "Always 1: a record is never changed."),
      recordedAt: platform(true, UTC, "The instant the database recorded it."),
    },
  },
  {
    name: "SellerAgreementRecordView",
    description: "PrepareSellerAgreement and RecordAgreementSignature: the seller agreement, prepared with its exact operative text and signed once.",
    contract: null,
    withheld: {},
    members: {
      agreementId: platform(true, ID, "The agreement."),
      sellerId: platform(true, ID, "Its seller."),
      agreementVersion: platform(true, LABEL, "The agreement version claims name."),
      version: platform(true, VERSION, "Agreement row version."),
      signed: platform(true, BOOLEAN, "The agreement carries its signature."),
      signedAt: platform(false, UTC, "The signature instant."),
      createdAt: platform(true, UTC, "The instant the agreement was prepared."),
    },
  },
  {
    name: "PayoutDestinationStatusView",
    description: "ChangePayoutDestination and VerifyPayoutDestination: one version of a seller's payout destination, its masked label and state. The account details and their digest are never answered.",
    contract: null,
    withheld: {},
    members: {
      destinationId: platform(true, ID, "This destination version."),
      sellerId: platform(true, ID, "Its seller."),
      destinationVersion: platform(true, COUNT, "The seller's destination version number."),
      version: platform(true, VERSION, "Destination row version."),
      state: platform(true, enumOf(["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "SUPERSEDED"]), "Only a VERIFIED destination is ever paid."),
      maskedLabel: platform(true, LABEL, "The masked label of the account."),
      currency: platform(true, enumOf(["USD", "COP"]), "The payout currency."),
      changedAt: platform(true, UTC, "The instant the database recorded the change."),
      verifiableFrom: platform(true, UTC, "The earliest instant an owner may verify the change (172800 s after it)."),
      verifiedAt: platform(false, UTC, "The verification instant."),
      rejectedAt: platform(false, UTC, "The rejection instant."),
    },
  },
  {
    name: "AttributionAllocationRecordView",
    description: "PrepareAttributionAllocation: the owner's prepared ruling on a prospect's claims and its share count. CMD047 freezes it.",
    contract: null,
    withheld: {},
    members: {
      allocationId: platform(true, ID, "The allocation."),
      prospectId: platform(true, ID, "The prospect ruled on."),
      agencyId: platform(true, ID, "The agency the prospect is."),
      version: platform(true, VERSION, "Allocation version."),
      shareCount: platform(true, COUNT, "How many beneficiary shares it names."),
      frozen: platform(true, BOOLEAN, "Always false: CMD047 freezes it."),
      preparedAt: platform(true, UTC, "The instant the database recorded it."),
    },
  },
]);

/** The success reply of each owner tool (spread into COMMERCIAL_COMMAND_RESPONSES). */
export const B12_PRODUCER_COMMAND_RESPONSES = Object.freeze({
  RegisterSellerCandidate: { status: 201, view: "SellerCandidateView", accepted: false },
  RecordSellerLegalReview: { status: 201, view: "SellerRecordView", accepted: false },
  PrepareSellerAgreement: { status: 201, view: "SellerAgreementRecordView", accepted: false },
  RecordAgreementSignature: { status: 200, view: "SellerAgreementRecordView", accepted: false },
  RecordSellerAssessment: { status: 201, view: "SellerRecordView", accepted: false },
  RecordConfidentialityAcceptance: { status: 201, view: "SellerRecordView", accepted: false },
  RecordSellerTaxDocument: { status: 201, view: "SellerRecordView", accepted: false },
  ChangePayoutDestination: { status: 201, view: "PayoutDestinationStatusView", accepted: false },
  VerifyPayoutDestination: { status: 200, view: "PayoutDestinationStatusView", accepted: false },
  PrepareServiceAssignment: { status: 201, view: "SellerRecordView", accepted: false },
  RecordAssistanceAgreement: { status: 201, view: "SellerRecordView", accepted: false },
  PrepareTerminationTerms: { status: 201, view: "SellerRecordView", accepted: false },
  PrepareTerminationManifest: { status: 201, view: "SellerRecordView", accepted: false },
  RecordClaimEvidence: { status: 201, view: "SellerRecordView", accepted: false },
  PrepareAttributionAllocation: { status: 201, view: "AttributionAllocationRecordView", accepted: false },
} as const);
