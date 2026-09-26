/**
 * UPLOAD_INSPECTION (docs/design/B07-upload-source-lifecycle.md §12.1; decisions D-INSP-1..4, D-SCAN-1, D-SCAN-2, D-ISO-1, D-FILE-1,
 * D-LOCK-2, D-INTAKE-1, D-CLOCK-1; S053, S054, S024, CMD014): the consumer of `upload_session.completion_reported.v1`. The browser's
 * completion report is a claim; this pipeline observes what the provider actually holds and decides admission on the server's own
 * facts, under one inspection attempt fence:
 *
 *   A. revision row, then the upload (D-LOCK-2): claim the attempt (`inspection_fence + 1` while VERIFYING — anything else, or a
 *      passed deadline, is DONE); the database stamps the claim instant, the receipt's `startedAt` (D-INSP-4);
 *   B. stat the quarantine name (outside any transaction);
 *   C. revision row, upload: absent → completion_not_observed (VERIFYING → UPLOADING with the control plane's negative observation,
 *      D-ROLE-3); present → the observation recorded (set once) with the claim's consistency, the quarantine object PRESENT;
 *   D. outside any transaction: the observed size against the reservation, the claim against the observation (S053: a claimed
 *      generation, size or provider checksum the observation contradicts is CLAIM_MISMATCH), the bounded container inspection of
 *      the exact generation in its isolated child (D-ISO-1), the scan of the container and every allowed part, its instant read from
 *      the database clock after the scan (D-INSP-4), the scan state derived by the domain against the object (D-SCAN-1);
 *   E. admissible: the accepted intent registered before any provider write (D-OBJ-1), the exact generation copied with a
 *      no-overwrite precondition, observed and re-read to the inspected digest (else PROMOTION_UNVERIFIED);
 *   F. one unit of work, revision row first: the receipt of this attempt and either the file with its frozen inventory
 *      (source_file.admitted.v1), ADMITTED (upload_session.admitted.v1) and INPUT_ADMITTED — or REJECTED with its class
 *      (upload_session.rejected.v1) and INTAKE_REJECTED. The revision is never moved (D-INTAKE-1).
 *
 * Only a transient infrastructure failure (a provider or vault call, the inspector's child, an engine ERROR) is retried, inside the
 * application deadline (09: "Only genuinely transient infrastructure failures retry automatically within the original deadline");
 * once the deadline passed, the deadline sweeper expires the upload. A cancellation that won the upload row leaves the attempt
 * nothing to attach (KA071): its promotion, if it made one, is registered RESIDUAL and deleted.
 */
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  ConsumerOutcome,
  ContainerInspection,
  ContainerInspectorPort,
  InspectionLimits,
  MalwareScannerPort,
  ObjectObservation,
  ObjectStoragePort,
  OutboxConsumer,
} from "@kauro/application";
import {
  SIGNATURE_MAX_AGE_SECONDS,
  acceptedObjectName,
  evaluateScanCoverage,
  inspectionReceiptHashOf,
  isUuidV7,
  type CausationId,
  type CompletionClaim,
  type DetectedTableRow,
  type DomainEventRecord,
  type InspectionReceiptId,
  type InspectionReceiptRecord,
  type RejectionClass,
  type RevisionId,
  type ScanCoverage,
  type ScannerReport,
  type SourceFileId,
  type RetentionAnchorId,
  type SourceTableId,
  type SourceUnitOfWork,
  type SourceUnitOfWorkFactory,
  type StoredObjectId,
  type StoredObjectRecord,
  type SystemContext,
  type UploadId,
  type UploadSessionRecord,
} from "@kauro/domain";
import { inspectionLimits, parserProfileHashOfInspection, rejectionClassOfScan, storedTableFacts } from "@kauro/data-plane";
import { executeDeletion, locationOf, requestAndDelete } from "../storage-work.js";
import { applied, boundTo, isAfter, lostTheSubject, publish, SettledElsewhere, type WorkItem } from "../work.js";

export interface UploadInspectionDependencies {
  readonly storage: ObjectStoragePort;
  readonly scanner: MalwareScannerPort;
  /** The platform's bounded parser (@kauro/data-plane IsolatedContainerInspector): always real. */
  readonly inspector: ContainerInspectorPort;
  /** The scratch root under which each inspection attempt creates, and removes, its own directory (09 "Derived data and worker scratch"). */
  readonly scratchRoot: string;
  readonly limits?: InspectionLimits;
  /** When a transient failure is retried (default 60 s; never past the application deadline, which ends the attempts). */
  readonly retryAfterSeconds?: number;
}

