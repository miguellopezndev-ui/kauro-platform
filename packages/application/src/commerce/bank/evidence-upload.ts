/**
 * The owner's evidence upload (B12 owner screens lane 1; docs/design/B12-owner-screens.md D-B12S-2, GAP-API-8; failure-matrix row U). The
 * corporate owner stores a bank artifact he holds (account details, a credit, a statement) in the restricted store for one account and gets
 * its reference and hash, which a command then cites. The upload grants nothing: every citing command re-reads the bytes by hash, classifies
 * them, binds their account and judges the owner's step-up at its own COMMIT.
 *
 *   1. the body, before anything is read: the decoded bytes (canonical base64, 1..BANK_EVIDENCE_MAX_BYTES: ARTIFACT_SIZE_INVALID), their
 *      SHA-256 equal to the declared hash (HASH_MISMATCH) and the bytes of the declared media type (ARTIFACT_TYPE_MISMATCH);
 *   2. an OPERATOR unit of work authorizes KAURO_OWNER (a denial is recorded; the store is never called);
 *   3. the store's `put` under the provider-call bound, outside every transaction (the evidence port's rule), then the stored record read back
 *      under the same bound: the store must hold these bytes for this account (the same bytes stored earlier for another account are
 *      UNKNOWN_EVIDENCE, never answered as this account's); a store that does not answer within the bound is EVIDENCE_UNAVAILABLE, retryable;
 *   4. a second OPERATOR unit re-authorizes the owner and judges the caller's credential as fenced in it (rule 16) before the reply.
 *
 * The store is content-addressed, so the route is not journaled: a lost answer is retried with the same bytes and answers the same reference.
 */
