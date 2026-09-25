// Reads every runtime role's table and column privileges and every row-security policy of the kauro schemas from the catalog
// of a migrated cluster (runtime-boundary.test.ts compares them with the reviewed matrix test/fixtures/runtime-boundary.json).
import { RUNTIME_ROLES } from "../src/index.js";
import type { TemporaryPostgres } from "../src/testing/index.js";

export interface RuntimeBoundary {
  /** role → "schema.table" → sorted table-level privileges. */
  readonly tables: Record<string, Record<string, string[]>>;
  /** role → "schema.table" → privilege → sorted columns (column-level grants only). */
  readonly columns: Record<string, Record<string, Record<string, string[]>>>;
  /** "table/policy" → command, roles, USING and WITH CHECK as the server prints them. */
  readonly policies: Record<string, { readonly command: string; readonly roles: string[]; readonly using: string | null; readonly check: string | null }>;
}

/** The boundary as the catalog of a migrated cluster states it. */
export async function readBoundary(pgc: TemporaryPostgres): Promise<RuntimeBoundary> {
  const su = await pgc.connect("postgres");
  try {
    const tables: RuntimeBoundary["tables"] = {};
    const t = await su.query<{ grantee: string; rel: string; privilege: string }>(
      `SELECT r.rolname AS grantee, n.nspname || '.' || c.relname AS rel, a.privilege_type AS privilege
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname IN ('kauro', 'kauro_meta') AND c.relkind IN ('r', 'S') AND r.rolname = ANY($1::text[])
        ORDER BY 1, 2, 3`,
      [[...RUNTIME_ROLES]],
    );
    for (const row of t.rows) ((tables[row.grantee] ??= {})[row.rel] ??= []).push(row.privilege);
    const columns: RuntimeBoundary["columns"] = {};
    const col = await su.query<{ grantee: string; rel: string; privilege: string; attname: string }>(
      `SELECT r.rolname AS grantee, n.nspname || '.' || c.relname AS rel, a.privilege_type AS privilege, att.attname
         FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(att.attacl) a JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname IN ('kauro', 'kauro_meta') AND att.attacl IS NOT NULL AND r.rolname = ANY($1::text[])
        ORDER BY 1, 2, 3, 4`,
      [[...RUNTIME_ROLES]],
    );
    for (const row of col.rows) (((columns[row.grantee] ??= {})[row.rel] ??= {})[row.privilege] ??= []).push(row.attname);
    const policies: RuntimeBoundary["policies"] = {};
    const p = await su.query<{ tablename: string; policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(
      "SELECT tablename, policyname, cmd, roles::text[] AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'kauro' ORDER BY tablename, policyname",
    );
    for (const row of p.rows) policies[`${row.tablename}/${row.policyname}`] = { command: row.cmd, roles: [...row.roles].sort(), using: row.qual, check: row.with_check };
    return { tables, columns, policies };
  } finally {
    await su.end();
  }
}