/** The reason a deletion of the quarantine generation records once the inspection is terminal (09 "Retention schedule"). */
export const QUARANTINE_AFTER_INSPECTION = "INSPECTION_TERMINAL";

/** A claim is consistent when every member it states equals the provider's own observation (S053: a claim is never authority). */
export function claimConsistentWith(claim: CompletionClaim | undefined, observed: Pick<ObjectObservation, "generation" | "bytes" | "crc32c" | "md5">): boolean {
  if (claim === undefined) return false;
  if (claim.generation !== undefined && claim.generation !== observed.generation) return false;
  if (claim.bytes !== undefined && claim.bytes !== observed.bytes) return false;
  if (claim.crc32c !== undefined && (observed.crc32c === undefined || claim.crc32c !== observed.crc32c)) return false;
  if (claim.md5 !== undefined && (observed.md5 === undefined || claim.md5 !== observed.md5)) return false;
  return true;
}

interface Claimed {
  readonly upload: UploadSessionRecord;
  readonly fence: number;
  readonly claimedAt: UtcInstant;
  readonly quarantine: StoredObjectRecord;
}

interface Observed {
  readonly generation: string;
  readonly bytes: number;
  readonly crc32c?: string;
  readonly md5?: string;
  readonly observedAt: UtcInstant;
}

/** What the examination of the observed bytes decided (outside any transaction). */
type Verdict =
  | { readonly kind: "RETRY"; readonly reason: string }
  | { readonly kind: "REJECT"; readonly rejectionClass: RejectionClass; readonly consistent: boolean; readonly inspection?: ContainerInspection; readonly scan?: ScanFacts }
  | { readonly kind: "ADMIT"; readonly inspection: ContainerInspection; readonly scan: ScanFacts };

interface ScanFacts {
  readonly report: ScannerReport;
  readonly scannedAt: UtcInstant;
  readonly coverage: ScanCoverage;
}

interface Promotion {
  readonly fileId: SourceFileId;
  readonly acceptedObjectId: StoredObjectId;
  readonly generation: string;
  readonly verified: boolean;
  readonly sha256: Sha256Hex;
}

function problemsOf(inspection: ContainerInspection | undefined): InspectionReceiptRecord["problems"] {
  return inspection === undefined ? [] : inspection.problems;
}

export class UploadInspection implements OutboxConsumer {
  readonly consumer = "UPLOAD_INSPECTION" as const;
  readonly #deps: UploadInspectionDependencies;
  readonly #limits: InspectionLimits;
  readonly #retryAfterSeconds: number;

  constructor(deps: UploadInspectionDependencies) {
    this.#deps = deps;
    this.#limits = deps.limits ?? inspectionLimits();
    this.#retryAfterSeconds = deps.retryAfterSeconds ?? 60;
    mkdirSync(deps.scratchRoot, { recursive: true });
  }

  async handle(event: DomainEventRecord, context: SystemContext, units: SourceUnitOfWorkFactory): Promise<ConsumerOutcome> {
    if (event.eventType !== "upload_session.completion_reported.v1") return { kind: "DEAD_LETTER", reason: "EVENT_NOT_ROUTED_TO_UPLOAD_INSPECTION" };
    const uploadId = event.payload["uploadId"];
    const revisionId = event.payload["revisionId"];
    if (context.agencyId === undefined || !isUuidV7(uploadId) || !isUuidV7(revisionId) || uploadId !== event.aggregateId) return { kind: "DEAD_LETTER", reason: "EVENT_WITHOUT_SUBJECT" };
    const item: WorkItem = { serviceId: context.serviceId, agencyId: context.agencyId, correlationId: context.correlationId, causationId: event.eventId as unknown as CausationId };
    try {
      return await this.inspect(item, units, uploadId as UploadId, revisionId as RevisionId);
    } catch (e) {
      if (lostTheSubject(e)) return { kind: "DONE" };
      throw e;
    }
  }

