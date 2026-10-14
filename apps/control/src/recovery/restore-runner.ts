/**
 * The restore runner (package B16 lane L6; R2 14 "External-effect recovery journal": "After restoring a backup, disable dispatch, apply
 * current tombstones and revocations, query provider payment state, rebuild safe inbox/outbox disposition and invalidate all old leases";
 * 09 "Deletion receipts and restoration"; CMD057 "Run the authorized isolated restore and release only after integrity/tenant/deletion/
 * financial checks"). The steps, each resumable from what the restored database records (restore_runs, migration 0076):
 *
 *   S1 prepare     the control plane names the journal through n by its chained hash and prepares the candidate on the primary;
 *   S2 restore     the backup is restored into an ISOLATED database (RestoreTarget; the local adapter is pg_restore, the provider's
 *                  snapshot restore and its measured RPO/RTO are BLOCKED_OWNER D-14);
 *   S3 gate        the migration owner closes the recovery gate as its first statement on the restored database, lifts the event
 *                  identity above every journaled sequence and records the run (GATED);
 *   S4 journal     entries 1..n applied in journal order, each idempotent (check, then act; the effect commits before its applied row,
 *                  so a crash between them re-checks and finds it done); entry k that cannot be applied is recorded with its code and
 *                  the run stops there, the gate closed; the next run resumes at k. After the last entry the retention cleanup runs —
 *                  never before (R2-126);
 *   S5 fence       every lease ends on the database clock: the next claim of any of them is a takeover at fence + 1 under leases_guard
 *                  (a spending attempt without a checkpoint is never resumed: it is abandoned and rerun under its job, R2-076);
 *   S6 payments    every journaled provider payment state is compared with the restored rows; a mismatch opens a provider
 *                  observation with a deadline on the database clock and the run PAUSES (the gate stays closed);
 *   S7 checks      the candidate and the journal are unchanged through n, every tombstone, revocation and extension holds, no lease
 *                  is live: the run records the hash of its checks (CHECKED);
 *   S8 release     only with the owner's CMD057 authorization of this candidate (AUTHORIZED, its recovery naming this journal hash):
 *                  the run is RELEASED and the gate opens in one transaction; the journal tail re-bases on the restored database.
 */
import { createHash } from "node:crypto";
import type { Sha256Hex } from "@kauro/contracts";
import { canonicalize } from "@kauro/contracts";
import type { AuditUnits, PaymentObservationPort, RecoveryJournalEntry, RecoveryJournalPort } from "@kauro/application";
import {
  DomainFailure,
  effectNowOf,
  isDomainFailure,
  revokeMembership,
  withProvenance,
  type AgencyId,
  type CausationId,
  type CorrelationId,
  type IdGenerator,
  type MembershipId,
  type ProjectId,
  type RetentionExtensionId,
  type RetentionId,
  type SystemContext,
  type TenantContext,
  type UserId,
} from "@kauro/domain";
import { PgRestoreOwnerStore, recoveryAuthorityOf, restoreControlOf, type AppliedOutcome, type ObservationRow, type ReleaseHold, type RestoreRunRow, type TombstonedSubjectKind } from "@kauro/persistence";
import { NOTIFICATIONS_CONSUMER } from "../consumers/notification-journal.js";
import { RECOVERY_JOURNAL_TAIL_SOURCE } from "./journal-tail.js";

const SERVICE = "restore-runner";

/** What a restore is restored from and how much of the journal it promises to apply (its hash is the candidate's plan hash). */
export interface RestorePlan {
  readonly backupRef: string;
  readonly journalThrough: number;
}

export function planHashOf(plan: RestorePlan): Sha256Hex {
  return createHash("sha256").update(`KAURO_RESTORE_PLAN_V1\n${canonicalize({ backupRef: plan.backupRef, journalThrough: plan.journalThrough })}`).digest("hex") as Sha256Hex;
}

/** The isolated restored database: its migration owner's one connection and the runtime roles' units of work on it. */
export interface RestoredDatabase {
  readonly owner: ConstructorParameters<typeof PgRestoreOwnerStore>[0];
  readonly units: AuditUnits;
}

