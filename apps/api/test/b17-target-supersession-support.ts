// Target-contract fixtures under migration 0084 (docs/design/B15-B17-B18-local-plan.md section 5 M4 births (a)-(c)): a request session
// bears a contract only as a DRAFT, so a confirmed-at-birth fixture is the superuser oracle's insert; a contract is superseded only by a
// later confirmed observation of the same instance, confirmed in the same transaction (CMD019's shape), and a project holds at most one
// current contract. `confirmedContract` and `supersede` write exactly that, through the oracle; `supersedeIn` writes it on a caller's
// open transaction (a tenant writer of a RACE test that must hold the contract's transition half to COMMIT).
import { createHash, randomBytes } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { createIdGenerator, toUtcInstant } from "@kauro/domain";

/** Any open session: a pg client, a pool client or a held writer (writers.ts). */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult<R>>;
}

const ids = createIdGenerator({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() }, (n) => new Uint8Array(randomBytes(n)));
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface ContractRef {
  readonly agencyId: string;
  readonly contractId: string;
}

export interface Superseder {
  readonly contractId: string;
  readonly targetContractHash: string;
}

/** Runs fn in one oracle transaction (commits when fn returns, rolls back and rethrows otherwise). */
async function inOracle<T>(oracle: Queryable, fn: () => Promise<T>): Promise<T> {
  await oracle.query("BEGIN");
  try {
    const out = await fn();
    await oracle.query("COMMIT");
    return out;
  } catch (e) {
    await oracle.query("ROLLBACK");
    throw e;
  }
}

const INSERT = `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, 'R2-INITIAL', '[]'::jsonb, $7, $8, $9, NULL, $10, 'R2-INITIAL', now())`;

/**
 * Writes, on the caller's open transaction, CMD019's supersession of `old`: a DRAFT observation of the same project, mode and instance,
 * observed after `old`, its confirmation evidence, `old` superseded by it and it confirmed at the transaction's server instant.
 * `membershipId` confirms (the session's own membership when `c` is a tenant writer).
 */
export async function supersedeIn(c: Queryable, old: ContractRef, membershipId: string, byNew: { readonly targetContractHash?: string; readonly contractId?: string } = {}): Promise<Superseder> {
  const r = await c.query<{ project_id: string; mode: string; instance_id: string; observed_at: Date }>(
    "SELECT project_id, mode, instance_id, observed_at FROM kauro.target_contracts WHERE agency_id = $1 AND contract_id = $2",
    [old.agencyId, old.contractId],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error(`target contract ${old.contractId} is not visible`);
  const contractId = byNew.contractId ?? ids.next();
  const targetContractHash = byNew.targetContractHash ?? sha(`superseder-${contractId}`);
  const observedAt = new Date(Math.max(Date.now(), row.observed_at.getTime() + 1));
  await c.query(INSERT, [contractId, old.agencyId, row.project_id, row.mode, row.instance_id, ids.next(), sha("bundle"), targetContractHash, observedAt, sha(`authority-${contractId}`)]);
  const evidenceId = ids.next();
  await c.query(
    `INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id)
     VALUES ($1, $2, $3, 'CONFIRMATION_EVIDENCE', $4, $5, '{}'::jsonb, $6, $7)`,
    [evidenceId, old.agencyId, row.project_id, row.mode, row.instance_id, sha(`confirmation-${contractId}`), membershipId],
  );
  await c.query("UPDATE kauro.target_contracts SET superseded_at = now(), superseded_by_contract_id = $3, version = version + 1 WHERE agency_id = $1 AND contract_id = $2", [old.agencyId, old.contractId, contractId]);
  await c.query(
    "UPDATE kauro.target_contracts SET confirmed_at = kauro.server_now(), confirmed_by_membership_id = $3, confirmation_evidence_ref = $4, version = version + 1 WHERE agency_id = $1 AND contract_id = $2",
    [old.agencyId, contractId, membershipId, evidenceId],
  );
  return { contractId, targetContractHash };
}

/** `old` superseded through the oracle by a newer confirmed observation (returned; it is the project's current contract). */
export async function supersede(oracle: Queryable, old: ContractRef, membershipId: string, byNew: { readonly targetContractHash?: string } = {}): Promise<Superseder> {
  return inOracle(oracle, () => supersedeIn(oracle, old, membershipId, byNew));
}

/** Every current contract of the project superseded (through the oracle); the superseders, one per contract. */
export async function supersedeProject(oracle: Queryable, agencyId: string, projectId: string, membershipId: string): Promise<Superseder[]> {
  const r = await oracle.query<{ contract_id: string }>(
    "SELECT contract_id FROM kauro.target_contracts WHERE agency_id = $1 AND project_id = $2 AND confirmed_at IS NOT NULL AND superseded_at IS NULL",
    [agencyId, projectId],
  );
  const out: Superseder[] = [];
  for (const x of r.rows) out.push(await supersede(oracle, { agencyId, contractId: x.contract_id }, membershipId));
  return out;
}

/**
 * A confirmed contract of the project, born through the oracle (a request session bears only drafts): a re-observation of the
 * project's current instance supersedes the current contract in the same transaction; a first observation opens a new instance.
 */
export async function confirmedContract(
  oracle: Queryable,
  input: { readonly agencyId: string; readonly projectId: string; readonly mode: string; readonly membershipId: string; readonly targetContractHash: string; readonly contractId?: string },
): Promise<Superseder> {
  return inOracle(oracle, async () => {
    const current = await oracle.query<{ contract_id: string }>(
      "SELECT contract_id FROM kauro.target_contracts WHERE agency_id = $1 AND project_id = $2 AND confirmed_at IS NOT NULL AND superseded_at IS NULL",
      [input.agencyId, input.projectId],
    );
    const head = current.rows[0];
    if (head !== undefined) return supersedeIn(oracle, { agencyId: input.agencyId, contractId: head.contract_id }, input.membershipId, { targetContractHash: input.targetContractHash, ...(input.contractId !== undefined ? { contractId: input.contractId } : {}) });
    const contractId = input.contractId ?? ids.next();
    const instanceId = ids.next();
    // the oracle's confirmed birth (the request session's restrictive birth policy does not bind the superuser)
    await oracle.query(INSERT.replace("$9, NULL,", "$9, now(),"), [contractId, input.agencyId, input.projectId, input.mode, instanceId, ids.next(), sha("bundle"), input.targetContractHash, new Date(), sha(`authority-${contractId}`)]);
    return { contractId, targetContractHash: input.targetContractHash };
  });
}
