/**
 * CMD101 SetBuyerType — POST /api/v1/agencies/{agencyId}/buyer-type — AGENCY_OWNER (package B11 lane A1; SCREENS-PLAN section 3 rows
 * "A1 SetBuyerType"; R2 A3 3.7: "the buyer type is answered once during onboarding, before the first quote", values agency | in-house,
 * it does not change the price; B11 design §5 W6: "OWNER, set once, content-idempotent"). Not a registry command: like the bank-route
 * commands it is served as an operational route (api/response-schemas OPERATIONAL_ROUTES) through the shared command pipeline
 * (runCommand: access, journal reserve or replay, the body, journal commit), journaled under the owner's identity in the agency.
 *
 * Order (FAILURE-MATRIX rows A1-T1..T4): authorize (an ACTIVE OWNER of the agency, after the membership's transition lock) → reserve
 * the journal entry → lock the agency row FOR NO KEY UPDATE (two owners answering at once serialize here, and so do the closure CMD043
 * and this command: whichever commits first decides) → the agency is DRAFT or ACTIVE (AGENCY_NOT_OPEN otherwise: after CLOSING no
 * buyer type is written) → the recorded row, if any: the same value answers 200 with the recorded view (content-idempotent, journaled,
 * nothing written), the other value is PRECONDITION_FAILED BUYER_TYPE_ALREADY_SET naming the recorded one (never overwritten) →
 * INSERT agency_buyer_types (v1) → agency_buyer_type.recorded.v1 → journal 201.
 *
 * The recorded value is what B10's BuyerTypeReader port answers (RecordedBuyerTypeReader): CMD027 CreateQuote refuses BUYER_TYPE_UNSET
 * until it exists, and CMD047 AcceptAttribution refuses an in-house tenant IN_HOUSE_NOT_ATTRIBUTABLE.
 */
import type { CommandId, UtcInstant } from "@kauro/contracts";
import type { AgencyId, CorrelationId, Environment, MembershipId, UnitOfWork, UserId } from "@kauro/domain";
import { AGENCY_OPEN_STATES, DomainFailure, INQUIRY_BUYER_TYPES, PreconditionFailure } from "@kauro/domain";
import type { RequestAuthority } from "../api/authority.js";
import type { AuthenticatedSubject, CommandEnvelope, CommandResult } from "../api/envelope.js";
import { runCommand, type CommandRuntime } from "../commands/runtime.js";
import type { BuyerType, BuyerTypeReader } from "../commercial/ports.js";
import type { PlatformBinding } from "../commerce/ports.js";
import type { CommandSpec } from "../ports/command-handler.js";

/** The two answers R2 A3 3.7 admits, as the onboarding form and the inquiry name them. */
export const AGENCY_BUYER_TYPES = INQUIRY_BUYER_TYPES;
export type RecordedBuyerType = (typeof AGENCY_BUYER_TYPES)[number];

/** The agency's recorded answer (migration 0062 agency_buyer_types). */
export interface BuyerTypeRecord {
  readonly agencyId: AgencyId;
  readonly buyerType: RecordedBuyerType;
  readonly forEconomicActivity: true;
  readonly recordedByUserId: UserId;
  readonly recordedByMembershipId: MembershipId;
  readonly recordedAt: UtcInstant;
  readonly version: 1;
}

/** The buyer-type table in the caller's unit of work (its row-level policies scope it). */
export interface BuyerTypeStore {
  get(agencyId: AgencyId): Promise<BuyerTypeRecord | null>;
  insert(record: BuyerTypeRecord): Promise<BuyerTypeRecord>;
}

export { PROJECT_DASHBOARD_FILTERS, PROJECT_PHASES, PROJECT_REQUIRED_ACTIONS } from "./dashboard-vocabulary.js";
export type { ProjectDashboardFilter, ProjectPhase, ProjectRequiredAction } from "./dashboard-vocabulary.js";
import type { ProjectDashboardFilter, ProjectPhase, ProjectRequiredAction } from "./dashboard-vocabulary.js";

