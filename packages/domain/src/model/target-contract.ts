/**
 * Target contracts (package B17; registry commands CMD018 CreateTargetContract and CMD019 ConfirmTargetContract, manual 05):
 * the closed shape of the structured metadata an agency's observation produced for a project's target instance, the immutable
 * body a DRAFT target version stores, its KAURO_TARGET_BODY_V1 digest, and the reasons the two commands refuse with.
 *
 * Customer target metadata is DATA (S093): it is checked against this closed shape and hashed, never compiled or executed, and a
 * caller can never set a verified flag — the document admits no member beyond the ones listed here.
 */
import type { Sha256Hex, TargetObject, UtcInstant } from "@kauro/contracts";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import { isLabel } from "./fields.js";
import { isUtcInstant } from "../ports/clock.js";
import type { AgencyId, ArtifactRef, ProjectId, TargetContractId } from "./ids.js";
import type { ServiceMode, TargetContractRecord } from "./aggregates.js";

/** How old an observation may be when the agency confirms it (a policy the confirmation applies on the database's clock). */
export const TARGET_OBSERVATION_FRESHNESS_SECONDS = 86_400;

export const TARGET_ARTIFACT_KINDS = ["METADATA", "CONFIRMATION_EVIDENCE"] as const;
export type TargetArtifactKind = (typeof TARGET_ARTIFACT_KINDS)[number];

/** The reasons of CMD018 and CMD019 (appended to the closed FAILURE_REASONS of model/errors.ts). */
export const TARGET_FAILURE_REASONS = [
  // CMD018: the artifact's CRM, project or instance is not the project's (or its earlier contract's)
  "TARGET_SCOPE_MISMATCH",
  // CMD018: the metadata document is not the closed shape (an unknown member, a verified flag, an unknown field type...)
  "TARGET_METADATA_INVALID",
  // CMD018: this exact body already exists for the project: one contract per observed body
  "TARGET_CONTRACT_EXISTS",
  // CMD019: the contract is already confirmed
  "TARGET_ALREADY_CONFIRMED",
  // CMD018, CMD019: the observation is dated after the database's clock
  "OBSERVATION_IN_FUTURE",
  // CMD019: the observation is older than the freshness window
  "OBSERVATION_NOT_FRESH",
] as const;
export type TargetFailureReason = (typeof TARGET_FAILURE_REASONS)[number];

/** The stored metadata document: exactly these members. */
export interface TargetMetadataDocument {
  readonly importerVersion: string;
  readonly capabilityVersion: string;
  readonly observedAt: UtcInstant;
  readonly objects: ReadonlyArray<TargetObject>;
}

export interface TargetArtifactRecord {
  readonly artifactRef: ArtifactRef;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly kind: TargetArtifactKind;
  readonly mode: ServiceMode;
  readonly instanceId: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly contentHash: Sha256Hex;
  readonly createdAt: UtcInstant;
}

/** The immutable body of a target version and its bindings: what the body digest covers. */
export interface TargetBody {
  readonly mode: ServiceMode;
  readonly instanceId: string;
  readonly importerProfileId: string;
  readonly importerVersion: string;
  readonly objects: ReadonlyArray<TargetObject>;
  readonly observedAt: UtcInstant;
  readonly authorityEvidenceHash: Sha256Hex;
  readonly capabilityVersion: string;
}

/** KAURO_TARGET_BODY_V1: mode, instance, tool, metadata, observation and authority bind together in one digest. */
export function targetBodyDigest(body: TargetBody): Sha256Hex {
  return structuredDigest(DOMAINS.TARGET_BODY, 1, {
    mode: body.mode,
    instanceId: body.instanceId,
    importerProfileId: body.importerProfileId,
    importerVersion: body.importerVersion,
    objects: body.objects,
    observedAt: body.observedAt,
    authorityEvidenceHash: body.authorityEvidenceHash,
    capabilityVersion: body.capabilityVersion,
  });
}

export type TargetContractState = "DRAFT" | "CONFIRMED" | "SUPERSEDED";

/** A target contract with its lifecycle: DRAFT until confirmed (version 1), CONFIRMED by one membership on one evidence reference (version 2). */
export interface TargetContractLifecycle extends TargetContractRecord {
  readonly version: number;
  readonly state: TargetContractState;
  readonly confirmedByMembershipId?: string;
  readonly confirmationEvidenceRef?: ArtifactRef;
}

/** What CMD018 stores: the body's parts; the repository derives the bodyHash with targetBodyDigest, never a caller. */
export interface NewTargetContract {
  readonly contractId: TargetContractId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly body: TargetBody;
  /** The metadata artifact the contract was observed from (its digest is the schema bundle's and the authority evidence). */
  readonly artifactRef: ArtifactRef;
}

