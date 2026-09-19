// Role and capability model against the vendored command catalogue (08 "Role and capability model"; commands.json roles).
// Oracle: the registry itself — every agency-bound command role in the catalogue must be decidable, OWNER satisfies every
// agency role, and the deny-by-default rule holds for every role the table does not know.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS } from "@kauro/contracts";
import {
  AGENCY_COMMAND_ROLES,
  COMMAND_ROLE_MEMBERS,
  MEMBERSHIP_ROLES,
  ROLE_CAPABILITIES,
  capabilitiesOf,
  commandRole,
  isAgencyCommandRole,
  roleSatisfies,
} from "../src/index.js";

test("every AGENCY_* command role of the catalogue is decidable and nothing else is", () => {
  const catalogueRoles = new Set(COMMANDS.map((c) => c.role));
  for (const role of catalogueRoles) {
    if (role.startsWith("AGENCY_")) assert.ok(isAgencyCommandRole(role), `${role} has no membership mapping`);
    else assert.ok(!isAgencyCommandRole(role), `${role} must not be an agency role`);
  }
  for (const role of AGENCY_COMMAND_ROLES) assert.ok(catalogueRoles.has(role), `${role} is not in the catalogue`);
});

test("OWNER satisfies every agency role; every membership role satisfies READER/MEMBER; unknown roles deny", () => {
  for (const role of AGENCY_COMMAND_ROLES) assert.ok(roleSatisfies(role, "OWNER"), role);
  for (const m of MEMBERSHIP_ROLES) {
    assert.ok(roleSatisfies("AGENCY_READER", m));
    assert.ok(roleSatisfies("AGENCY_MEMBER", m));
  }
  assert.equal(roleSatisfies("KAURO_OWNER", "OWNER"), false);
  assert.equal(roleSatisfies("VERIFIED_USER", "OWNER"), false);
  assert.equal(roleSatisfies("AGENCY_OWNER", "ADMIN"), false);
});

test("the seven B06 commands resolve to the intended membership sets", () => {
  const expect: Record<string, string[]> = {
    CMD001: [],
    CMD009: ["OWNER", "ADMIN", "OPERATOR"],
    CMD010: ["OWNER", "ADMIN"],
    CMD011: ["OWNER", "ADMIN", "OPERATOR"],
    CMD023: ["OWNER", "ADMIN", "OPERATOR"],
    CMD025: ["OWNER", "APPROVER"],
    CMD026: ["OWNER", "APPROVER"],
  };
  for (const [id, roles] of Object.entries(expect)) {
    const role = commandRole(id as "CMD001");
    const satisfied = MEMBERSHIP_ROLES.filter((m) => roleSatisfies(role, m));
    assert.deepEqual(satisfied, roles, `${id} (${role})`);
  }
  assert.equal(commandRole("CMD001"), "VERIFIED_USER");
});

test("capability sets are least privilege: VIEWER only views, APPROVER does not operate, BILLING does not approve", () => {
  assert.deepEqual(capabilitiesOf("VIEWER"), ["VIEW"]);
  assert.ok(!ROLE_CAPABILITIES.APPROVER.has("OPERATE_PROJECTS"));
  assert.ok(!ROLE_CAPABILITIES.BILLING.has("APPROVE_PLANS"));
  assert.ok(!ROLE_CAPABILITIES.ADMIN.has("APPROVE_PLANS"));
  assert.ok(!ROLE_CAPABILITIES.ADMIN.has("MANAGE_BILLING"));
  for (const m of MEMBERSHIP_ROLES) assert.ok(ROLE_CAPABILITIES[m].has("VIEW"), m);
  for (const [role, members] of Object.entries(COMMAND_ROLE_MEMBERS)) assert.ok(members.has("OWNER"), role);
});
