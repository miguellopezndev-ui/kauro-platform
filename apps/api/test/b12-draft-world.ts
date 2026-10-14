// B12 lane L-DRAFT world (plan docs/design/B12-outreach-plan.md rev 4 section 9 "L-DRAFT"; adapter b12-draft-support.ts DraftWorld).
// One api over the harness (a real Postgres), a corporate owner with a fresh step-up, ACTIVE sellers with a verified GMAIL_API
// identity, prospects registered through CMD045, CURRENT resources published through the owner's PublishSalesResource route, and the
// section M controls. Fixtures are written by the runtime role that owns the row, under the real OPERATOR context (sales-support
// asOperator); the superuser only reads, except the control's switches (withoutSerializers), which restore everything they change.
//
// The members that belong to other lanes (the grant, the send, the dispatcher, the metrics, the opt-out, the activity, the sender and
// policy revocations, the seller termination and the capability suspension routes, the tenant record ids) answer NotBuilt until the lane
// that owns the route lands (the L-DRAFT cells that need them are marked todo in the test files with the member's name).
import type { Client } from "pg";
import { ContractFakeBuyerTypeReader, ContractFakeGmailSend } from "@kauro/application/testing";
import { OUTREACH_LOCK_KINDS, type UserId } from "@kauro/domain";
import { openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { FaultRouting, type SqlStep, type UnitLog } from "./fault-support.js";
import { prepareManifest, prepareTerminationTerms } from "./sellers-support.js";
import { asOperator, recordSeller, recordSourceEvidence, suppress as suppressFixture } from "./sales-support.js";
import { call as apiCall, clock, ids, outcome as outcomeOf, sha, world as makeWorld, type Person as WorldPerson, type Reply, type World } from "./support.js";
import {
  CO_GUARDS,
  completedOf,
  contentIdOf,
  keyOf,
  safeContent,
  type CoGuard,
  type Control,
  type DraftWorld,
  type LockName,
  type Person,
  type ProspectP,
  type ResourceP,
  type SellerP,
  type SenderP,
  type SenderRoute,
} from "./b12-draft-support.js";

/** A member of another lane's route: not built until that lane lands (the cell that needs it is marked todo). */
export class NotBuilt extends Error {
  constructor(member: string, lane: string) {
    super(`DraftWorld.${member} needs the ${lane} route, which is not built in this lane`);
    this.name = "NotBuilt";
  }
}
const notBuilt = (member: string, lane: string) => (): never => {
  throw new NotBuilt(member, lane);
};

/** The advisory kinds of a section L lock (L1 is the seller or corporate-role subject; L2 is the journal row and is never controlled). */
const KINDS_OF: Readonly<Record<LockName, ReadonlyArray<string>>> = {
  L1: ["kauro.sellers", "kauro.corporate_roles"],
  L2: [],
  L3: [OUTREACH_LOCK_KINDS.L3],
  L5: [OUTREACH_LOCK_KINDS.L5],
  L6: [OUTREACH_LOCK_KINDS.L6],
  L6p: [OUTREACH_LOCK_KINDS.L6p],
  L7: [OUTREACH_LOCK_KINDS.L7],
  L8: [OUTREACH_LOCK_KINDS.L8],
  L10: [OUTREACH_LOCK_KINDS.L10],
};
const FREE_SETTING = "kauro.b12_free";
const FREE = `string_to_array(coalesce(nullif(current_setting('${FREE_SETTING}', true), ''), ''), ',')`;
const CONTROLLED_KEY = `CREATE OR REPLACE FUNCTION kauro.transition_key(kind text, subject text) RETURNS bigint
  LANGUAGE sql VOLATILE STRICT SET search_path = pg_catalog AS
$$ SELECT CASE WHEN kind = ANY (${FREE}) THEN hashtextextended('free:' || random()::text || ':' || kind || ':' || subject, 0)
               ELSE hashtextextended('kauro.transition:' || kind || ':' || subject, 0) END $$`;
const CONTROLLED_REQUIRE = `CREATE OR REPLACE FUNCTION kauro.outreach_require_lock(kind text, subject text, mode text, what text) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS
$$
BEGIN
  IF kind = ANY (${FREE}) THEN RETURN; END IF;
  IF subject IS NULL OR NOT kauro.outreach_lock_held(kind, subject, mode) THEN
    RAISE EXCEPTION 'LOCK_NOT_HELD: % requires % % of %', what, kind, mode, coalesce(subject, '(none)') USING ERRCODE = 'KA096';
  END IF;
END
$$`;

type Login = "kauro_app_test" | "kauro_outreach_test" | "kauro_control_test" | "superuser";
type Role = "kauro_app" | "kauro_outreach" | "kauro_control";

export async function draftWorldOf(label: string): Promise<DraftWorld> {
  const faults = new FaultRouting();
  let standing: string | null = null;
  faults.stand = () => (standing === null ? null : { at: standing });
  const w: World = await makeWorld({ wrapUnitOfWork: (inner) => faults.wrap(inner), commercial: { buyerTypes: new ContractFakeBuyerTypeReader({ clock }) } });
  const h = w.h;
  const oracle: Client = h.oracle;
  const ownerPerson = await w.person(`${label}-corporate-owner`);
  await h.grantKauroOwner(ownerPerson.userId);
  const owner: Person = { userId: ownerPerson.userId, token: ownerPerson.token };
  const gmail = new ContractFakeGmailSend();
  const opened = new Set<{ readonly conn: HarnessConnection; readonly login: Login }>();
  let seq = 0;
  const uniq = (): string => `${label}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toLowerCase().replace(/[^a-z0-9-]/g, "");

  const call: DraftWorld["call"] = (c) => apiCall(w, { ...(c.method === undefined ? {} : { method: c.method }), url: c.url, token: c.token, key: c.key === undefined ? keyOf("auto") : c.key, agency: null, ...(c.body === undefined ? {} : { body: c.body }) });
  const stepUp = async (p: { readonly userId: string }): Promise<string> => {
    const person = [ownerPerson, ...extraPeople].find((x) => x.userId === p.userId);
    if (person === undefined) throw new Error(`no step-up for ${p.userId}: not a person of this world`);
    return w.stepUp(person);
  };
  const extraPeople: WorldPerson[] = [];

  async function recordSender(by: { readonly userId: string }, route: SenderRoute, pending: boolean): Promise<SenderP> {
    const senderId = ids.next();
    const address = `sender-${uniq()}@mail.example`;
    await asOperator(h, owner.userId, async (c) => {
      await c.query(
        "INSERT INTO kauro.sender_identities (sender_id, user_id, address, route, consent_evidence_ref, recorded_by_user_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [senderId, by.userId, address, route, route === "GMAIL_API" ? sha(`consent-${senderId}`) : null, owner.userId],
      );
      if (!pending) {
        await c.query("SELECT pg_advisory_xact_lock(kauro.transition_key($1, $2))", [OUTREACH_LOCK_KINDS.L7, senderId]);
        await c.query("UPDATE kauro.sender_identities SET state = 'VERIFIED', verification_evidence_hash = $2 WHERE sender_id = $1", [senderId, sha(`verified-${senderId}`)]);
      }
    });
    return { senderId, userId: by.userId, route, address };
  }

  // --- the section M controls (acquisition + T2 assertion removed from the control's actors, co-guards dropped) ----------------------
  async function applyFree(kinds: ReadonlyArray<string>, except: (login: Login) => boolean): Promise<void> {
    for (const { conn, login } of opened) {
      if (login === "superuser" || except(login)) continue;
      await conn.query("SELECT set_config($1, $2, false)", [FREE_SETTING, kinds.join(",")]).catch(() => undefined);
    }
  }
  async function withGuardsDropped<T>(guards: ReadonlyArray<CoGuard>, fn: () => Promise<T>): Promise<T> {
    const restore: string[] = [];
    const functions = new Map<string, string>();
    try {
      for (const name of guards) {
        const g: (typeof CO_GUARDS)[CoGuard] = CO_GUARDS[name];
        if ("raise" in g) {
          const [fnName, head] = g.raise;
          if (!functions.has(fnName)) {
            functions.set(fnName, (await oracle.query<{ d: string }>("SELECT pg_get_functiondef($1::regprocedure) AS d", [fnName])).rows[0]!.d);
            restore.push(`FN ${fnName}`);
          }
          const cur = (await oracle.query<{ d: string }>("SELECT pg_get_functiondef($1::regprocedure) AS d", [fnName])).rows[0]!.d;
          const needle = `RAISE EXCEPTION '${head}`;
          if (cur.split(needle).length !== 2) throw new Error(`${fnName} has not exactly one "${needle}"`);
          await oracle.query(cur.replace(needle, `RAISE NOTICE '${head}`));
        } else {
          const [table, constraint] = g.constraint;
          if (name === "U-content") {
            // the content-addressed key is referenced by the drafts and the resources: their foreign keys go with it and come back after it
            const fks = await oracle.query<{ conrelid: string; conname: string; d: string }>(
              "SELECT conrelid::regclass::text AS conrelid, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE contype = 'f' AND confrelid = 'kauro.outreach_contents'::regclass",
            );
            for (const fk of fks.rows) {
              await oracle.query(`ALTER TABLE ${fk.conrelid} DROP CONSTRAINT ${fk.conname}`);
              restore.push(`ALTER TABLE ${fk.conrelid} ADD CONSTRAINT ${fk.conname} ${fk.d}`);
            }
          }
          const def = await oracle.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass", [constraint, table]);
          if (def.rowCount !== 1) throw new Error(`constraint ${constraint} of ${table} not found`);
          await oracle.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
          restore.push(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${def.rows[0]!.d}`);
        }
      }
      return await fn();
    } finally {
      for (const r of restore.reverse()) await oracle.query(r.startsWith("FN ") ? functions.get(r.slice(3))! : r);
    }
  }
  async function withoutSerializers<T>(control: Control, fn: () => Promise<T>): Promise<T> {
    const kinds = control.locks.flatMap((l) => KINDS_OF[l]);
    const saved = new Map<string, string>();
    try {
      if (kinds.length > 0) {
        for (const f of ["kauro.transition_key(text,text)", "kauro.outreach_require_lock(text,text,text,text)"]) {
          saved.set(f, (await oracle.query<{ d: string }>("SELECT pg_get_functiondef($1::regprocedure) AS d", [f])).rows[0]!.d);
        }
        await oracle.query(CONTROLLED_KEY);
        await oracle.query(CONTROLLED_REQUIRE);
        // the writer's own platform code keeps its lock on the control plane's connection (Control.keptOn)
        await applyFree(kinds, (login) => control.keptOn !== undefined && login === "kauro_control_test");
      }
      return await withGuardsDropped(control.coGuards, fn);
    } finally {
      if (kinds.length > 0) {
        await applyFree([], () => false);
        for (const def of saved.values()) await oracle.query(def);
      }
    }
  }

  // --- fixtures ------------------------------------------------------------------------------------------------------------------
  const world: DraftWorld = {
    oracle,
    owner,
    stop: () => w.stop(),
    standAt(at) {
      standing = at;
    },
    async seller(sellerLabel) {
      const s = await recordSeller(w, owner.userId, `${sellerLabel}-${uniq()}`);
      const sender = await recordSender(s, "GMAIL_API", false);
      const out: SellerP = { userId: s.userId, token: s.person.token, sellerId: s.sellerId, sender };
      return out;
    },
    async extraOwner(ownerLabel) {
      const p = await w.person(`${label}-${ownerLabel}-${uniq()}`);
      extraPeople.push(p);
      const grantId = await h.grantKauroOwner(p.userId);
      return { userId: p.userId, token: p.token, grantId };
    },
    async agencyMember(memberLabel) {
      void memberLabel;
      return { userId: w.operator.userId, token: w.operator.token };
    },
    async prospect(seller, options = {}) {
      const domain = `${uniq()}.example`;
      const address = options.contact ?? `contact-${uniq()}@${domain}`;
      const contactKey = (await oracle.query<{ k: string }>("SELECT kauro.prospect_contact_key($1) AS k", [address])).rows[0]!.k;
      const jurisdiction = options.jurisdiction ?? "United States";
      const evidence = await recordSourceEvidence(h, { userId: seller.userId, sellerId: seller.sellerId }, { domain, contactKey });
      await asOperator(h, seller.userId, (c) =>
        c.query("INSERT INTO kauro.prospect_contact_addresses (contact_id, recorded_by_user_id, address) VALUES ($1, $2, $3)", [evidence.contactRef, seller.userId, address]),
      );
      const reply = await call({ url: "/api/v1/sales/prospects", token: seller.token, body: { organizationLabel: domain, businessContactRef: evidence.contactRef, sourceEvidenceHash: evidence.sourceEvidenceHash, jurisdiction } });
      const prospectId = completedOf<{ prospectId: string }>(reply, 201, "RegisterProspect").data.prospectId;
      const row = (await oracle.query<{ organization_key: string }>("SELECT organization_key FROM kauro.prospects WHERE prospect_id = $1", [prospectId])).rows[0]!;
      const out: ProspectP = { prospectId, contactKey, organizationKey: row.organization_key, sellerId: seller.sellerId, provenanceEvidenceHash: evidence.sourceEvidenceHash, jurisdiction };
      return out;
    },
    sender: (person, options = {}) => recordSender(person, options.route ?? "GMAIL_API", options.pending === true),
    async freshResource(resourceLabel) {
      const capabilityId = ids.next();
      await oracle.query(
        `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at)
         VALUES ($1, $2, 'OPERATION', NULL, 'DESIGN', $3, '[]'::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
        [capabilityId, `R2-${uniq()}`, sha(`profile-${capabilityId}`)],
      );
      await h.publishCapability(capabilityId, "AVAILABLE");
      const contentRef = await contentIdOf(world, owner, safeContent(`resource-${resourceLabel}-${uniq()}`));
      const familyId = ids.next();
      const reply = await call({
        url: "/api/v1/ops/sales/resources",
        token: owner.token,
        body: { familyId, expectedVersion: 0, contentRef, capabilityIds: [capabilityId], assuranceProofRef: await stepUp(owner) },
      });
      const view = completedOf<{ resourceId: string; version: number }>(reply, 201, "PublishSalesResource").data;
      const out: ResourceP = { resourceId: view.resourceId, familyId, version: view.version, capabilityId };
      return out;
    },
    stepUp,
    tenantRecordIds: notBuilt("tenantRecordIds", "L-SOURCE/B07 tenant upload and staged-record fixture"),
    sentFirstContactTo: notBuilt("sentFirstContactTo", "L-AUTH/L-SEND"),
    grant: notBuilt("grant", "L-AUTH"),
    send: notBuilt("send", "L-SEND"),
    metrics: notBuilt("metrics", "L-ACT"),
    dispatcher: notBuilt("dispatcher", "L-SEND"),
    call,
    outcome: (reply: Reply) => outcomeOf(w, reply),
    async open(login) {
      const conn = await openConnection(h.pg.clientConfig(login === "superuser" ? "postgres" : login));
      const entry = { conn, login };
      opened.add(entry);
      conn.once("end", () => opened.delete(entry));
      return conn;
    },
    on<T>(conn: HarnessConnection, role: Role, ctx: FaultContext, steps: ReadonlyArray<SqlStep>, fn: () => Promise<T>, routing?: { readonly target?: number; readonly log?: UnitLog[] }): Promise<T> {
      return faults.on(conn, role, ctx.points, steps, fn, routing ?? {});
    },
    setStatementTimeout(ms) {
      faults.statementTimeoutMs = ms;
    },
    get internalErrors() {
      return w.internalErrors;
    },
    gmailContract: gmail,
    callsOf: (intentId) => gmail.callsOf(intentId).length,
    callsTotal: () => gmail.calls.length,
    withoutSerializers,
    routes: {
      async terminate(seller, key = keyOf("cmd050")) {
        const version = (await oracle.query<{ version: string }>("SELECT version::text FROM kauro.sellers WHERE seller_id = $1", [seller.sellerId])).rows[0]!.version;
        const body = {
          expectedVersion: Number(version),
          terminationTermsRef: await prepareTerminationTerms(h, owner.userId as UserId, seller.sellerId),
          activeOpportunityManifestRef: await prepareManifest(h, owner.userId as UserId, seller.sellerId, []),
        };
        return call({ url: `/api/v1/sales/sellers/${seller.sellerId}/terminate`, token: owner.token, key, body });
      },
      suspendCapability: (capabilityId, key = keyOf("cmd059")) =>
        call({ url: `/api/v1/operations/capabilities/${capabilityId}/restrict`, token: owner.token, key, body: { expectedVersion: 1, incidentRef: ids.next() } }),
      withdrawPolicy: notBuilt("routes.withdrawPolicy", "L-AUTH"),
      reinstatePolicy: notBuilt("routes.reinstatePolicy", "L-AUTH"),
      revokeSender: notBuilt("routes.revokeSender", "L-SEND"),
      optOut: notBuilt("routes.optOut", "L-ACT"),
      async suppress(target) {
        await suppressFixture(h, owner.userId, target);
      },
      recordActivity: notBuilt("routes.recordActivity", "L-ACT"),
    },
  };
  return world;
}
