// Payments V1, lane NOTIF-AGENCYLESS-BANK: the corporate owner's agency-less bank events (the credit and statement-import aggregates of
// 0063, the route aggregate of 0046; BANK_CREDIT_EVENT_SUBSCRIPTIONS and BANK_ROUTE_EVENT_SUBSCRIPTIONS give each a NOTIFICATIONS record)
// reach the NOTIFICATIONS consumer through the real control-plane dispatcher (PgOutboxDispatcher, kauro_control on PostgreSQL 17) under an
// unbound SYSTEM context, instead of being dead-lettered EVENT_WITHOUT_AGENCY; the exemption is a closed list of event types and holds for
// NOTIFICATIONS only. The event is written by the owner's own session through the real publisher (PgEventPublisher under kauro_app,
// RLS-checked by 0063's owner policies). The NOTIFICATIONS consumer itself is a later package's: here a recording consumer stands in.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { ConsumerOutcome, OutboxConsumer } from "@kauro/application";
import { BANK_CREDIT_AGGREGATE_KINDS, BANK_CREDIT_EVENT_TYPES, BANK_ROUTE_EVENT_TYPES, type DomainEventRecord, type SystemContext, type UserId } from "@kauro/domain";
import { PgEventPublisher } from "@kauro/persistence";
import * as control from "../src/index.js";
import { clock, ids, startControlEnv, type ControlEnv } from "./support/env.js";

let env: ControlEnv;
let app: Awaited<ReturnType<ControlEnv["h"]["pg"]["connect"]>>;
let owner: UserId;

before(async () => {
  env = await startControlEnv();
  app = await env.h.pg.connect("kauro_app_test");
  owner = (await env.h.person("notif-agencyless-owner")) as UserId;
  await env.h.grantKauroOwner(owner);
});
after(async () => {
  await app.end();
  await env.stop();
});

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A statement import recorded by the owner in its own session (agency NULL) and its event, through the real publisher. */
async function ownerImport(): Promise<{ readonly eventId: string; readonly outboxId: string }> {
  const importId = ids.next();
  const evidenceHash = sha(`import-${importId}`);
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true)", [owner]);
    await app.query(
      "INSERT INTO kauro.statement_imports (import_id, environment, account_ref, artifact_ref, evidence_hash, normalizer_version, idempotency_key, imported_by) VALUES ($1, 'SANDBOX', $2, $3, $4, 'v1', $5, $6)",
      [importId, `acct-${importId}`, `artifact-${importId}`, evidenceHash, `import-key-${importId}`, owner],
    );
    const published = await new PgEventPublisher(app, ids, clock).publish({
      aggregateKind: "statement_import" as never,
      aggregateId: importId as never,
      aggregateVersion: 1,
      agencyId: null,
      eventType: "statement_import.recorded.v1" as never,
      actor: { kind: "USER", userId: owner },
      causationId: ids.next() as never,
      correlationId: ids.next() as never,
      payload: { importId, evidenceHash, lines: 1, newLines: 1 },
    });
    await app.query("COMMIT");
    const notif = published.outbox.find((o) => o.consumer === "NOTIFICATIONS");
    assert.ok(notif !== undefined, "the import's event has a NOTIFICATIONS record");
    return { eventId: published.event.eventId, outboxId: notif.outboxId };
  } catch (e) {
    await app.query("ROLLBACK");
    throw e;
  }
}

/** A NOTIFICATIONS consumer that records what it was handed. */
function recordingNotifications(): OutboxConsumer & { readonly seen: Array<{ readonly event: DomainEventRecord; readonly context: SystemContext }> } {
  const seen: Array<{ readonly event: DomainEventRecord; readonly context: SystemContext }> = [];
  return {
    consumer: "NOTIFICATIONS",
    seen,
    async handle(event: DomainEventRecord, context: SystemContext): Promise<ConsumerOutcome> {
      seen.push({ event, context });
      return { kind: "DONE" };
    },
  };
}

test("an agency-less statement-import event recorded by the owner reaches NOTIFICATIONS through the real dispatcher: its record is DELIVERED (never DEAD_LETTER EVENT_WITHOUT_AGENCY) and the consumer is handed the event under an unbound SYSTEM context", async () => {
  const { eventId, outboxId } = await ownerImport();
  const notifications = recordingNotifications();
  await env.plane.dispatcher.dispatchBatch(notifications, 100, clock.now());
  const settled = await env.h.oracle.query<{ state: string; last_error_code: string | null }>("SELECT state, last_error_code FROM kauro.outbox_records WHERE outbox_id = $1", [outboxId]);
  assert.deepEqual(settled.rows, [{ state: "DELIVERED", last_error_code: null }], "the owner's agency-less bank event is delivered to NOTIFICATIONS");
  const handed = notifications.seen.filter((s) => s.event.eventId === eventId);
  assert.equal(handed.length, 1, "the consumer was handed the event once");
  assert.equal(handed[0]!.event.agencyId, undefined);
  assert.equal(handed[0]!.context.kind, "SYSTEM");
  assert.equal(handed[0]!.context.agencyId, undefined, "an unbound SYSTEM context: no agency is invented for a platform-scope event");
  assert.equal(handed[0]!.context.serviceId, "notifications");
});

test("the exemption is a closed list: exactly the event types of the agency-less bank aggregates (bank_credit, statement_import, bank_route), never an agency's bank order or instruction event", () => {
  const agencyLessKinds = new Set<string>([...BANK_CREDIT_AGGREGATE_KINDS, "bank_route"]);
  const expected = [...BANK_CREDIT_EVENT_TYPES, ...BANK_ROUTE_EVENT_TYPES].filter((t) => agencyLessKinds.has(t.split(".")[0]!)).sort();
  const list = (control as Record<string, unknown>)["AGENCY_LESS_NOTIFICATION_EVENT_TYPES"] as ReadonlyArray<string> | undefined;
  assert.ok(Array.isArray(list), "the control plane exports its closed list AGENCY_LESS_NOTIFICATION_EVENT_TYPES");
  assert.deepEqual([...list].sort(), expected);
  assert.ok(!list.includes("bank_transfer_instruction.order_state_changed.v1"));
  assert.ok(!list.includes("bank_transfer_instruction.issued.v1"));
  assert.ok(Object.isFrozen(list));
});

test("an agency-less event of a listed type handed to another consumer is still dead-lettered EVENT_WITHOUT_AGENCY: the exemption is NOTIFICATIONS's only", async () => {
  const { eventId } = await ownerImport();
  // a second record of the same event for a consumer that does not subscribe to it: no product role may write it (the restrictive
  // subscriber policies of 0013/0021), so the superuser writes this one fixture row, to prove the dispatcher's own guard
  const otherId = ids.next();
  await env.h.oracle.query("INSERT INTO kauro.outbox_records (outbox_id, event_id, consumer, state, attempts, next_attempt_at, created_at, updated_at) VALUES ($1, $2, 'SELECTION_EVALUATION', 'PENDING', 0, now(), now(), now())", [otherId, eventId]);
  const other: OutboxConsumer = { consumer: "SELECTION_EVALUATION", handle: async () => ({ kind: "DONE" }) };
  await env.plane.dispatcher.dispatchBatch(other, 100, clock.now());
  const settled = await env.h.oracle.query<{ state: string; last_error_code: string | null }>("SELECT state, last_error_code FROM kauro.outbox_records WHERE outbox_id = $1", [otherId]);
  assert.deepEqual(settled.rows, [{ state: "DEAD_LETTER", last_error_code: "EVENT_WITHOUT_AGENCY" }]);
});
