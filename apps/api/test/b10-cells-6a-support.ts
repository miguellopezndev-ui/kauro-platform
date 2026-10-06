// What the 6a failure-cell files share beyond b10-cells-support.ts (kit-owned): the price policy a routed unit of work needs to issue a quote, and
// the observation of a backend blocked by a holder that the harness cannot route (the payment service's own pool).
import type { Client } from "pg";
import type { PricePolicy } from "@kauro/domain";
import { registryPricePolicy } from "@kauro/domain";
import { PgRecurrenceRepository } from "@kauro/persistence";

/**
 * HARNESS GAP, reported to the kit lane (apps/api/test/fault-support.ts, RoutedFactory.createUnitOfWork): a unit of work routed over a harness
 * connection is built with NO price policy (`[] as never`), where the api's own factory binds the registry's (PgCommercialUnitOfWorkFactory:
 * `deps.pricePolicies ?? [registryPricePolicy()]`). CMD027's issuance core then answers INTEGRITY_FAILURE "price policy ... is not known to this
 * unit of work" on every routed CreateQuote. Until the routing binds it, a recurrence repository built with an EMPTY policy map receives the
 * registry policy the deployment binds — the same object the production factory hands it, nothing more; a repository that has its policies
 * (every unrouted unit) is untouched.
 */
// TODO(b10/kit 64741e0): delete this workaround and its call sites (b10-failure-cells-quote/agency/replacement before hooks) once the kit
// commit that fixes fault-support.ts at the source (the routed unit binds the registry price policy) is in main: after it the patch is a
// no-op (`policies.size > 0`). It monkeypatches the production class prototype for the whole test process, which is why it must not outlive
// the kit.
export function routedUnitsIssueWithTheRegistryPolicy(): void {
  const proto = PgRecurrenceRepository.prototype as unknown as { issueQuote: (...a: unknown[]) => Promise<unknown>; __b10g6a?: true };
  if (proto.__b10g6a === true) return;
  const issueQuote = proto.issueQuote;
  proto.issueQuote = function (this: { readonly policies: Map<string, PricePolicy> }, ...a: unknown[]) {
    if (this.policies.size === 0) {
      const policy = registryPricePolicy();
      this.policies.set(policy.version, policy);
    }
    return issueQuote.apply(this, a);
  };
  proto.__b10g6a = true;
}

/**
 * Observes, in pg_stat_activity and pg_blocking_pids, a backend of `applicationPrefix` blocked by `holderPid` (a unit the harness cannot route
 * over its own connection, such as the payment service's SERVICE unit of a re-binding): its application name and the statement it waits in.
 */
export async function blockedBy(oracle: Client, holderPid: number, applicationPrefix: string, limitMs = 10_000): Promise<{ readonly application: string; readonly query: string }> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    await oracle.query("SELECT pg_stat_clear_snapshot()");
    const r = await oracle.query<{ application_name: string; query: string }>(
      "SELECT application_name, query FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid)) AND wait_event_type = 'Lock' AND application_name LIKE $2 || '%'",
      [holderPid, applicationPrefix],
    );
    if (r.rows[0] !== undefined) return { application: r.rows[0].application_name, query: r.rows[0].query };
    if (Date.now() > deadline) throw new Error(`no backend of ${applicationPrefix} was seen waiting on backend ${holderPid}'s lock within ${limitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