  /** One inspection attempt of a VERIFYING upload (steps A–F of the header). */
  async inspect(item: WorkItem, units: SourceUnitOfWorkFactory, uploadId: UploadId, revisionId: RevisionId): Promise<ConsumerOutcome> {
    // A. the attempt
    const claim = await units.runSource(boundTo(item), async (uow) => {
      if ((await uow.sources.revisions.lock(revisionId)) === null) return { kind: "INVISIBLE" as const };
      const upload = await uow.sources.uploads.lock(uploadId);
      if (upload === null || upload.revisionId !== revisionId) return { kind: "INVISIBLE" as const };
      if (upload.state !== "VERIFYING") return { kind: "SETTLED" as const };
      if (!isAfter(upload.applicationExpiresAt, await uow.serverInstant())) return { kind: "SETTLED" as const };
      const attempt = await uow.sources.uploads.claimInspectionAttempt(uploadId);
      const quarantine = await uow.sources.objects.get(upload.quarantineObjectId);
      if (attempt === null || quarantine === null) return { kind: "SETTLED" as const };
      return { kind: "CLAIMED" as const, claimed: { upload, fence: attempt.inspectionFence, claimedAt: attempt.claimedAt, quarantine } satisfies Claimed };
    });
    if (claim.kind === "INVISIBLE") return { kind: "DEAD_LETTER", reason: "SUBJECT_NOT_VISIBLE" };
    if (claim.kind === "SETTLED") return { kind: "DONE" };
    const claimed = claim.claimed;
    const { upload, quarantine } = claimed;

    // B. what the provider holds under the quarantine name
    let seen: ObjectObservation | null;
    try {
      seen = await this.#deps.storage.stat(locationOf(quarantine), quarantine.objectName);
    } catch {
      return this.#retry("PROVIDER_STAT_FAILED");
    }
    let observed: Observed | null = seen === null ? null : { generation: seen.generation, bytes: seen.bytes, observedAt: seen.observedAt, ...(seen.crc32c === undefined ? {} : { crc32c: seen.crc32c }), ...(seen.md5 === undefined ? {} : { md5: seen.md5 }) };
    if (upload.observedGeneration !== undefined) {
      // a retried attempt: the observation is set once; the provider must still hold exactly that generation
      if (observed === null || observed.generation !== upload.observedGeneration || observed.bytes !== upload.observedBytes) return this.#retry("OBSERVED_GENERATION_NOT_LIVE");
    }
    const consistent = observed !== null && claimConsistentWith(upload.claim, observed);

    // C. the observation (or its absence) recorded under the attempt
    const recorded = await units.runSource(boundTo(item), async (uow) => {
      const current = await this.#lockAttempt(uow, item, claimed, revisionId);
      if (observed === null) {
        const reopened = applied(await uow.sources.uploads.transition(uploadId, current.version, { event: "completion_not_observed" }), "completion_not_observed");
        await publish(uow, item, "upload_session", uploadId, reopened.version, "upload_session.completion_not_observed.v1", { uploadId, agencyId: item.agencyId, revisionId });
        return "NOT_OBSERVED" as const;
      }
      if (current.observedGeneration === undefined) {
        const withObservation = applied(await uow.sources.uploads.recordObservation(uploadId, current.version, { generation: observed.generation, bytes: observed.bytes }), "observation");
        await publish(uow, item, "upload_session", uploadId, withObservation.version, "upload_session.completion_observed.v1", {
          uploadId,
          agencyId: item.agencyId,
          revisionId,
          observedBytes: observed.bytes,
          claimConsistent: consistent,
        });
        const object = await uow.sources.objects.get(quarantine.objectId);
        if (object?.state === "INTENDED") await uow.sources.objects.observe(quarantine.objectId, { generation: observed.generation, bytes: observed.bytes, observedAt: observed.observedAt, late: false });
      }
      return "OBSERVED" as const;
    });
    if (recorded === "NOT_OBSERVED" || observed === null) return { kind: "DONE" };

    // D. the server's own facts
    const verdict = await this.#examine(item, units, claimed, observed, consistent);
    if (verdict.kind === "RETRY") return this.#retry(verdict.reason);

    // E. the promotion of an admissible generation
    let promotion: Promotion | undefined;
    if (verdict.kind === "ADMIT") {
      const promoted = await this.#promote(item, units, claimed, observed, verdict.inspection);
      if (promoted.kind === "RETRY") return this.#retry(promoted.reason);
      promotion = promoted.promotion;
    }

    // F. the decision of this attempt
    try {
      await this.#decide(item, units, claimed, observed, verdict, promotion);
    } catch (e) {
      if (lostTheSubject(e) && promotion !== undefined) await this.#discardPromotion(item, units, promotion.acceptedObjectId);
      throw e;
    }
    // the quarantine copy's availability ends with the terminal inspection (09 "Retention schedule": incomplete upload and
    // quarantine, until inspection terminal); a deletion the provider refuses now is retried by DELETION_RETRIES
    if (verdict.kind === "ADMIT" && promotion?.verified === true) await executeDeletion(this.#deps.storage, units, item, quarantine.objectId);
    return { kind: "DONE" };
  }

  #retry(reason: string): ConsumerOutcome {
    return { kind: "RETRY", afterSeconds: this.#retryAfterSeconds, reason };
  }

  /** The revision row, then the upload (D-LOCK-2); the attempt must still hold its fence on a VERIFYING upload. */
  async #lockAttempt(uow: SourceUnitOfWork, _item: WorkItem, claimed: Claimed, revisionId: RevisionId): Promise<UploadSessionRecord> {
    await uow.sources.revisions.lock(revisionId);
    const current = await uow.sources.uploads.lock(claimed.upload.uploadId);
    if (current === null || current.state !== "VERIFYING" || current.inspectionFence !== claimed.fence) throw new SettledElsewhere("inspection attempt");
    return current;
  }