import { createHash } from "node:crypto";
import type { BankAccountRef, CommerceUnitOfWork, OperatorContext, UserId } from "@kauro/domain";
import { DomainFailure, PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { judgedUnderHold } from "../../api/authority.js";
import { problemOf } from "../../api/problems.js";
import { BANK_EVIDENCE_MAX_BYTES, BANK_EVIDENCE_MEDIA_TYPES } from "../../api/response-schemas.js";
import { CommerceAccessDenied, recordCommerceDenial, type CommerceRequestRuntime } from "../request/runtime.js";
import type { InboundReadAnswer, InboundReadRequest } from "./inbound.js";
import type { BankRouteCollaborators } from "./ports.js";
import { evidenceUnavailable } from "./route-config.js";

export type BankEvidenceMediaType = (typeof BANK_EVIDENCE_MEDIA_TYPES)[number];

export interface UploadBankEvidenceBody {
  readonly mediaType: BankEvidenceMediaType;
  readonly contentBase64: string;
  readonly evidenceHash: string;
}

export interface BankEvidenceArtifactView {
  readonly artifact: {
    readonly artifactRef: string;
    readonly evidenceHash: string;
    readonly sizeBytes: number;
    readonly mediaType: BankEvidenceMediaType;
    readonly accountRef: string;
  };
}

export interface UploadBankEvidenceRequest extends InboundReadRequest {
  readonly accountRef: string;
  readonly body: UploadBankEvidenceBody;
}

const UPLOAD = "UPLOAD_BANK_EVIDENCE";
const sizeInvalid = (): DomainFailure => new DomainFailure("INVALID_REQUEST", "the artifact is empty or larger than the upload bound", { reason: "ARTIFACT_SIZE_INVALID" });
const typeMismatch = (): DomainFailure => new DomainFailure("INTEGRITY_FAILURE", "the bytes are not of the declared media type", { reason: "ARTIFACT_TYPE_MISMATCH" });
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Whether the bytes look like the declared type: a PDF starts `%PDF-`, JSON is UTF-8 that parses to an object, CSV is UTF-8 without NUL. */
export function bytesAreOfType(bytes: Uint8Array, mediaType: BankEvidenceMediaType): boolean {
  if (mediaType === "application/pdf") return PDF_MAGIC.every((b, i) => bytes[i] === b);
  const text = utf8(bytes);
  if (text === null) return false;
  if (mediaType === "text/csv") return !text.includes("\u0000") && !PDF_MAGIC.every((b, i) => bytes[i] === b);
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** The decoded bytes of a canonical base64 text (the schema admits only the alphabet); anything that does not round-trip is a size refusal. */
function decoded(text: string): Uint8Array {
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) throw new DomainFailure("INVALID_REQUEST", "the content is not canonical base64", { reason: "SCHEMA_VIOLATION", fields: [{ field: "contentBase64", code: "FORMAT" }] });
  if (bytes.byteLength < 1 || bytes.byteLength > BANK_EVIDENCE_MAX_BYTES) throw sizeInvalid();
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function bounded<T>(co: Pick<BankRouteCollaborators, "timer">, work: () => Promise<T>): Promise<T> {
  const bound = co.timer.start(PROVIDER_CALL_TIMEOUT_MS);
  let answered: { readonly value: T } | null;
  try {
    answered = await Promise.race([work().then((value) => ({ value })), bound.elapsed.then(() => null)]);
  } finally {
    bound.cancel();
  }
  if (answered === null) throw evidenceUnavailable();
  return answered.value;
}

export function createBankEvidenceUpload(runtime: CommerceRequestRuntime, co: Pick<BankRouteCollaborators, "evidence" | "timer">): (request: UploadBankEvidenceRequest) => Promise<InboundReadAnswer<BankEvidenceArtifactView>> {
  async function ownerUnit<T>(request: UploadBankEvidenceRequest, context: OperatorContext, work: (uow: CommerceUnitOfWork) => Promise<T>, denied: { value: boolean }): Promise<T> {
    return runtime.unitOfWork.run(context, async (uow) => {
      const decision = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: request.subject.identity, role: "KAURO_OWNER" });
      if (decision.kind === "DENY") {
        denied.value = true;
        throw CommerceAccessDenied.of(UPLOAD, decision);
      }
      return work(uow);
    });
  }

  return async (request) => {
    const context: OperatorContext = { kind: "OPERATOR", userId: request.subject.identity.userId as UserId, correlationId: request.correlationId };
    const denied = { value: false };
    try {
      // 1. the body alone: nothing is read, nothing is stored
      const bytes = decoded(request.body.contentBase64);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== request.body.evidenceHash) throw new DomainFailure("INTEGRITY_FAILURE", "the declared hash is not the bytes' SHA-256", { reason: "HASH_MISMATCH" });
      if (!bytesAreOfType(bytes, request.body.mediaType)) throw typeMismatch();
      // 2. the owner, before the store is called
      await ownerUnit(request, context, async () => undefined, denied);
      // 3. the store, outside every transaction, under the provider-call bound
      const store = co.evidence();
      const put = store?.put;
      if (store === null || put === undefined) throw evidenceUnavailable();
      const accountRef = request.accountRef as BankAccountRef;
      const stored = await bounded(co, () => put.call(store, { bytes, accountRef }));
      if (stored.sha256 !== sha256) throw new DomainFailure("INTEGRITY_FAILURE", "the store answered another digest", { reason: "HASH_MISMATCH" });
      const record = await bounded(co, () => store.get(stored.artifactRef));
      if (record === null || record.sha256 !== sha256) throw evidenceUnavailable();
      if (record.accountRef !== accountRef) throw new DomainFailure("INTEGRITY_FAILURE", "the store holds these bytes for another account", { reason: "UNKNOWN_EVIDENCE" });
      // 4. the reply only under the owner's credential as it stands now (rule 16)
      const view: BankEvidenceArtifactView = { artifact: { artifactRef: stored.artifactRef, evidenceHash: sha256, sizeBytes: bytes.byteLength, mediaType: request.body.mediaType, accountRef } };
      await ownerUnit(request, context, (uow) => judgedUnderHold(request.authority, uow, runtime.clock), denied);
      return { kind: "READ", view };
    } catch (e) {
      if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
      if (denied.value || e.code === "AUTHENTICATION_REQUIRED") await recordCommerceDenial(runtime, context, UPLOAD, e, null);
      return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) };
    }
  };
}