const FIELD_TYPES = new Set(["TEXT", "INTEGER", "DECIMAL", "DATE", "DATETIME", "BOOLEAN", "ENUM", "MULTI_ENUM", "REFERENCE"]);
const CLEAR = new Set(["UNSUPPORTED", "EXPLICIT_NULL_MARKER", "EXPLICIT_API_OPERATION"]);
const OPERATIONS = new Set(["CREATE", "UPDATE", "UPSERT"]);
const MAX_OBJECTS = 500;
const MAX_FIELDS = 2000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function closed(v: Record<string, unknown>, allowed: ReadonlyArray<string>, required: ReadonlyArray<string>): boolean {
  return Object.keys(v).every((k) => allowed.includes(k)) && required.every((k) => k in v);
}
const knownBool = (v: unknown): boolean => v === null || typeof v === "boolean";
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 200);

function validField(f: unknown): boolean {
  if (!isRecord(f)) return false;
  const all = ["apiName", "dataType", "createable", "updateable", "requiredOnCreate", "maxLength", "allowedValues", "clearMechanism", "unique", "referenceObject", "nillable"];
  if (!closed(f, all, ["apiName", "dataType", "createable", "updateable", "requiredOnCreate", "allowedValues", "clearMechanism", "unique", "nillable"])) return false;
  if (typeof f["apiName"] !== "string" || f["apiName"].length === 0 || f["apiName"].length > 200) return false;
  if (typeof f["dataType"] !== "string" || !FIELD_TYPES.has(f["dataType"])) return false;
  if (!knownBool(f["createable"]) || !knownBool(f["updateable"]) || !knownBool(f["requiredOnCreate"]) || !knownBool(f["nillable"])) return false;
  if ("maxLength" in f && !(Number.isInteger(f["maxLength"]) && (f["maxLength"] as number) >= 0)) return false;
  if (!strings(f["allowedValues"])) return false;
  if (typeof f["clearMechanism"] !== "string" || !CLEAR.has(f["clearMechanism"])) return false;
  if (typeof f["unique"] !== "boolean") return false;
  if ("referenceObject" in f && (typeof f["referenceObject"] !== "string" || f["referenceObject"].length === 0)) return false;
  return f["dataType"] !== "REFERENCE" || typeof f["referenceObject"] === "string";
}

function validObject(o: unknown): o is TargetObject {
  if (!isRecord(o) || !closed(o, ["apiName", "operations", "fields", "identifierFields", "relationships"], ["apiName", "operations", "fields", "identifierFields", "relationships"])) return false;
  if (typeof o["apiName"] !== "string" || o["apiName"].length === 0 || o["apiName"].length > 200) return false;
  if (!strings(o["operations"]) || !o["operations"].every((x) => OPERATIONS.has(x))) return false;
  if (!Array.isArray(o["fields"]) || o["fields"].length > MAX_FIELDS || !o["fields"].every(validField)) return false;
  if (!strings(o["identifierFields"]) || !strings(o["relationships"])) return false;
  const names = new Set((o["fields"] as ReadonlyArray<{ apiName: string }>).map((f) => f.apiName));
  return names.size === o["fields"].length && o["identifierFields"].every((n) => names.has(n));
}

/**
 * The closed check of a metadata document: exactly importerVersion, capabilityVersion, observedAt and objects; every object and field of
 * the registry's TargetObject and TargetField shape and nothing else (a `verified` member, or any other, is refused). Returns the typed
 * document, or null when the document is not it.
 */
export function parseTargetMetadata(document: unknown): TargetMetadataDocument | null {
  if (!isRecord(document) || !closed(document, ["importerVersion", "capabilityVersion", "observedAt", "objects"], ["importerVersion", "capabilityVersion", "observedAt", "objects"])) return null;
  const { importerVersion, capabilityVersion, observedAt, objects } = document;
  if (typeof importerVersion !== "string" || !isLabel(importerVersion) || typeof capabilityVersion !== "string" || !isLabel(capabilityVersion)) return null;
  if (!isUtcInstant(observedAt)) return null;
  if (!Array.isArray(objects) || objects.length === 0 || objects.length > MAX_OBJECTS || !objects.every(validObject)) return null;
  const names = new Set(objects.map((o) => (o as TargetObject).apiName));
  if (names.size !== objects.length) return null;
  return { importerVersion, capabilityVersion, observedAt, objects: objects as TargetObject[] };
}