/** S2: restores a backup into an isolated database (the local adapter is pg_restore; the provider's is BLOCKED_OWNER D-14). */
export interface RestoreTarget {
  readonly evidenceClass: "EXECUTED_PROVIDER" | "SIMULATED";
  restore(backupRef: string): Promise<RestoredDatabase>;
}

export type RestoreOutcome =
  | { readonly kind: "RELEASED"; readonly run: RestoreRunRow }
  | { readonly kind: "FAILED_AT"; readonly run: RestoreRunRow; readonly entry: number; readonly code: string }
  | { readonly kind: "PAUSED"; readonly run: RestoreRunRow; readonly observations: ReadonlyArray<ObservationRow> }
  | { readonly kind: "AWAITING_AUTHORIZATION"; readonly run: RestoreRunRow }
  | { readonly kind: "REFUSED"; readonly run: RestoreRunRow; readonly reason: string };

export interface RestoreRunnerDependencies {
  readonly journal: RecoveryJournalPort;
  /** The control plane's units of work on the primary (S1's candidate, S8's authorization). */
  readonly primary: AuditUnits;
  readonly ids: IdGenerator;
  /** The provider's answer for an unreconciled payment (PART: BLOCKED_OWNER D-14 / B15); absent, every observation waits for its deadline. */
  readonly observations?: PaymentObservationPort;
  /** How long a provider observation stays open (database clock); 900 s by default. */
  readonly observationSeconds?: number;
  /** The retention cleanup over the restored database, run after the journal (the RETENTION sweeper). */
  readonly cleanup?: (units: AuditUnits) => Promise<unknown>;
}

/** A journal entry the restore cannot apply: the run stops at it with this code (KA092 family, never a silent skip). */
export class RestoreStepRefused extends DomainFailure {
  constructor(
    readonly token: string,
    message: string,
  ) {
    super("PRECONDITION_FAILED", message, { reason: "CONSEQUENCES_UNRECONCILED" });
  }
}

const TOMBSTONE_SUBJECT: Readonly<Record<string, TombstonedSubjectKind>> = Object.freeze({
  UPLOAD_ACCEPTANCE_REVOKED: "upload_session",
  REVISION_CANCELLED: "dataset_revision",
  REVISION_SUPERSEDED: "dataset_revision",
  REVISION_REJECTED: "dataset_revision",
  REVISION_EXPIRED: "dataset_revision",
  REVISION_DELETED: "dataset_revision",
  FILE_ADMISSION_REVOKED: "source_file",
  RETENTION_EXTENDED: "retention_extension",
});
/** Tombstone states a restored subject reaches only after the journal and the cleanup (the retention sweep expires a revision and
 * revokes its files): DEFERRED at S4, re-verified at S7, where a subject that did not reach its state refuses the release. */
const REACHED_LATER: ReadonlySet<string> = new Set(["EXPIRED", "EXTENDED", "ADMISSION_REVOKED"]);

function codeOf(e: unknown): string {
  if (e instanceof RestoreStepRefused) return e.token;
  // the SQLSTATE itself, the one a translated failure carries (sqlState), or the one of the failure a unit of work wrapped (cause)
  const x = e as { code?: unknown; sqlState?: unknown; cause?: { code?: unknown } };
  for (const sqlstate of [x.code, x.sqlState, x.cause?.code]) if (typeof sqlstate === "string" && /^[A-Z0-9]{5}$/.test(sqlstate)) return `SQLSTATE_${sqlstate}`;
  if (isDomainFailure(e)) return typeof e.details.reason === "string" ? e.details.reason : e.code;
  return "RESTORE_STEP_FAILED";
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.length === 0) throw new RestoreStepRefused("JOURNAL_ENTRY_MALFORMED", `${what} is missing from the journal entry`);
  return v;
};

export class RestoreRunner {
  constructor(private readonly deps: RestoreRunnerDependencies) {}

