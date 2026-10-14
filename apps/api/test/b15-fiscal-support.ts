/**
 * The world of CMD035 IssueTaxDocument (package B15 lane L6; docs/design/B15-B17-B18-local-plan.md sections 2-5, M6, M15-M21): the
 * payment world of payment-support.ts (a real PostgreSQL 17, the payment service's verified pools, M1's commerce unit of work) plus
 * the issuance runtime over the payment pool's commerce factory, bound to a labelled contract fake of the issuance route
 * (b15-fiscal-pages-fake.ts; CONTRACT_FAKE, SIMULATED). Interleavings are fixed by hold points and by lock waits observed in
 * pg_stat_activity, under bounded polls; nothing sleeps on a guess.
 */
import type { Client } from "pg";
import type { FiscalIssuancePoint, FiscalIssuanceRuntime, FiscalIssuanceRoute, IssueTaxDocumentOutcome, IssueTaxDocumentRequest } from "@kauro/application";
import { issueTaxDocument } from "@kauro/application";
import type { CorrelationId, FiscalIssuerRef, FiscalProfileId, TaxDocumentId } from "@kauro/domain";
import { LOCK_WAIT_POLL_ATTEMPTS, LOCK_WAIT_POLL_INTERVAL_MS, ROLES } from "@kauro/persistence/testing";
import { fiscalRouteFake, type FiscalRouteFake } from "./b15-fiscal-pages-fake.js";
import { dispatch, paid, paymentWorld, rows, SimulatedCrash, type PaymentWorld } from "./payment-support.js";
import { clock, ids, sha } from "./support.js";
import { toUtcInstant } from "@kauro/domain";

export const SUBMIT_WINDOW_MS = 60_000;

export interface HoldHandle {
  readonly reached: Promise<void>;
  release(): void;
}

/** One-shot hold points of the issuance protocol, keyed by point and document: a crash, or a wait until released. */
export class FiscalHolds {
  readonly #armed = new Map<string, { readonly crash: boolean; readonly reached: () => void; readonly release: Promise<void> }>();

