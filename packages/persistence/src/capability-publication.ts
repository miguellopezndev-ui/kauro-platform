/**
 * The capability publication over `pg` (B11 D-PUB-1; 02 "Capability publication contract"): the MODE capabilities that admit real
 * customers, read by a caller with no session. The runtime role reads `kauro.capabilities` through a policy that shows every row
 * (the table is platform-wide); what is published is decided here, in one predicate:
 *
 *   kind MODE, state AVAILABLE_LIMITED or AVAILABLE, and an instant it became valid.
 *
 * A DESIGN, implemented, qualified or suspended capability is never listed, nor is a capability that is not a mode (an object,
 * operation, tool or envelope: internal facts). A row that is offered but carries no `valid_from` is hidden rather than published
 * without its instant. The projection is public fields only — never the profile hash, the evidence hashes or the review trigger.
 * The partial unique index of one offered capability per mode bounds the answer to one row per mode.
 */
import type { CapabilityId, CapabilityPublication, PublishedCapability, ServiceMode } from "@kauro/domain";
import type { KauroPool } from "./pool.js";
import { inRuntimeTransaction } from "./runtime-transaction.js";
import { execute, instant, text } from "./sql.js";

interface PublishedRow {
  capability_id: string;
  mode: string;
  version: string;
  state: string;
  valid_from: Date;
}

export class PgCapabilityPublication implements CapabilityPublication {
  constructor(private readonly pool: KauroPool) {}

  listPublishable(): Promise<ReadonlyArray<PublishedCapability>> {
    return inRuntimeTransaction(
      this.pool,
      async (client) => {
        const r = await execute<PublishedRow>(
          client,
          `SELECT capability_id, mode, version, state, valid_from FROM kauro.capabilities
            WHERE kind = 'MODE' AND state IN ('AVAILABLE_LIMITED', 'AVAILABLE') AND valid_from IS NOT NULL
            ORDER BY mode`,
        );
        return r.rows.map((row): PublishedCapability => {
          const state = text(row.state);
          if (state !== "AVAILABLE_LIMITED" && state !== "AVAILABLE") throw new TypeError("the publication predicate returned a state that is not offered");
          return {
            capabilityId: text(row.capability_id) as CapabilityId,
            mode: text(row.mode) as ServiceMode,
            version: text(row.version),
            state,
            validFrom: instant(row.valid_from),
          };
        });
      },
      { readOnly: true },
    );
  }
}