/** One dashboard row as the query derives it from the project's durable facts, with its keyset position. */
export interface ProjectDashboardRow {
  readonly projectId: string;
  readonly clientId: string;
  readonly clientLabel: string;
  readonly mode: string;
  readonly revisionId: string;
  readonly revisionState: string;
  readonly phase: ProjectPhase;
  readonly requiredAction: ProjectRequiredAction;
  readonly deadline: UtcInstant | null;
  readonly lastActivityAt: UtcInstant;
  readonly version: number;
  /** The keyset position: the project's creation instant at full precision and its id. */
  readonly position: { readonly createdAt: string; readonly id: string };
}

/** The dashboard query in the caller's unit of work: newest first, strictly after `after` in (createdAt, projectId) descending order. */
export interface ProjectDashboardQuery {
  page(agencyId: AgencyId, filter: ProjectDashboardFilter, options: { readonly limit: number; readonly after?: { readonly createdAt: string; readonly id: string } }): Promise<ReadonlyArray<ProjectDashboardRow>>;
}

/** The stores of the agency app (bound by the api composition to the persistence adapters of the unit of work). */
export interface AgencyAppStores {
  buyerTypes(uow: UnitOfWork): BuyerTypeStore;
  dashboard(uow: UnitOfWork): ProjectDashboardQuery;
}

/** The agency's buyer type as every member reads it: unset (version 0, nulls) until the owner answers. */
export interface BuyerTypeView {
  readonly agencyId: string;
  readonly buyerType: RecordedBuyerType | null;
  readonly forEconomicActivity: true | null;
  readonly recordedAt: UtcInstant | null;
  readonly version: 0 | 1;
}

export function buyerTypeView(agencyId: AgencyId, record: BuyerTypeRecord | null): BuyerTypeView {
  if (record === null) return { agencyId, buyerType: null, forEconomicActivity: null, recordedAt: null, version: 0 };
  return { agencyId: record.agencyId, buyerType: record.buyerType, forEconomicActivity: true, recordedAt: record.recordedAt, version: 1 };
}

/** The wire value of the recorded type as B10's commercial domain names it. */
export function commercialBuyerTypeOf(recorded: RecordedBuyerType): BuyerType {
  return (recorded === "agency" ? "AGENCY" : "IN_HOUSE") as BuyerType;
}

export interface SetBuyerTypeBody {
  readonly buyerType: RecordedBuyerType;
  readonly forEconomicActivity: true;
}

export const SET_BUYER_TYPE: CommandSpec<SetBuyerTypeBody> = Object.freeze({
  id: "CMD101" as CommandId,
  name: "SetBuyerType",
  method: "POST",
  path: "/api/v1/agencies/{agencyId}/buyer-type",
  role: "AGENCY_OWNER",
  scope: "AGENCY_PATH",
  aggregateParam: "agencyId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["buyerType", "forEconomicActivity"],
} satisfies CommandSpec<SetBuyerTypeBody>);

/** The agency-app commands that are not registry commands: the authorizer adds their roles to the registry's (default deny otherwise). */
export const AGENCY_APP_COMMANDS = Object.freeze({ CMD101: SET_BUYER_TYPE } as const);

/** What the transport admitted for SetBuyerType (the person authenticated, the body validated by its closed schema). */
export interface AgencyAppCommandRequest<Body> {
  readonly environment: Environment;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly subject: AuthenticatedSubject;
  readonly path: Readonly<Record<string, string>>;
  readonly body: Body;
  readonly receivedAt: string;
  readonly authority?: RequestAuthority;
}

export interface AgencyAppHandlers {
  setBuyerType(request: AgencyAppCommandRequest<SetBuyerTypeBody>): Promise<CommandResult<BuyerTypeView>>;
}

const commercialState = (recorded: RecordedBuyerType): string => (recorded === "agency" ? "AGENCY" : "IN_HOUSE");