  arm(point: string, documentId: string, mode: "CRASH" | "WAIT"): HoldHandle {
    const key = `${point}:${documentId}`;
    if (this.#armed.has(key)) throw new Error(`hold ${key} is already armed`);
    let reached: () => void = () => undefined;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#armed.set(key, { crash: mode === "CRASH", reached, release: releasePromise });
    return { reached: reachedPromise, release };
  }

  async pass(point: string, documentId: string): Promise<void> {
    const key = `${point}:${documentId}`;
    const armed = this.#armed.get(key);
    if (armed === undefined) return;
    this.#armed.delete(key);
    armed.reached();
    if (armed.crash) throw new SimulatedCrash(key);
    await armed.release;
  }

  clear(): void {
    this.#armed.clear();
  }
}

export interface FiscalWorld {
  readonly pw: PaymentWorld;
  readonly route: FiscalRouteFake;
  readonly routes: Map<string, FiscalIssuanceRoute>;
  readonly holds: FiscalHolds;
  readonly rt: FiscalIssuanceRuntime;
  stop(): Promise<void>;
}

export async function fiscalWorld(): Promise<FiscalWorld> {
  const pw = await paymentWorld();
  const route = fiscalRouteFake({ bridge: pw.fiscalBridge, issuerRef: pw.issuerRef });
  const routes = new Map<string, FiscalIssuanceRoute>([[pw.issuerRef, route]]);
  const holds = new FiscalHolds();
  const rt: FiscalIssuanceRuntime = {
    unitOfWork: pw.pools.commerce,
    serviceId: "fiscal-service",
    environment: "LOCAL",
    route: (ref) => routes.get(ref) ?? null,
    submitWindowMs: SUBMIT_WINDOW_MS,
    hold: (point: FiscalIssuancePoint, documentId) => holds.pass(point, documentId),
  };
  return { pw, route, routes, holds, rt, stop: () => pw.stop() };
}

export type Doc = {
  readonly document_id: string;
  readonly kind: string;
  readonly state: string;
  readonly version: number;
  readonly order_id: string;
  readonly capture_id: string;
  readonly fiscal_profile_id: string;
  readonly issuer_ref: string;
  readonly blocked_reason: string | null;
  readonly issue_request_hash: string | null;
  readonly provider_document_id: string | null;
  readonly legal_number: string | null;
  readonly fiscal_status: string | null;
  readonly verification_ref: string | null;
  readonly bridge_action_ref: string | null;
  readonly rejection_code: string | null;
  readonly submit_deadline_at: Date | null;
  readonly corrects_document_id: string | null;
};

const DOC_COLUMNS =
  "document_id, kind, state, version::int AS version, order_id, capture_id, fiscal_profile_id, issuer_ref, blocked_reason, issue_request_hash, provider_document_id, legal_number, fiscal_status, verification_ref, bridge_action_ref, rejection_code, submit_deadline_at, corrects_document_id";

export async function doc(fw: FiscalWorld, documentId: string): Promise<Doc> {
  const r = await rows<Doc>(fw.pw, `SELECT ${DOC_COLUMNS} FROM kauro.tax_documents WHERE document_id = $1`, [documentId]);
  if (r[0] === undefined) throw new Error(`no tax document ${documentId}`);
  return r[0];
}

export async function docsOfCapture(fw: FiscalWorld, captureId: string): Promise<Doc[]> {
  return rows<Doc>(fw.pw, `SELECT ${DOC_COLUMNS} FROM kauro.tax_documents WHERE capture_id = $1 ORDER BY created_at, document_id`, [captureId]);
}

/** The event types a document published, in version order. */
export async function eventsOf(fw: FiscalWorld, documentId: string): Promise<string[]> {
  return (await rows<{ event_type: string }>(fw.pw, "SELECT event_type FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [documentId])).map((r) => r.event_type);
}

/** The CMD035 journal rows of a key (state). */
export async function journalOf(fw: FiscalWorld, key: string): Promise<string[]> {
  return (await rows<{ state: string }>(fw.pw, "SELECT state FROM kauro.command_journal WHERE operation = 'CMD035' AND idempotency_key = $1", [key])).map((r) => r.state);
}

/** A purchase paid and its invoice drafted and validated by the FISCAL consumer (the CMD035 precondition). */
export async function validatedInvoice(fw: FiscalWorld, seed: string): Promise<Doc & { readonly purchase: Awaited<ReturnType<typeof paid>> }> {
  const purchase = await paid(fw.pw, seed);
  await dispatch(fw.pw, "FISCAL");
  const docs = await docsOfCapture(fw, purchase.captureId);
  const invoice = docs.find((d) => d.kind === "INVOICE");
  if (invoice === undefined || invoice.state !== "VALIDATED") throw new Error(`the invoice of ${seed} was not validated: ${JSON.stringify(docs)}`);
  return { ...invoice, purchase };
}

export function request(d: Pick<Doc, "document_id" | "version" | "fiscal_profile_id" | "order_id">, key: string, overrides: Partial<IssueTaxDocumentRequest> = {}): IssueTaxDocumentRequest {
  return {
    idempotencyKey: key,
    correlationId: ids.next() as CorrelationId,
    documentId: d.document_id as TaxDocumentId,
    expectedVersion: d.version,
    fiscalProfileId: d.fiscal_profile_id as FiscalProfileId,
    scope: { kind: "PAYMENT_ORDER", key: d.order_id },
    ...overrides,
  };
}

export function issue(fw: FiscalWorld, req: IssueTaxDocumentRequest, rt: FiscalIssuanceRuntime = fw.rt): Promise<IssueTaxDocumentOutcome> {
  return issueTaxDocument(rt, req);
}

/** `${kind} ${code|status} ${reason|state}` of an outcome, for compact assertions. */
export function brief(o: IssueTaxDocumentOutcome): string {
  return o.kind === "REFUSED" ? `REFUSED ${o.code} ${o.reason}${o.retryable ? " retryable" : ""}` : `ANSWERED ${o.status} ${o.view.state}${o.replayed ? " replayed" : ""}`;
}

/** A superuser session holding locks in its own transaction (the opposing writer or holder of a cell). */
export interface Holder {
  readonly client: Client;
  readonly pid: number;
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function holder(fw: FiscalWorld): Promise<Holder> {
  const client = await fw.pw.w.h.pg.connect("postgres");
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  await client.query("BEGIN");
  const end = async (sql: string) => {
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  return {
    client,
    pid,
    async query(sql, params = []) {
      await client.query(sql, [...params]);
    },
    commit: () => end("COMMIT"),
    rollback: () => end("ROLLBACK"),
  };
}

export const DOC_X_HALF = "SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.tax_documents', $1::uuid::text))";
export const DOC_S_HALF = "SELECT pg_advisory_xact_lock_shared(kauro.transition_key('kauro.tax_documents', $1::uuid::text))";
export const PROFILE_X_HALF = "SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.fiscal_profiles', $1::uuid::text))";
export const ISSUER_X_HALF = "SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.fiscal_issuers', $1::uuid::text))";

/**
 * Observes a backend of the payment login waiting on a lock while running a statement containing `fragment`, blocked by `holderPid`
 * when given; polled every LOCK_WAIT_POLL_INTERVAL_MS for at most LOCK_WAIT_POLL_ATTEMPTS polls. Fails when `settled()` turns true first.
 */
export async function seenWaiting(fw: FiscalWorld, fragment: string, what: string, options: { readonly holderPid?: number; readonly settled?: () => boolean; readonly login?: string | null } = {}): Promise<number> {
  const oracle = fw.pw.w.h.oracle;
  for (let i = 0; i < LOCK_WAIT_POLL_ATTEMPTS; i++) {
    if (options.settled?.() === true) throw new Error(`${what}: the waiter settled without waiting`);
    await oracle.query("SELECT pg_stat_clear_snapshot()");
    const r = await oracle.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE ($1::text IS NULL OR usename = $1) AND wait_event_type = 'Lock' AND query LIKE '%' || $2 || '%' AND ($3::int IS NULL OR $3::int = ANY (pg_blocking_pids(pid)))",
      [options.login === undefined ? ROLES.paymentLogin : options.login, fragment, options.holderPid ?? null],
    );
    if (r.rows[0] !== undefined) return r.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_POLL_INTERVAL_MS));
  }
  throw new Error(`${what}: no payment backend waited on a lock running ${fragment}`);
}

/** Tracks whether a promise settled (for seenWaiting's settled guard). */
export function tracked<T>(p: Promise<T>): { readonly promise: Promise<T>; settled(): boolean } {
  let done = false;
  const promise = p.finally(() => {
    done = true;
  });
  promise.catch(() => undefined);
  return { promise, settled: () => done };
}

/** Waits (bounded) until the database's effect clock is past `instant`. */
export async function dbPast(fw: FiscalWorld, instant: Date, limitMs = 10_000): Promise<void> {
  const oracle = fw.pw.w.h.oracle;
  for (let i = 0; i * LOCK_WAIT_POLL_INTERVAL_MS < limitMs; i++) {
    const r = await oracle.query<{ past: boolean }>("SELECT kauro.effect_now() > $1::timestamptz + interval '2 milliseconds' AS past", [instant]);
    if (r.rows[0]?.past === true) return;
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_POLL_INTERVAL_MS));
  }
  throw new Error(`the database clock never passed ${instant.toISOString()}`);
}