  #system(agencyId?: string): SystemContext {
    const correlationId = this.deps.ids.next() as CorrelationId;
    return agencyId === undefined ? { kind: "SYSTEM", serviceId: SERVICE, correlationId } : { kind: "SYSTEM", serviceId: SERVICE, correlationId, agencyId: agencyId as AgencyId };
  }

  #tenant(agencyId: string, userId: string): TenantContext {
    return { kind: "TENANT", agencyId: agencyId as AgencyId, userId: userId as UserId, correlationId: this.deps.ids.next() as CorrelationId };
  }

  /** S1: the journal through its head, named by its chained hash, prepared as a candidate on the primary. */
  async prepare(backupRef: string): Promise<{ readonly candidateId: string; readonly plan: RestorePlan; readonly deletionJournalHash: Sha256Hex }> {
    const journalThrough = await this.deps.journal.head();
    const deletionJournalHash = await this.deps.journal.hashThrough(journalThrough);
    const plan: RestorePlan = { backupRef, journalThrough };
    const candidateId = this.deps.ids.next();
    await this.deps.primary.run(this.#system(), (uow) => recoveryAuthorityOf(uow).prepare({ candidateId, planHash: planHashOf(plan), deletionJournalHash }));
    return { candidateId, plan, deletionJournalHash };
  }

  /** S3..S8 over the restored database, resumed from what it records; stops at the first step that cannot pass, the gate closed. */
  async run(candidateId: string, plan: RestorePlan, restored: RestoredDatabase, options: { readonly releaseHold?: ReleaseHold } = {}): Promise<RestoreOutcome> {
    const candidate = await this.deps.primary.run(this.#system(), (uow) => recoveryAuthorityOf(uow).candidate(candidateId));
    if (candidate === null || candidate.planHash !== planHashOf(plan)) throw new DomainFailure("PRECONDITION_FAILED", "the restore plan is not the prepared candidate's", { reason: "CONSEQUENCES_UNRECONCILED" });
    const store = new PgRestoreOwnerStore(restored.owner);
    // S3
    let run =
      (await store.run(candidateId)) ??
      (await store.closeGate({
        runId: this.deps.ids.next(),
        candidateId,
        planHash: candidate.planHash,
        deletionJournalHash: candidate.deletionJournalHash,
        journalThrough: plan.journalThrough,
        eventSequenceFloor: await this.deps.journal.maxEventSequence(),
      }));
    if (run.state === "RELEASED") return { kind: "RELEASED", run };
    // S4
    if (run.state === "GATED" || run.state === "APPLYING") {
      if ((await this.deps.journal.hashThrough(run.journalThrough)) !== run.deletionJournalHash) return { kind: "REFUSED", run, reason: "JOURNAL_HASH_MISMATCH" };
      for (const entry of await this.deps.journal.entries(run.appliedThrough, run.journalThrough)) {
        let outcome: AppliedOutcome;
        try {
          outcome = await this.#apply(entry, restored, run);
        } catch (e) {
          const code = codeOf(e);
          run = await store.recordFailure(run, entry.journalSeq, code);
          return { kind: "FAILED_AT", run, entry: entry.journalSeq, code };
        }
        run = await store.recordApplied(run, entry, outcome);
      }
      if (this.deps.cleanup !== undefined) await this.deps.cleanup(restored.units);
      run = await store.move(run, "APPLIED");
    }
    // S5
    if (run.state === "APPLIED") {
      await restored.units.run(this.#system(), (uow) => restoreControlOf(uow).expireLeases());
      run = await store.move(run, "FENCED");
    }
    // S6
    if (run.state === "FENCED" || run.state === "PAUSED") {
      for (const entry of await this.deps.journal.entries(0, run.journalThrough)) {
        if (entry.kind !== "PAYMENT") continue;
        const captureId = str(entry.body["captureId"], "captureId");
        const agencyId = str(entry.body["agencyId"], "agencyId");
        const restoredStatus = await restored.units.run(this.#system(agencyId), (uow) => restoreControlOf(uow).captureStatus(captureId));
        if (restoredStatus === entry.body["status"]) continue;
        await store.openObservation({
          observationId: this.deps.ids.next(),
          run,
          journalSeq: entry.journalSeq,
          entryId: entry.entryId,
          subjectKind: "CAPTURE",
          subjectId: captureId,
          mismatch: restoredStatus === null ? "CAPTURE_MISSING" : `CAPTURE_${restoredStatus}`,
          seconds: this.deps.observationSeconds ?? 900,
        });
      }
      const observations = await store.observations(run.runId);
      if (observations.length > 0) {
        if (run.state === "FENCED") run = await store.move(run, "PAUSED");
        return { kind: "PAUSED", run, observations: await this.observe(restored, run) };
      }
      run = await store.move(run, "RECONCILED");
    }
    // S7
    if (run.state === "RECONCILED") {
      const checks = await this.#checks(candidateId, run, restored);
      if (checks.failed !== null) return { kind: "REFUSED", run, reason: checks.failed };
      run = await store.move(run, "CHECKED", checks.hash);
    }
    // S8
    const recovery = await this.deps.primary.run(this.#system(), async (uow) => {
      const authority = recoveryAuthorityOf(uow);
      const now = await authority.candidate(candidateId);
      const authorized = await authority.recovery(candidateId);
      return now?.state === "AUTHORIZED" && authorized !== null && authorized.deletionJournalHash === run.deletionJournalHash ? authorized : null;
    });
    if (recovery === null) return { kind: "AWAITING_AUTHORIZATION", run };
    // the journal may have moved while the authorization was awaited: a release applies everything through its own head
    if ((await this.deps.journal.head()) !== run.journalThrough) return { kind: "REFUSED", run, reason: "JOURNAL_ADVANCED" };
    run = await store.release(run, recovery, options.releaseHold);
    await this.deps.journal.rebaseCursor(RECOVERY_JOURNAL_TAIL_SOURCE, await store.horizon());
    return { kind: "RELEASED", run };
  }

  /**
   * S6's provider observations: each OPEN one is asked of the provider (PART: no live provider; UNKNOWN and TIMEOUT resolve nothing) and
   * closed TIMED_OUT once its deadline passed on the database clock. A timed-out observation still holds the run PAUSED, the gate closed:
   * a payment conflict is resolved by the provider's own answer, never by the clock (no resolution path exists yet: fail closed).
   */
  async observe(restored: RestoredDatabase, run: RestoreRunRow): Promise<ReadonlyArray<ObservationRow>> {
    const store = new PgRestoreOwnerStore(restored.owner);
    for (const o of await store.observations(run.runId)) {
      if (o.state !== "OPEN") continue;
      if (this.deps.observations !== undefined) {
        try {
          await this.deps.observations.observe({ kind: o.subjectKind, subjectId: o.subjectId, agencyId: null });
        } catch {
          // an unreachable provider is an unanswered observation
        }
      }
      if (o.deadlineReached) await store.timeOut(o.observationId);
    }
    return store.observations(run.runId);
  }

  // --- S4: one entry, idempotently --------------------------------------------------------------------------------------------------

  async #apply(entry: RecoveryJournalEntry, restored: RestoredDatabase, run: RestoreRunRow): Promise<AppliedOutcome> {
    const b = entry.body;
    switch (entry.kind) {
      case "TOMBSTONE": {
        const subject = TOMBSTONE_SUBJECT[str(b["kind"], "kind")];
        if (subject === undefined) throw new RestoreStepRefused("TOMBSTONE_KIND_UNKNOWN", `tombstone kind ${String(b["kind"])} has no restored subject`);
        const state = str(b["state"], "state");
        const now = await restored.units.run(this.#system(str(b["agencyId"], "agencyId")), (uow) => restoreControlOf(uow).subjectState(subject, str(b["subjectId"], "subjectId")));
        if (now === null) return "ABSENT";
        if (now === state) return "VERIFIED";
        if (REACHED_LATER.has(state)) return "DEFERRED";
        // a terminal state the restored subject has not reached is written by its own lifecycle (deletion: lane L3): fail closed here
        throw new RestoreStepRefused("TOMBSTONE_NOT_APPLICABLE", `tombstone ${entry.entryId}: the restored ${subject} is ${now}, the journal says ${state}`);
      }
      case "REVOCATION":
        return this.#revoke(entry, restored, run);
      case "EXTENSION":
        return this.#extend(entry, restored, run);
      case "PAYMENT":
        return "DEFERRED"; // S6
      case "NOTIFICATION":
        return restored.units.run(this.#system(), (uow) => restoreControlOf(uow).suppress(str(b["eventId"], "eventId"), NOTIFICATIONS_CONSUMER));
      default:
        throw new RestoreStepRefused("JOURNAL_KIND_UNKNOWN", `journal kind ${String(entry.kind)} has no applier`);
    }
  }

  /** A revocation replayed as its revoker did it (CMD006's domain effect, the version the restored row has). */
  async #revoke(entry: RecoveryJournalEntry, restored: RestoredDatabase, run: RestoreRunRow): Promise<AppliedOutcome> {
    const b = entry.body;
    const agencyId = str(b["agencyId"], "agencyId");
    const byUserId = str(b["byUserId"], "byUserId");
    return restored.units.run(this.#tenant(agencyId, byUserId), async (uow) => {
      const target = await uow.memberships.lock(str(b["membershipId"], "membershipId") as MembershipId);
      if (target === null) return "ABSENT";
      if (target.state === "REVOKED") return "ALREADY_APPLIED";
      if (target.state === "INVITED") throw new RestoreStepRefused("REVOCATION_OF_INVITATION", `membership ${target.membershipId} is still INVITED in the backup`);
      const actor = await uow.memberships.get(str(b["byMembershipId"], "byMembershipId") as MembershipId);
      const agency = await uow.agencies.lock(agencyId as AgencyId);
      if (actor === null || agency === null) throw new RestoreStepRefused("REVOKER_ABSENT", `the revoker of membership ${target.membershipId} is not in the backup`);
      const now = await effectNowOf(uow);
      const outcome = revokeMembership({ membership: target, actor, agency, expectedVersion: target.version, reasonCode: str(b["reasonCode"], "reasonCode"), now, activeOwnerCount: await uow.memberships.countActiveOwners(agencyId as AgencyId) });
      const moved = await uow.memberships.transition(target.membershipId, target.version, { state: "REVOKED", revokedAt: now }, now);
      if (moved.kind !== "APPLIED") throw new RestoreStepRefused("REVOCATION_STALE", `membership ${target.membershipId} moved during its replay`);
      await uow.events.publish(withProvenance(outcome.event, { actor: { kind: "USER", userId: byUserId as UserId }, causationId: run.runId as CausationId, correlationId: this.deps.ids.next() as CorrelationId }));
      return "APPLIED";
    });
  }

  /** An extension replayed as its requester did it (CMD060's effect at the restored record's version; the endpoint is the same formula). */
  async #extend(entry: RecoveryJournalEntry, restored: RestoredDatabase, run: RestoreRunRow): Promise<AppliedOutcome> {
    const b = entry.body;
    const agencyId = str(b["agencyId"], "agencyId");
    const projectId = str(b["projectId"], "projectId") as ProjectId;
    const extensionId = str(b["extensionId"], "extensionId");
    return restored.units.runSource(this.#tenant(agencyId, str(b["userId"], "userId")), async (uow) => {
      const retention = uow.sources.retention;
      const records = await retention.lockPaidRecordsOfProject(projectId);
      const existing = await retention.extensionOfProject(projectId);
      if (existing !== null) {
        if (existing.extensionId !== extensionId) throw new RestoreStepRefused("EXTENSION_CONFLICT", `project ${projectId} holds extension ${existing.extensionId}, the journal ${extensionId}`);
        return "ALREADY_APPLIED";
      }
      const record = records.find((r) => r.retentionId === b["retentionId"]);
      if (record === undefined) return "ABSENT";
      if (record.state !== "ACTIVE") throw new RestoreStepRefused("EXTENSION_OF_ENDED_RECORD", `retention record ${record.retentionId} is ${record.state} in the backup`);
      const requestedSeconds = Number(b["requestedSeconds"]);
      const { extension, record: moved } = await retention.extendSoftDeadline({
        extensionId: extensionId as RetentionExtensionId,
        retentionId: record.retentionId as RetentionId,
        expectedVersion: record.version,
        requestedSeconds,
        purpose: str(b["purpose"], "purpose"),
        termsVersion: str(b["termsVersion"], "termsVersion"),
        membershipId: str(b["membershipId"], "membershipId") as MembershipId,
      });
      await uow.events.publish({
        aggregateKind: "retention_record",
        aggregateId: moved.retentionId,
        aggregateVersion: moved.version,
        agencyId: moved.agencyId,
        eventType: "retention_record.extended.v1",
        actor: { kind: "USER", userId: str(b["userId"], "userId") as UserId },
        causationId: run.runId as CausationId,
        correlationId: this.deps.ids.next() as CorrelationId,
        payload: {
          retentionId: moved.retentionId,
          agencyId: moved.agencyId,
          projectId: moved.projectId,
          ...(moved.revisionId === undefined ? {} : { revisionId: moved.revisionId }),
          extensionId,
          retentionClass: moved.class,
          requestedSeconds: extension.requestedSeconds,
          grantedSeconds: extension.grantedSeconds,
          cappedAtHardDeadline: extension.cappedAtHardDeadline,
        },
      });
      return "APPLIED";
    });
  }

  // --- S7 -------------------------------------------------------------------------------------------------------------------------

  async #checks(candidateId: string, run: RestoreRunRow, restored: RestoredDatabase): Promise<{ readonly failed: string | null; readonly hash: Sha256Hex }> {
    const results: Array<{ readonly check: string; readonly subject: string; readonly ok: boolean }> = [];
    const candidate = await this.deps.primary.run(this.#system(), (uow) => recoveryAuthorityOf(uow).candidate(candidateId));
    results.push({ check: "CANDIDATE_UNCHANGED", subject: candidateId, ok: candidate !== null && candidate.planHash === run.planHash && candidate.deletionJournalHash === run.deletionJournalHash });
    results.push({ check: "JOURNAL_NOT_ADVANCED", subject: String(run.journalThrough), ok: (await this.deps.journal.head()) === run.journalThrough });
    results.push({ check: "JOURNAL_HASH", subject: run.deletionJournalHash, ok: (await this.deps.journal.hashThrough(run.journalThrough)) === run.deletionJournalHash });
    for (const entry of await this.deps.journal.entries(0, run.journalThrough)) {
      const b = entry.body;
      if (entry.kind === "TOMBSTONE") {
        const subject = TOMBSTONE_SUBJECT[String(b["kind"])];
        const now = subject === undefined ? "UNKNOWN" : await restored.units.run(this.#system(String(b["agencyId"])), (uow) => restoreControlOf(uow).subjectState(subject, String(b["subjectId"])));
        results.push({ check: "TOMBSTONE_HOLDS", subject: entry.entryId, ok: now === null || now === b["state"] });
      } else if (entry.kind === "REVOCATION") {
        const state = await restored.units.run(this.#tenant(String(b["agencyId"]), String(b["byUserId"])), async (uow) => (await uow.memberships.get(String(b["membershipId"]) as MembershipId))?.state ?? null);
        results.push({ check: "REVOCATION_HOLDS", subject: entry.entryId, ok: state === null || state === "REVOKED" });
      } else if (entry.kind === "EXTENSION") {
        const [ext, record] = await restored.units.run(this.#system(String(b["agencyId"])), async (uow) => [
          await restoreControlOf(uow).subjectState("retention_extension", String(b["retentionId"])),
          await restoreControlOf(uow).subjectState("retention_record", String(b["retentionId"])),
        ]);
        results.push({ check: "EXTENSION_HOLDS", subject: entry.entryId, ok: ext === "EXTENDED" || record === null });
      }
    }
    const live = await restored.units.run(this.#system(), (uow) => restoreControlOf(uow).liveLeases());
    results.push({ check: "NO_LIVE_LEASE", subject: "leases", ok: live === 0 });
    const hash = createHash("sha256").update(`KAURO_RESTORE_CHECKS_V1\n${canonicalize(results)}`).digest("hex") as Sha256Hex;
    const failed = results.find((r) => !r.ok);
    return { failed: failed === undefined ? null : `${failed.check}:${failed.subject}`, hash };
  }
}
