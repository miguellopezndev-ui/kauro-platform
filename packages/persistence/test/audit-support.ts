// The environment of the audit tests (package B08, mandate B08-PERSISTENCE-AUDIT): one real PostgreSQL 17 cluster per test file (the
// harness), the runtime logins as raw connections (the request handlers, the control plane, the validator), two agencies with an
// end client each and an offered CLEAN capability, and the subject of an audit — a project whose revision was sealed through B07's
// source lifecycle and whose target contract is confirmed and current. The platform's monthly model pool is funded by the control
// plane's operations act (@kauro/persistence/testing fundPlatformPool, Q8-1); every other write is the owning role's. The superuser
// oracle only reads.
import assert from "node:assert/strict";
import type { Client } from "pg";
import { isDomainFailure, type AgencyId, type AuditId, type CostGrantId, type MembershipId, type NewAudit, type ProjectId, type RevisionId, type TargetContractId } from "@kauro/domain";
import { start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { project, sealedSource, sha, targetContract, ids } from "./support.js";

export interface AuditEnv {
  readonly h: Harness;
  readonly app: Client;
  readonly control: Client;
  readonly validator: Client;
  readonly A: AgencyFixture;
  readonly B: AgencyFixture;
  readonly clients: ReadonlyMap<string, string>;
  readonly capability: string;
}

export async function openAuditEnv(tag: string): Promise<AuditEnv> {
  const h = await start();
  const app = await h.pg.connect("kauro_app_test");
  const control = await h.pg.connect("kauro_control_test");
  const validator = await h.pg.connect("kauro_validator_test");
  const A = await h.createAgency(await h.person(`${tag}-alice`), `${tag} A`);
  const B = await h.createAgency(await h.person(`${tag}-bob`), `${tag} B`);
  const clients = new Map([
    [A.agencyId as string, await h.endClient(A, await h.processingAuthority(A), "Client A")],
    [B.agencyId as string, await h.endClient(B, await h.processingAuthority(B), "Client B")],
  ]);
  const capability = await h.offeredCapability("CLEAN");
  return { h, app, control, validator, A, B, clients, capability };
}

export async function closeAuditEnv(env: AuditEnv): Promise<void> {
  for (const c of [env.app, env.control, env.validator]) await c.end();
  await env.h.stop();
}

/** What an audit is of: a sealed revision and a confirmed, current target contract of one project (D8-AUD-1). */
export interface AuditSubject {
  readonly projectId: string;
  readonly revisionId: string;
  readonly revisionHash: string;
  readonly contractId: string;
  readonly targetContractHash: string;
}

/** A fresh CLEAN project of the agency, its revision sealed an hour ago through the source lifecycle and its target confirmed. */
export async function auditSubject(env: AuditEnv, ag: AgencyFixture, seed: string): Promise<AuditSubject> {
  const { projectId } = await project(env.app, ag, env.clients.get(ag.agencyId)!, env.capability, "CLEAN");
  const source = await sealedSource({ app: env.app, control: env.control }, ag, projectId, seed, "SEALED", new Date(Date.now() - 3_600_000));
  const target = await targetContract(env.app, ag, projectId, seed);
  return { projectId, revisionId: source.revisionId, revisionHash: source.manifestHash, contractId: target.contractId, targetContractHash: target.bodyHash };
}

/** StartAudit's input for a subject (CMD020): the free AUDIT grant of the policy's ceiling unless told otherwise. */
export function newAudit(ag: AgencyFixture, subject: AuditSubject, overrides: Partial<NewAudit> = {}): NewAudit {
  return {
    auditId: ids.next() as AuditId,
    grantId: ids.next() as CostGrantId,
    agencyId: ag.agencyId as AgencyId,
    projectId: subject.projectId as ProjectId,
    revisionId: subject.revisionId as RevisionId,
    revisionHash: subject.revisionHash,
    targetContractId: subject.contractId as TargetContractId,
    targetContractHash: subject.targetContractHash,
    auditPolicyVersion: "R2-INITIAL",
    requestedByMembershipId: ag.ownerMembershipId as MembershipId,
    ceilingCents: 150n,
    priceProfileHash: sha("price-profile-r2"),
    ...overrides,
  };
}

/** The code and reason a unit of work's typed failure carries. */
export function failureOf(e: unknown): readonly [code: string, reason: string | undefined] {
  assert.ok(isDomainFailure(e), `expected a DomainFailure, got ${String(e)}`);
  return [e.code, e.reason];
}
