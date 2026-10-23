// Schemas of behaviour built against the O19A re-issue candidate (Order 20 / Order 24), used only where a server page says the deployment
// switched that behaviour on (server/config/candidate.ts). The served contract stays generated.ts: this table is generated.ts's own with the
// one change the candidate makes to a reply the web reads — CP-02.01: AuditView.targetContractId is optional, absent for a CLEAN audit, which
// binds the canonical CLEAN hash and no target contract. Everything else is the generated schema, unchanged; Order 19B regenerates the
// client from the adopted contract and removes this file.
import { SCHEMAS } from "./generated.ts";
import type { SchemaNode } from "./schema-guard.ts";

const audit = SCHEMAS.AuditView;

export const CANDIDATE_CLEAN_SCHEMAS: Readonly<Record<string, SchemaNode>> = Object.freeze({
  ...SCHEMAS,
  AuditView: { ...audit, required: (audit.required ?? []).filter((member) => member !== "targetContractId") },
});
