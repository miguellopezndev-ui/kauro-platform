/**
 * The provider ingress's own security facts (package B09, stage-2 mandate M3; D-FACT-B1; migration 0009
 * security_events_ingress_write): 08 "Threat model and assets" names the provider webhook to inbox as a trust boundary, and "every
 * boundary has a schema, identity, authorization predicate, replay behavior and audit event". The webhook route (CMD030) records
 * the denial of a delivery whose signature, freshness or environment does not verify — ANONYMOUS, since an unverified sender is
 * nobody — and the acceptance of an authenticated provider event — actor SERVICE, the provider ingress's identity — in the
 * ingress's own runtime group (kauro_ingress), in a short transaction of its own like the other evidence recorders (evidence.ts):
 * the request handlers' role and the payment service's never write these facts, and they belong to no agency's stream.
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, type CorrelationId, type IdGenerator } from "@kauro/domain";
import type { KauroPool } from "./pool.js";
import { execute } from "./sql.js";

/** One decision of the provider ingress on CMD030. */
export interface IngressFact {
  readonly outcome: "ALLOW" | "DENY";
  /** ANONYMOUS for a delivery that did not verify (a DENY only); the verified ingress's service identity otherwise. */
  readonly actor: { readonly kind: "ANONYMOUS" } | { readonly kind: "SERVICE"; readonly serviceId: string };
  /** A safe token (PROVIDER_SIGNATURE_INVALID, PROVIDER_EVENT_AUTHENTICATED, ...). */
  readonly reasonCode: string;
  readonly policyVersion: string;
  readonly correlationId: CorrelationId;
  readonly occurredAt: UtcInstant;
}

/** The recorder's port, as the api's webhook route consumes it. */
export interface IngressFactRecorder {
  record(fact: IngressFact): Promise<void>;
}

export class PgIngressFactRecorder implements IngressFactRecorder {
  constructor(
    private readonly pool: KauroPool,
    private readonly ids: IdGenerator,
  ) {}

  async record(fact: IngressFact): Promise<void> {
    if (fact.actor.kind === "ANONYMOUS" && fact.outcome !== "DENY") throw new DomainFailure("INTEGRITY_FAILURE", "nobody is allowed anything anonymously");
    const { client, connection } = await this.pool.acquire();
    if (connection.role !== "kauro_ingress") {
      client.release();
      throw new DomainFailure("INTEGRITY_FAILURE", `the ingress's facts are recorded only by kauro_ingress; this pool is ${connection.role} (08 Database isolation)`);
    }
    let destroy: Error | undefined;
    try {
      await execute(client, "BEGIN");
      await execute(
        client,
        `INSERT INTO kauro.security_events (security_event_id, agency_id, requested_agency_id, actor_kind, actor_id, action, outcome, reason_code, policy_version, assurance_class, correlation_id, occurred_at)
         VALUES ($1, NULL, NULL, $2, $3, 'CMD030', $4, $5, $6, 'NONE', $7, $8)`,
        [this.ids.next(), fact.actor.kind, fact.actor.kind === "SERVICE" ? fact.actor.serviceId : null, fact.outcome, fact.reasonCode, fact.policyVersion, fact.correlationId, fact.occurredAt],
      );
      const commit = await execute(client, "COMMIT");
      if (commit.command !== "COMMIT") throw new DomainFailure("INTEGRITY_FAILURE", "the ingress fact's transaction was aborted and did not commit");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw e;
    } finally {
      client.release(destroy);
    }
  }
}
