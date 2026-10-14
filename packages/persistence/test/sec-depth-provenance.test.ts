// SEC-DEPTH-PROVENANCE section C, file S (catalog gate R17, the part that holds on this base; lanes L2a/L2b/L3 extend it).
// Still open for R17 (they need the guards other lanes rewrite): no kauro function reads pg_trigger_depth() or rolsuper,
// is_control_session() guards no value, and the 11 history attachments equal kauro.commercial_machines (B7).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { start, type Harness } from "../src/testing/harness.js";

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

test("SEC-DEPTH catalog (R17, definers): the only SECURITY DEFINER routines of kauro, kauro_meta and public are the justified, search_path-pinned registration of a bank payment route (registrar-owned, kauro_route_registrar; kauro_app alone), the read-only provider-available balance of a payment route (PV1-SETTLE D-SET-5), the bank owner authority and the payment session fence (L-REFUND; owner-owned, kauro_payment alone)", async () => {
  const r = await h.oracle.query<{ sig: string; owner: string; config: string[] | null; runtime: string[] }>(
    `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
            ARRAY(SELECT g FROM unnest(ARRAY['kauro_app','kauro_control','kauro_assurance','kauro_validator','kauro_ingress','kauro_payment','kauro_commission']) g
                   WHERE has_function_privilege(g, p.oid, 'EXECUTE') ORDER BY g) AS runtime
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname IN ('kauro', 'kauro_meta', 'public') ORDER BY 1`,
  );
  assert.deepEqual(r.rows, [
    { sig: "kauro.bank_owner_authority(uuid,uuid,integer)", owner: "kauro_owner", config: ["search_path=pg_catalog, pg_temp"], runtime: ["kauro_payment"] },
    { sig: "kauro.payment_session_fence(text,uuid)", owner: "kauro_owner", config: ["search_path=pg_catalog, pg_temp"], runtime: ["kauro_payment"] },
    { sig: "kauro.register_bank_payment_route(uuid,text,text,uuid,text,text)", owner: "kauro_route_registrar", config: ["search_path=pg_catalog, pg_temp"], runtime: ["kauro_app"] },
    { sig: "kauro.route_provider_available_cents(uuid,text)", owner: "kauro_owner", config: ["search_path=pg_catalog, pg_temp"], runtime: ["kauro_payment"] },
  ]);
  const publicExec = await h.oracle.query("SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE p.prosecdef AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'");
  assert.equal(publicExec.rowCount, 0, "no SECURITY DEFINER routine is executable by PUBLIC");
});

test("SEC-DEPTH catalog (R17, trigger functions): no kauro trigger function is executable by PUBLIC", async () => {
  const r = await h.oracle.query<{ sig: string }>(
    `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('kauro', 'kauro_meta') AND p.prorettype = 'trigger'::regtype
        AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`,
  );
  assert.deepEqual(r.rows, []);
});
