// The environment of the commerce adapter tests (package B09, implementation mandate M1): one real PostgreSQL 17 cluster per test
// file (the harness), the runtime logins, two activated agencies with their clients, an offered HUBSPOT capability, the platform's
// qualified merchant and fiscal issuer routes, a corporate owner with an ACTIVE KAURO_OWNER grant and each agency's reviewed fiscal
// profile. The operations under test run through the commerce unit of work (h.commerce: TENANT and OPERATOR on the request-handler
// pool, SERVICE on the payment-service pool), with B06's PgEventPublisher and outbox; setup goes through the adapter-driven fixtures
// of commerce-support.ts.
import assert from "node:assert/strict";
import type { Client } from "pg";
import {
  commerceVersionEventType,
  consumersOf,
  isDomainFailure,
  type CommerceAggregateKind,
  type CommerceVersionChange,
  type DomainEventRecord,
  type DomainFailure,
  type UserId,
} from "@kauro/domain";
import { start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { activateAgency, approvedSubject, createdOrder, fiscalProfile, grantKauroOwner, issuedQuote, observedCapture, qualifiedRoutes, type OrderFixture, type QuoteFixture, type Routes, type Treatment } from "./commerce-support.js";
import { project } from "./support.js";

export interface CommerceEnv {
  readonly h: Harness;
  readonly app: Client;
  readonly control: Client;
  readonly assurance: Client;
  readonly validator: Client;
  readonly payment: Client;
  /** A corporate person holding an ACTIVE KAURO_OWNER grant. */
  readonly kora: UserId;
  readonly koraGrant: string;
  /** Agency A (reviewed EXEMPT_EXPORT profile) and agency B (reviewed DOMESTIC_TAXABLE profile), both ACTIVE. */
  readonly A: AgencyFixture;
  readonly B: AgencyFixture;
  readonly clients: ReadonlyMap<string, string>;
  readonly profiles: Map<string, string>;
  readonly treatments: ReadonlyMap<string, Treatment>;
  readonly hubspot: string;
  readonly routes: Routes;
}

export async function openCommerceEnv(tag: string): Promise<CommerceEnv> {
  const h = await start();
  const app = await h.pg.connect("kauro_app_test");
  const control = await h.pg.connect("kauro_control_test");
  const assurance = await h.pg.connect("kauro_assurance_test");
  const validator = await h.pg.connect("kauro_validator_test");
  const payment = await h.pg.connect("kauro_payment_test");
  const kora = await h.person(`${tag}-kora`);
  const A = await h.createAgency(await h.person(`${tag}-alice`), `${tag} A`);
  const B = await h.createAgency(await h.person(`${tag}-bob`), `${tag} B`);
  await activateAgency(app, A);
  await activateAgency(app, B);
  const clients = new Map([
    [A.agencyId as string, await h.endClient(A, await h.processingAuthority(A), "Client A")],
    [B.agencyId as string, await h.endClient(B, await h.processingAuthority(B), "Client B")],
  ]);
  const hubspot = await h.offeredCapability("HUBSPOT");
  const routes = await qualifiedRoutes(control);
  const koraGrant = await grantKauroOwner(control, kora);
  const treatments = new Map<string, Treatment>([
    [A.agencyId, "EXEMPT_EXPORT"],
    [B.agencyId, "DOMESTIC_TAXABLE"],
  ]);
  const profiles = new Map([
    [A.agencyId as string, await fiscalProfile(app, kora, A, routes.issuerRef, "EXEMPT_EXPORT")],
    [B.agencyId as string, await fiscalProfile(app, kora, B, routes.issuerRef, "DOMESTIC_TAXABLE")],
  ]);
  return { h, app, control, assurance, validator, payment, kora, koraGrant, A, B, clients, profiles, treatments, hubspot, routes };
}

export async function closeCommerceEnv(env: CommerceEnv): Promise<void> {
  for (const c of [env.app, env.control, env.assurance, env.validator, env.payment]) await c.end();
  await env.h.stop();
}

export function failure(e: unknown): DomainFailure {
  assert.ok(isDomainFailure(e), `expected a DomainFailure, got ${String(e)}`);
  return e;
}

/** A HUBSPOT project of the agency with an approved subject and an issued R2-077 quote under the agency's profile. */
export async function quoted(env: CommerceEnv, ag: AgencyFixture, seed: string, clientId?: string): Promise<QuoteFixture> {
  const { projectId } = await project(env.app, ag, clientId ?? env.clients.get(ag.agencyId)!, env.hubspot, "HUBSPOT");
  const subject = await approvedSubject({ app: env.app, control: env.control }, env.validator, env.assurance, ag, projectId, seed);
  return issuedQuote(env.app, ag, subject, env.profiles.get(ag.agencyId)!, env.routes.issuerRef, { treatment: env.treatments.get(ag.agencyId)! });
}

/** A purchase paid by one capture that alone pays it, with its entitlement (the payment service's settle step). */
export async function paid(env: CommerceEnv, ag: AgencyFixture, seed: string, clientId?: string): Promise<{ readonly order: OrderFixture; readonly captureId: string; readonly authorizationId: string }> {
  const quote = await quoted(env, ag, seed, clientId);
  const order = await createdOrder(env.app, ag, quote, env.routes, { payment: env.payment });
  const done = await observedCapture(env.payment, ag, order, env.routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, env.hubspot);
  return { order, captureId: done.captureId, authorizationId: done.authorizationId as string };
}

/** One expected version event: the aggregate it records, its version, and the change commerceVersionEventType maps to a type. */
export type ExpectedVersion = readonly [kind: CommerceAggregateKind, aggregateId: string, version: number, change: CommerceVersionChange];

/**
 * Every event a unit of work published is the one of its version (D-EVT-B3): the aggregate and version it records, the type
 * commerceVersionEventType names for the change, and outbox records for exactly the registered consumers of that type (read by the
 * superuser oracle).
 */
export async function assertVersionEvents(h: Harness, events: ReadonlyArray<DomainEventRecord>, expected: ReadonlyArray<ExpectedVersion>): Promise<void> {
  assert.deepEqual(
    events.map((e) => `${e.aggregateKind}:${e.aggregateId}:${e.aggregateVersion}`),
    expected.map(([kind, id, version]) => `${kind}:${id}:${version}`),
    "the events of the unit of work, in order",
  );
  for (const [i, [kind, , , change]] of expected.entries()) {
    const event = events[i]!;
    assert.equal(event.eventType, commerceVersionEventType(kind, change), `${kind} v${event.aggregateVersion}`);
    const outbox = await h.oracle.query<{ consumer: string }>("SELECT consumer FROM kauro.outbox_records WHERE event_id = $1 ORDER BY consumer", [event.eventId]);
    assert.deepEqual(
      outbox.rows.map((r) => r.consumer),
      [...consumersOf(event.eventType)].sort(),
      `${event.eventType}: the outbox records go to exactly its subscribers`,
    );
  }
}