export async function issuerColumns(fw: FiscalWorld, ref: FiscalIssuerRef | string): Promise<Record<string, unknown>> {
  return (await rows(fw.pw, "SELECT route_state, legal_fact_status, numbering_authorization_ref, entitlement_evidence_hash, qualification_evidence_hashes, valid_from, valid_until FROM kauro.fiscal_issuers WHERE issuer_ref = $1", [ref]))[0]!;
}

/** Observes the backend `pid` (a holder session) waiting on a lock, under the same bounded poll. */
export async function pidWaiting(fw: FiscalWorld, pid: number, what: string): Promise<void> {
  const oracle = fw.pw.w.h.oracle;
  for (let i = 0; i < LOCK_WAIT_POLL_ATTEMPTS; i++) {
    await oracle.query("SELECT pg_stat_clear_snapshot()");
    const r = await oracle.query<{ waiting: boolean }>("SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1", [pid]);
    if (r.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_POLL_INTERVAL_MS));
  }
  throw new Error(`${what}: the session ${pid} never waited on a lock`);
}

export const ROW_LOCK = "FROM kauro.tax_documents WHERE document_id = $1 FOR NO KEY UPDATE";
export const DOC_X_WAIT = "pg_advisory_xact_lock(kauro.transition_key('kauro.tax_documents'";
export const DOC_S_WAIT = "kauro.await_transition('kauro.tax_documents'";
export const ISSUER_S_WAIT = "kauro.await_transition('kauro.fiscal_issuers'";
export const PROFILE_S_WAIT = "kauro.await_transition('kauro.fiscal_profiles'";