  async #examine(item: WorkItem, units: SourceUnitOfWorkFactory, claimed: Claimed, observed: Observed, consistent: boolean): Promise<Verdict> {
    const { upload, quarantine } = claimed;
    if (observed.bytes === 0) return { kind: "REJECT", rejectionClass: "EMPTY_OBJECT", consistent };
    if (observed.bytes > upload.reservedBytes) return { kind: "REJECT", rejectionClass: "SIZE_EXCEEDS_RESERVATION", consistent };
    if (!consistent) return { kind: "REJECT", rejectionClass: "CLAIM_MISMATCH", consistent };
    const location = locationOf(quarantine);
    let inspection: ContainerInspection;
    try {
      inspection = await this.#deps.inspector.inspect({
        open: () => this.#deps.storage.read(location, quarantine.objectName, observed.generation),
        declaredFormat: upload.declaredFormat,
        observedBytes: observed.bytes,
        limits: this.#limits,
        scratchDir: this.#deps.scratchRoot,
      });
    } catch {
      return { kind: "RETRY", reason: "INSPECTION_NOT_COMPLETED" };
    }
    if (inspection.refusal !== undefined) return { kind: "REJECT", rejectionClass: inspection.refusal, consistent, inspection };
    if (inspection.detectedFormat !== upload.declaredFormat) return { kind: "REJECT", rejectionClass: "FORMAT_MISMATCH", consistent, inspection };
    let report: ScannerReport;
    try {
      report = await this.#deps.scanner.scan({ location, objectName: quarantine.objectName, generation: observed.generation, parts: inspection.expectedScanParts });
    } catch {
      return { kind: "RETRY", reason: "SCAN_NOT_COMPLETED" };
    }
    // the scan instant is the database's, read after the scan (D-INSP-4): never the worker's or the engine's
    const scannedAt = await units.runSource(boundTo(item), (uow) => uow.serverInstant());
    const coverage = evaluateScanCoverage(inspection.expectedScanParts, { ...report, scannedAt }, { pinnedConfigHash: this.#deps.scanner.pinnedConfigHash }, { observedBytes: observed.bytes });
    const scan: ScanFacts = { report, scannedAt, coverage };
    const scanClass = rejectionClassOfScan(coverage);
    if (scanClass === "TRANSIENT_INFRASTRUCTURE") return { kind: "RETRY", reason: "SCAN_ENGINE_ERROR" };
    if (scanClass !== undefined) return { kind: "REJECT", rejectionClass: scanClass, consistent, inspection, scan };
    return { kind: "ADMIT", inspection, scan };
  }

  /**
   * E: the accepted intent is registered before the copy (D-OBJ-1: a name is reserved before any provider write). Its object carries
   * no file link: the file exists only once the decision commits and stored_objects.file_id is set once (decision D-CTRL-3); the
   * admitted file names the object (source_files.accepted_object_id).
   */
  async #promote(item: WorkItem, units: SourceUnitOfWorkFactory, claimed: Claimed, observed: Observed, inspection: ContainerInspection): Promise<{ readonly kind: "RETRY"; readonly reason: string } | { readonly kind: "PROMOTED"; readonly promotion: Promotion }> {
    const accepted = this.#deps.storage.location("ACCEPTED");
    const intent = await units.runSource(boundTo(item), async (uow) => {
      await this.#lockAttempt(uow, item, claimed, claimed.upload.revisionId);
      const fileId = uow.ids.next() as SourceFileId;
      const acceptedObjectId = uow.ids.next() as StoredObjectId;
      const objectName = acceptedObjectName(item.agencyId, claimed.upload.projectId, fileId);
      await uow.sources.objects.register({
        objectId: acceptedObjectId,
        agencyId: item.agencyId,
        projectId: claimed.upload.projectId,
        revisionId: claimed.upload.revisionId,
        uploadId: claimed.upload.uploadId,
        zone: "ACCEPTED",
        dataClass: "RAW",
        provider: accepted.provider,
        locationRef: accepted.locationRef,
        objectName,
        createdBy: { kind: "SERVICE", serviceId: item.serviceId },
        createdAt: await uow.serverInstant(),
      });
      return { fileId, acceptedObjectId, objectName };
    });
    let generation: string;
    try {
      ({ generation } = await this.#deps.storage.copy({ location: locationOf(claimed.quarantine), objectName: claimed.quarantine.objectName, generation: observed.generation }, { location: accepted, objectName: intent.objectName }));
    } catch {
      return { kind: "RETRY", reason: "PROMOTION_COPY_FAILED" };
    }
    // observe and re-read the copy: a copy response without matching bytes is insufficient (09 "Accepted immutability and sealing")
    let verified = false;
    let sha256 = inspection.sha256;
    try {
      const present = await this.#deps.storage.stat(accepted, intent.objectName);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of this.#deps.storage.read(accepted, intent.objectName, generation)) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      sha256 = hash.digest("hex");
      verified = present?.generation === generation && present.bytes === observed.bytes && bytes === observed.bytes && sha256 === inspection.sha256;
    } catch {
      verified = false;
    }
    return { kind: "PROMOTED", promotion: { fileId: intent.fileId, acceptedObjectId: intent.acceptedObjectId, generation, verified, sha256 } };
  }

  /** F: the receipt of the attempt and its outcome, in one unit of work (revision row first). */
  async #decide(item: WorkItem, units: SourceUnitOfWorkFactory, claimed: Claimed, observed: Observed, verdict: Exclude<Verdict, { readonly kind: "RETRY" }>, promotion: Promotion | undefined): Promise<void> {
    const { upload, quarantine } = claimed;
    const inspection = verdict.inspection;
    const scan = verdict.scan;
    const rejection: RejectionClass | undefined = verdict.kind === "REJECT" ? verdict.rejectionClass : promotion?.verified === true ? undefined : "PROMOTION_UNVERIFIED";
    await units.runSource(boundTo(item), async (uow) => {
      await this.#lockAttempt(uow, item, claimed, upload.revisionId);
      const completedAt = await uow.serverInstant();
      const sha256 = inspection?.sha256;
      const quarantineNow = await uow.sources.objects.get(quarantine.objectId);
      if (sha256 !== undefined && quarantineNow?.state === "PRESENT") await uow.sources.objects.verify(quarantine.objectId, sha256, completedAt);
      if (promotion !== undefined) {
        // the copy is registered at its generation either way: admitted, or a residual of a rejected attempt deleted with the upload
        await uow.sources.objects.observe(promotion.acceptedObjectId, { generation: promotion.generation, bytes: observed.bytes, observedAt: completedAt, late: rejection !== undefined });
        if (rejection === undefined) await uow.sources.objects.verify(promotion.acceptedObjectId, promotion.sha256, completedAt);
      }
      const scanner =
        scan === undefined
          ? undefined
          : {
              engine: scan.report.engine,
              engineVersion: scan.report.engineVersion,
              signatureVersion: scan.report.signatureVersion,
              signaturesPublishedAt: scan.report.signaturesPublishedAt,
              signatureMaxAgeSeconds: SIGNATURE_MAX_AGE_SECONDS,
              configHash: scan.report.configHash,
              scannedAt: scan.scannedAt,
              exitCode: scan.report.exitCode,
              verdict: scan.report.verdict,
            };
      const scanState = scan === undefined ? "NOT_SCANNED" : scan.coverage.scanState;
      const body: Omit<InspectionReceiptRecord, "receiptId" | "receiptHash"> = {
        agencyId: item.agencyId,
        uploadId: upload.uploadId,
        revisionId: upload.revisionId,
        inspectionFence: claimed.fence,
        quarantineObjectId: quarantine.objectId,
        observedGeneration: observed.generation,
        observedBytes: observed.bytes,
        ...(sha256 === undefined ? {} : { sha256 }),
        completionClaimDigest: upload.completionClaimDigest as Sha256Hex,
        claimConsistent: verdict.kind === "ADMIT" ? true : verdict.consistent,
        declaredFormat: upload.declaredFormat,
        detectedFormat: inspection === undefined ? "NOT_EVALUATED" : inspection.detectedFormat,
        structureStatus: inspection === undefined ? "NOT_EVALUATED" : inspection.structureStatus,
        scanState,
        semanticStatus: "SEMANTIC_NOT_YET_PROFILED",
        ...(scanner === undefined ? {} : { scanner }),
        expectedParts: scan?.coverage.expectedParts ?? 0,
        expectedBytes: scan?.coverage.expectedBytes ?? 0,
        scannedParts: scan?.coverage.scannedParts ?? 0,
        scannedBytes: scan?.coverage.scannedBytes ?? 0,
        coverage: scan?.coverage.coverage ?? [],
        problems: problemsOf(inspection),
        ...(inspection === undefined ? {} : { parserProfileHash: parserProfileHashOfInspection(inspection) }),
        inspectorVersion: this.#deps.inspector.version,
        outcome: rejection === undefined ? "ADMITTED" : "REJECTED",
        ...(rejection === undefined ? {} : { rejectionClass: rejection }),
        ...(rejection === undefined && promotion !== undefined ? { accepted: { objectId: promotion.acceptedObjectId, generation: promotion.generation, sha256: promotion.sha256 } } : {}),
        startedAt: claimed.claimedAt,
        completedAt,
      };
      const receiptHash = inspectionReceiptHashOf(body);
      await uow.sources.inspections.append({ ...body, receiptId: uow.ids.next() as InspectionReceiptId, receiptHash });
      if (rejection === undefined && promotion !== undefined && inspection !== undefined) {
        await this.#admit(uow, item, claimed, observed, inspection, promotion, receiptHash);
        await uow.sources.objects.requestDeletion([quarantine.objectId], QUARANTINE_AFTER_INSPECTION, completedAt);
      } else {
        const current = await uow.sources.uploads.lock(upload.uploadId);
        if (current === null) throw new SettledElsewhere("rejection");
        const rejected = applied(await uow.sources.uploads.transition(upload.uploadId, current.version, { event: "inspection_rejected", receiptHash, rejectionClass: rejection as RejectionClass, inspectionFence: claimed.fence }), "inspection_rejected");
        await publish(uow, item, "upload_session", upload.uploadId, rejected.version, "upload_session.rejected.v1", {
          uploadId: upload.uploadId,
          agencyId: item.agencyId,
          revisionId: upload.revisionId,
          inspectionReceiptHash: receiptHash,
          rejectionClass: rejection as RejectionClass,
          scanState,
        });
        await uow.sources.retention.appendAnchor({ anchorId: uow.ids.next() as RetentionAnchorId, agencyId: item.agencyId, projectId: upload.projectId, revisionId: upload.revisionId, uploadId: upload.uploadId, kind: "INTAKE_REJECTED", sourceEvidenceHash: receiptHash });
        if (promotion !== undefined) await uow.sources.objects.requestDeletion([promotion.acceptedObjectId], "PROMOTION_UNVERIFIED", completedAt);
      }
      // the session was finalized (the provider holds its object): the bearer reference can do nothing more (D-SESSION-1, D-CTRL-2)
      await uow.sources.sessionSecrets.purge(upload.uploadId);
    });
  }

  /** The admission of the promoted generation: the file and its frozen inventory, ADMITTED, INPUT_ADMITTED (D-FILE-1, D-FILE-2). */
  async #admit(
    uow: SourceUnitOfWork,
    item: WorkItem,
    claimed: Claimed,
    observed: Observed,
    inspection: ContainerInspection,
    promotion: Promotion,
    receiptHash: Sha256Hex,
  ): Promise<void> {
    const { upload } = claimed;
    const tables: DetectedTableRow[] = inspection.tables.map((table) => {
      const tableId = uow.ids.next() as SourceTableId;
      const facts = storedTableFacts(promotion.fileId, table);
      return {
        tableId,
        agencyId: item.agencyId,
        fileId: promotion.fileId,
        ordinal: table.ordinal,
        kind: table.kind,
        ...(table.name === undefined ? {} : { nameDisplay: table.name }),
        nameDigest: facts.nameDigest,
        visibility: table.visibility,
        columnCount: table.columnCount,
        ...(table.rowEstimate === undefined ? {} : { rowEstimate: table.rowEstimate }),
        hasFormulas: table.hasFormulas,
        formulaCache: table.formulaCache,
        mergedCellCount: table.mergedCellCount,
        hiddenRowCount: table.hiddenRowCount,
        hiddenColumnCount: table.hiddenColumnCount,
        issues: table.issues,
        structureHash: facts.structureHash,
        columns: facts.columns.map((c) => ({ tableId, ...c })),
      };
    });
    const file = await uow.sources.files.admit(
      {
        fileId: promotion.fileId,
        storageRef: promotion.acceptedObjectId,
        agencyId: item.agencyId,
        projectId: upload.projectId,
        originRevisionId: upload.revisionId,
        originUploadId: upload.uploadId,
        inspectionReceiptHash: receiptHash,
        providerGeneration: promotion.generation,
        sha256: promotion.sha256,
        bytes: observed.bytes,
        format: upload.declaredFormat,
        scanState: "COVERED_CLEAN",
        parserProfileHash: parserProfileHashOfInspection(inspection),
      },
      tables,
    );
    await publish(uow, item, "source_file", file.fileId, file.version, "source_file.admitted.v1", {
      fileId: file.fileId,
      agencyId: item.agencyId,
      projectId: upload.projectId,
      originRevisionId: upload.revisionId,
      originUploadId: upload.uploadId,
      inspectionReceiptHash: receiptHash,
      bytes: observed.bytes,
      format: upload.declaredFormat,
    });
    const current = await uow.sources.uploads.lock(upload.uploadId);
    if (current === null) throw new SettledElsewhere("admission");
    const admitted = applied(await uow.sources.uploads.transition(upload.uploadId, current.version, { event: "inspection_admitted", fileId: file.fileId, receiptHash, inspectionFence: claimed.fence }), "inspection_admitted");
    await publish(uow, item, "upload_session", upload.uploadId, admitted.version, "upload_session.admitted.v1", {
      uploadId: upload.uploadId,
      agencyId: item.agencyId,
      revisionId: upload.revisionId,
      fileId: file.fileId,
      inspectionReceiptHash: receiptHash,
      observedBytes: observed.bytes,
      scanState: "COVERED_CLEAN",
      detectedFormat: inspection.detectedFormat,
    });
    await uow.sources.retention.appendAnchor({ anchorId: uow.ids.next() as RetentionAnchorId, agencyId: item.agencyId, projectId: upload.projectId, revisionId: upload.revisionId, uploadId: upload.uploadId, kind: "INPUT_ADMITTED", sourceEvidenceHash: receiptHash });
  }

  /**
   * A promotion whose attempt lost the upload (a cancellation or an expiry won the upload row): the accepted copy is registered as a
   * late residual at its generation and deleted (the UploadSession machine: "anything it promoted is registered as residual and
   * deleted"; 09 "A late completed object after cancellation or expiry remains quarantined and is deleted").
   */
  async #discardPromotion(item: WorkItem, units: SourceUnitOfWorkFactory, acceptedObjectId: StoredObjectId): Promise<void> {
    const object = await units.runSource(boundTo(item), (uow) => uow.sources.objects.get(acceptedObjectId));
    if (object === null) return;
    await requestAndDelete(this.#deps.storage, units, item, [object], "ATTEMPT_LOST");
  }
}