export function createAgencyAppHandlers(runtime: CommandRuntime, stores: AgencyAppStores): AgencyAppHandlers {
  return {
    setBuyerType(request) {
      const agencyId = request.path["agencyId"] as AgencyId;
      const envelope: CommandEnvelope<SetBuyerTypeBody> = {
        command: SET_BUYER_TYPE.id,
        environment: request.environment,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        userId: request.subject.identity.userId as UserId,
        subject: request.subject,
        agencyId,
        clientAddressHash: null,
        path: request.path,
        body: request.body,
        receivedAt: request.receivedAt,
        ...(request.authority === undefined ? {} : { authority: request.authority }),
      };
      return runCommand<SetBuyerTypeBody, BuyerTypeView>(SET_BUYER_TYPE, runtime, envelope, async (uow, ctx) => {
        const membership = ctx.membership;
        if (membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "SetBuyerType was authorized without a membership");
        // the agency row lock: a second owner's answer and the closure (CMD043) wait here until this unit ends (A1-T1, A1-T2)
        const agency = await uow.agencies.lock(agencyId);
        if (!agency) throw new DomainFailure("NOT_FOUND", "agency not visible");
        if (!AGENCY_OPEN_STATES.has(agency.state)) {
          throw new PreconditionFailure("AGENCY_NOT_OPEN", "the agency records no buyer type in its state", { currentState: agency.state, currentVersion: agency.version });
        }
        const store = stores.buyerTypes(uow);
        const existing = await store.get(agencyId);
        if (existing !== null) {
          if (existing.buyerType !== request.body.buyerType) {
            throw new PreconditionFailure("BUYER_TYPE_ALREADY_SET", "the agency's buyer type is already recorded with the other value", { currentState: commercialState(existing.buyerType), currentVersion: existing.version });
          }
          // the same answer again (a client that lost its key): the recorded view, nothing written
          return { status: 200, view: buyerTypeView(agencyId, existing), version: existing.version, resourceKind: "agency_buyer_type", resourceId: agencyId };
        }
        const record = await store.insert({
          agencyId,
          buyerType: request.body.buyerType,
          forEconomicActivity: true,
          recordedByUserId: envelope.userId,
          recordedByMembershipId: membership.membershipId,
          recordedAt: ctx.now,
          version: 1,
        });
        await uow.events.publish({
          aggregateKind: "agency_buyer_type",
          aggregateId: agencyId,
          aggregateVersion: record.version,
          agencyId,
          eventType: "agency_buyer_type.recorded.v1",
          actor: { kind: "USER", userId: envelope.userId },
          causationId: ctx.causationId,
          correlationId: envelope.correlationId,
          // the outbox carries machine tokens only: the commercial domain's AGENCY or IN_HOUSE
          payload: { agencyId, buyerType: commercialState(record.buyerType), forEconomicActivity: true, recordedByMembershipId: membership.membershipId },
        });
        return { status: 201, view: buyerTypeView(agencyId, record), version: record.version, resourceKind: "agency_buyer_type", resourceId: agencyId };
      });
    },
  };
}

/**
 * B10's BuyerTypeReader over the recorded answer (replaces UnrecordedBuyerTypeReader in the api composition): read in the caller's own
 * unit of work and row-level policies — the agency's tenant context for CMD027, the corporate owner's for CMD047 (migration 0062's
 * owner read policy) — and mapped to the commercial domain's values; null while no answer is recorded.
 */
export class RecordedBuyerTypeReader implements BuyerTypeReader {
  readonly binding: PlatformBinding = "PLATFORM";

  constructor(private readonly stores: Pick<AgencyAppStores, "buyerTypes">) {}

  async buyerTypeOf(uow: UnitOfWork, request: { readonly agencyId: AgencyId }): Promise<BuyerType | null> {
    const record = await this.stores.buyerTypes(uow).get(request.agencyId);
    return record === null ? null : commercialBuyerTypeOf(record.buyerType);
  }
}