/** Agency A's current (unsuperseded) fiscal profile version. */
export async function currentProfileId(fw: FiscalWorld): Promise<FiscalProfileId> {
  return (await rows<{ profile_id: string }>(fw.pw, "SELECT profile_id FROM kauro.fiscal_profiles WHERE agency_id = $1 AND superseded_at IS NULL", [fw.pw.w.A.agencyId]))[0]!.profile_id as FiscalProfileId;
}

/**
 * A re-review of agency A's fiscal profile by the corporate owner in the finance scope it adopts (FiscalRepository.recordProfile): the
 * current version superseded by a successor naming `issuerRef` (default the world's issuer). `gate`, when given, is awaited inside the
 * unit of work after the write (the writer holds the profile's exclusive half until it resolves).
 */
export async function reReview(fw: FiscalWorld, input: { readonly treatment?: "REVIEW_REQUIRED" | "EXEMPT_EXPORT"; readonly issuerRef?: FiscalIssuerRef; readonly validFromMs?: number; readonly validUntilMs?: number; readonly gate?: () => Promise<void> } = {}): Promise<FiscalProfileId> {
  const { h, A } = fw.pw.w;
  const supersedes = await currentProfileId(fw);
  return h.commerce.run(h.operator(fw.pw.kora), async (uow) => {
    await uow.adoptFinanceScope(A.agencyId);
    const profileId = uow.ids.next() as FiscalProfileId;
    const reviewed = (input.treatment ?? "EXEMPT_EXPORT") === "EXEMPT_EXPORT";
    await uow.commerce.fiscal.recordProfile({
      profileId,
      agencyId: A.agencyId,
      operatorLegalRef: input.issuerRef ?? fw.pw.issuerRef,
      customerLegalRef: uow.ids.next(),
      serviceClassification: "Data services",
      territory: "Colombia and abroad",
      taxTreatment: reviewed ? "EXEMPT_EXPORT" : "REVIEW_REQUIRED",
      taxRule: reviewed ? "ZERO_REVIEWED" : "UNRESOLVED",
      taxRateBps: 0,
      evidenceHash: sha(`fiscal-evidence-${profileId}`),
      ...(reviewed ? { exportEvidenceHash: sha(`export-facts-${profileId}`), reviewedByUserId: fw.pw.kora } : {}),
      validFrom: toUtcInstant(input.validFromMs ?? clock.nowMs() - 3_600_000) as never,
      ...(input.validUntilMs !== undefined ? { validUntil: toUtcInstant(input.validUntilMs) as never } : {}),
      supersedesProfileId: supersedes,
      recordedAt: clock.now(),
    });
    await input.gate?.();
    return profileId;
  });
}

/** A purchase paid and its invoice drafted by the FISCAL consumer, in whatever state the consumer left it. */
export async function draftedInvoice(fw: FiscalWorld, seed: string): Promise<Doc & { readonly purchase: Awaited<ReturnType<typeof paid>> }> {
  const purchase = await paid(fw.pw, seed);
  await dispatch(fw.pw, "FISCAL");
  const invoice = (await docsOfCapture(fw, purchase.captureId)).find((d) => d.kind === "INVOICE");
  if (invoice === undefined) throw new Error(`no invoice of ${seed}`);
  return { ...invoice, purchase };
}

/** A gate a test opens: `reached` resolves when the work arrives, the work waits until `open()`. */
export function gate(): { readonly reached: Promise<void>; open(): void; pass(): Promise<void> } {
  let reach: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  let opened: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    opened = resolve;
  });
  return {
    reached,
    open: () => opened(),
    async pass() {
      reach();
      await released;
    },
  };
}
