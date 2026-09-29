// Web client generator (B11 design D-GEN-1; 10 "Consumer tests use the actual generated DTOs"): the web application consumes the api's
// DTOs only through apps/web/src/api/generated.ts, produced from apps/api/openapi.json — the served operations and the
// `x-kauro-planned` operations (a root member keyed "METHOD path" that holds operation objects an owning branch has designed and not yet
// served; empty where nothing is planned). An operation whose principal is not a browser's (`x-kauro-principal` PROVIDER or
// PAYMENT_SERVICE: package B09's provider webhook and the payment service's own routes) is no call the browser makes and is left out,
// named in the header; an unknown principal is a failure. Dependency-free and deterministic.
//
//   node tools/web-client.mjs generate   writes apps/web/src/api/generated.ts
//   node tools/web-client.mjs check      exits 1, listing every failure, when the committed file is not the generated one or the document
//                                        holds a construct the generator does not translate (the generator is closed: an unknown schema
//                                        keyword, an open object or a reference outside the components is a failure, never a guess)
//
// The generated file holds, for every component schema: its TypeScript type, its (validation-only) schema as data and a closed runtime
// guard `isName(value)`; and, for every operation, a descriptor (method, path, command, idempotency, headers, request and reply schema
// names). The guards run the hand-written validator apps/web/src/api/schema-guard.ts over that data, so a reply that fails its guard is
// an integrity failure (version skew between the web and api deployments is caught, never rendered).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOCUMENT_PATH = join(root, "apps", "api", "openapi.json");
export const GENERATED_PATH = join(root, "apps", "web", "src", "api", "generated.ts");

const COMPONENTS = "#/components/schemas/";
const PARAMETERS = "#/components/parameters/";
const METHODS = ["get", "post", "put", "patch", "delete"];
/** Keywords the generated type and the validator both honour. */
export const VALIDATION_KEYWORDS = ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "format", "$ref"];
/** Keywords that annotate and never constrain. */
const ANNOTATIONS = new Set(["title", "description", "$comment", "default", "examples", "$schema", "$id"]);
const FORMATS = new Set(["date-time"]);

const isAnnotation = (key) => ANNOTATIONS.has(key) || key.startsWith("x-");

/** The principals of `x-kauro-principal` (package B09): those a browser session acts as, and those whose routes no browser calls. */
const BROWSER_PRINCIPALS = new Set(["AGENCY_MEMBER", "CORPORATE_OPERATOR"]);
const NON_BROWSER_PRINCIPALS = new Set(["PROVIDER", "PAYMENT_SERVICE"]);

/** The schema with its annotations removed: exactly what the validator reads. */
function stripSchema(node, where, failures) {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    failures.push(`${where}: a schema must be an object`);
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (isAnnotation(key)) continue;
    if (!VALIDATION_KEYWORDS.includes(key)) {
      failures.push(`${where}: the keyword ${key} is not translated by this generator`);
      continue;
    }
    if (key === "properties") {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, stripSchema(child, `${where}.${name}`, failures)]));
    } else if (key === "items") {
      out.items = stripSchema(value, `${where}[]`, failures);
    } else if (key === "additionalProperties") {
      if (value !== false) failures.push(`${where}: an object must be closed (additionalProperties: false)`);
      out.additionalProperties = false;
    } else if (key === "$ref") {
      if (typeof value !== "string" || !value.startsWith(COMPONENTS)) failures.push(`${where}: a reference must point into ${COMPONENTS}`);
      out.$ref = typeof value === "string" ? value.slice(COMPONENTS.length) : "";
    } else if (key === "format") {
      if (!FORMATS.has(value)) failures.push(`${where}: the format ${JSON.stringify(value)} is not translated by this generator`);
      out.format = value;
    } else if (key === "pattern") {
      try {
        new RegExp(value, "u");
      } catch (error) {
        failures.push(`${where}: the pattern ${JSON.stringify(value)} does not compile: ${error.message}`);
      }
      out.pattern = value;
    } else out[key] = value;
  }
  if (out.type === "object" && out.properties !== undefined && out.additionalProperties !== false) failures.push(`${where}: an object with properties must be closed`);
  return out;
}

// --- types ---------------------------------------------------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propertyName = (name) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));
const literal = (value) => JSON.stringify(value);

function typeOfPrimitive(name, where, failures) {
  switch (name) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      failures.push(`${where}: the type ${JSON.stringify(name)} is not translated by this generator`);
      return "unknown";
  }
}

function typeOf(schema, indent, where, names, failures) {
  const pad = "  ".repeat(indent + 1);
  const close = "  ".repeat(indent);
  if (schema.$ref !== undefined) {
    if (!names.has(schema.$ref)) failures.push(`${where}: the reference ${schema.$ref} names no component`);
    return schema.$ref;
  }
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum !== undefined) return schema.enum.map(literal).join(" | ");
  const kinds = Array.isArray(schema.type) ? schema.type : [schema.type];
  const parts = kinds.map((kind) => {
    if (kind === "array") {
      if (schema.items === undefined) {
        failures.push(`${where}: an array must declare its items`);
        return "readonly unknown[]";
      }
      const inner = typeOf(schema.items, indent, `${where}[]`, names, failures);
      return `readonly ${/[|&]/.test(inner) ? `(${inner})` : inner}[]`;
    }
    if (kind === "object") {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const entries = Object.entries(properties);
      for (const name of required) if (!(name in properties)) failures.push(`${where}: required member ${name} is not declared`);
      if (entries.length === 0) return "Readonly<Record<string, never>>";
      const members = entries.map(([name, child]) => `${pad}readonly ${propertyName(name)}${required.has(name) ? "" : "?"}: ${typeOf(child, indent + 1, `${where}.${name}`, names, failures)};`);
      return `{\n${members.join("\n")}\n${close}}`;
    }
    return typeOfPrimitive(kind, where, failures);
  });
  return parts.join(" | ");
}

function declarationOf(name, schema, names, failures) {
  const body = typeOf(schema, 0, name, names, failures);
  if (schema.type === "object" && schema.$ref === undefined && body.startsWith("{")) return `export interface ${name} ${body}`;
  return `export type ${name} = ${body};`;
}

// --- operations ----------------------------------------------------------------------------------------------------------------

function operationsOf(document) {
  const found = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) if (item[method] !== undefined) found.push({ method, path, operation: item[method], planned: false });
  }
  for (const [key, operation] of Object.entries(document["x-kauro-planned"] ?? {})) {
    const match = /^([A-Za-z]+) (\/\S*)$/.exec(key);
    found.push({ method: (match?.[1] ?? "").toLowerCase(), path: match?.[2] ?? key, operation, planned: true, key });
  }
  return found;
}

function schemaNameOf(ref, where, names, failures) {
  if (typeof ref !== "string" || !ref.startsWith(COMPONENTS) || !names.has(ref.slice(COMPONENTS.length))) {
    failures.push(`${where}: the schema must be a reference to a component`);
    return null;
  }
  return ref.slice(COMPONENTS.length);
}

function describeOperation({ method, path, operation, planned, key }, document, names, failures) {
  const where = `${planned ? "planned " : ""}${method.toUpperCase()} ${path}`;
  if (!METHODS.includes(method)) failures.push(`${where}: the method is not one of ${METHODS.join(", ")}`);
  if (typeof operation.operationId !== "string" || operation.operationId === "") failures.push(`${where}: the operation has no operationId`);
  const parameters = (operation.parameters ?? []).map((parameter) => {
    if (parameter.$ref === undefined) return parameter;
    const name = parameter.$ref.startsWith(PARAMETERS) ? parameter.$ref.slice(PARAMETERS.length) : "";
    const resolved = document.components?.parameters?.[name];
    if (resolved === undefined) failures.push(`${where}: the parameter reference ${parameter.$ref} names no component`);
    return resolved ?? { name, in: "unknown" };
  });
  const named = (location) => parameters.filter((p) => p.in === location).map((p) => p.name);
  const headers = named("header");
  const content = operation.requestBody?.content ?? null;
  let request = null;
  if (content !== null) {
    const media = Object.keys(content);
    if (media.length !== 1 || media[0] !== "application/json") failures.push(`${where}: the request body must be application/json only`);
    request = schemaNameOf(content["application/json"]?.schema?.$ref, `${where} request`, names, failures);
  }
  const replies = {};
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    const media = Object.values(response.content ?? {});
    if (media.length === 0) replies[status] = null;
    else if (media.length > 1) failures.push(`${where}: status ${status} documents several media types`);
    else replies[status] = schemaNameOf(media[0].schema?.$ref, `${where} status ${status}`, names, failures);
  }
  return {
    operationId: operation.operationId,
    method,
    path,
    command: operation["x-kauro-command"] ?? null,
    role: operation["x-kauro-role"] ?? null,
    idempotency: operation["x-kauro-idempotency"] === "REQUIRED" ? "REQUIRED" : "NONE",
    headers,
    pathParameters: named("path"),
    queryParameters: named("query"),
    request,
    replies,
    planned,
    ...(key === undefined ? {} : { key }),
  };
}

// --- rendering -----------------------------------------------------------------------------------------------------------------

/** The generated module for one OpenAPI document. Returns { text, failures }; text is empty when there are failures. */
export function renderClient(document, digest) {
  const failures = [];
  const schemas = document.components?.schemas ?? {};
  const names = new Set(Object.keys(schemas));
  const stripped = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, stripSchema(schema, name, failures)]));
  for (const name of names) if (!IDENTIFIER.test(name)) failures.push(`${name}: a component name must be a TypeScript identifier`);

  const excluded = [];
  const operations = operationsOf(document)
    .filter((entry) => {
      const principal = entry.operation["x-kauro-principal"];
      if (principal === undefined || BROWSER_PRINCIPALS.has(principal)) return true;
      if (NON_BROWSER_PRINCIPALS.has(principal)) {
        excluded.push(entry.operation.operationId);
        return false;
      }
      failures.push(`${entry.method.toUpperCase()} ${entry.path}: the principal ${JSON.stringify(principal)} is neither a browser's nor a known service's`);
      return false;
    })
    .map((entry) => describeOperation(entry, document, names, failures));
  const seen = new Set();
  for (const operation of operations) {
    if (seen.has(operation.operationId)) failures.push(`the operationId ${operation.operationId} is used twice`);
    seen.add(operation.operationId);
  }
  const declarations = Object.entries(stripped).map(([name, schema]) => declarationOf(name, schema, names, failures));
  if (failures.length > 0) return { text: "", failures };

  const schemaNames = [...names];
  const lines = [];
  lines.push(`// GENERATED by tools/web-client.mjs from apps/api/openapi.json (sha256 ${digest}); do not edit. Regenerate with: node tools/web-client.mjs generate`);
  lines.push(`// Types, validation-only schemas, closed runtime guards and operation descriptors of the api's ${operations.filter((o) => !o.planned).length} served and ${operations.filter((o) => o.planned).length} planned operations (design D-GEN-1).`);
  if (excluded.length > 0) lines.push(`// Left out, no browser calls them (a provider's or a service's principal): ${[...excluded].sort().join(", ")}.`);
  lines.push("");
  lines.push(`import { validateAgainst, type SchemaNode } from "./schema-guard.ts";`);
  lines.push("");
  lines.push(...declarations.flatMap((declaration) => [declaration, ""]));
  lines.push(`export type SchemaName = ${schemaNames.map(literal).join(" | ") || "never"};`);
  lines.push("");
  lines.push("export const SCHEMAS: Readonly<Record<SchemaName, SchemaNode>> = {");
  for (const [name, schema] of Object.entries(stripped)) lines.push(`  ${propertyName(name)}: ${JSON.stringify(schema)},`);
  lines.push("};");
  lines.push("");
  lines.push("/** The names the value fails, as paths only (never a value): empty when the value conforms to the schema. */");
  lines.push("export function violations(name: SchemaName, value: unknown): readonly string[] {");
  lines.push("  return validateAgainst(SCHEMAS, name, value);");
  lines.push("}");
  lines.push("");
  lines.push("export function conforms(name: SchemaName, value: unknown): boolean {");
  lines.push("  return violations(name, value).length === 0;");
  lines.push("}");
  lines.push("");
  for (const name of schemaNames) {
    lines.push(`export function is${name[0].toUpperCase()}${name.slice(1)}(value: unknown): value is ${name} {`);
    lines.push(`  return conforms(${literal(name)}, value);`);
    lines.push("}");
    lines.push("");
  }
  lines.push("export interface OperationDescriptor {");
  lines.push("  readonly operationId: string;");
  lines.push(`  readonly method: ${METHODS.map(literal).join(" | ")};`);
  lines.push("  readonly path: string;");
  lines.push("  readonly command: string | null;");
  lines.push("  readonly role: string | null;");
  lines.push(`  readonly idempotency: "REQUIRED" | "NONE";`);
  lines.push("  readonly headers: readonly string[];");
  lines.push("  readonly pathParameters: readonly string[];");
  lines.push("  readonly queryParameters: readonly string[];");
  lines.push("  readonly request: SchemaName | null;");
  lines.push("  readonly replies: Readonly<Record<string, SchemaName | null>>;");
  lines.push("  /** true for an operation only planned by an owning branch: the browser suite answers it with the contract fake. */");
  lines.push("  readonly planned: boolean;");
  lines.push("}");
  lines.push("");
  lines.push(`export type OperationId = ${operations.map((o) => literal(o.operationId)).join(" | ") || "never"};`);
  lines.push("");
  lines.push("export const OPERATIONS: Readonly<Record<OperationId, OperationDescriptor>> = {");
  for (const operation of operations) lines.push(`  ${propertyName(operation.operationId)}: ${JSON.stringify(operation)},`);
  lines.push("};");
  lines.push("");
  lines.push("/** The typed body of each operation's success replies (every 2xx schema it documents). */");
  lines.push("export interface OperationSuccessReplies {");
  for (const operation of operations) {
    const successes = Object.entries(operation.replies).filter(([status, schema]) => /^2\d\d$/.test(status) && schema !== null).map(([, schema]) => schema);
    lines.push(`  readonly ${propertyName(operation.operationId)}: ${[...new Set(successes)].join(" | ") || "never"};`);
  }
  lines.push("}");
  lines.push("");
  lines.push("export type SuccessReply<Id extends OperationId> = OperationSuccessReplies[Id];");
  lines.push("");
  lines.push("export function operationById(operationId: string): OperationDescriptor | undefined {");
  lines.push("  return Object.hasOwn(OPERATIONS, operationId) ? OPERATIONS[operationId as OperationId] : undefined;");
  lines.push("}");
  lines.push("");
  return { text: lines.join("\n"), failures };
}

export function digestOf(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The generated module for the committed document. */
export function generate(documentText = readFileSync(DOCUMENT_PATH, "utf8")) {
  return renderClient(JSON.parse(documentText), digestOf(documentText));
}

// --- command line --------------------------------------------------------------------------------------------------------------

function main(mode) {
  if (mode !== "generate" && mode !== "check") {
    console.error("usage: node tools/web-client.mjs generate|check");
    return 2;
  }
  const { text, failures } = generate();
  if (failures.length > 0) {
    for (const failure of failures) console.error(`web-client: ${failure}`);
    return 1;
  }
  if (mode === "generate") {
    writeFileSync(GENERATED_PATH, text);
    console.log(`web-client: wrote ${GENERATED_PATH}`);
    return 0;
  }
  let committed = "";
  try {
    committed = readFileSync(GENERATED_PATH, "utf8");
  } catch {
    committed = "";
  }
  if (committed !== text) {
    console.error("web-client: apps/web/src/api/generated.ts is not the generated module (run node tools/web-client.mjs generate)");
    return 1;
  }
  console.log("web-client: apps/web/src/api/generated.ts is the module generated from apps/api/openapi.json (types, closed guards and operation descriptors)");
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv[2]);
}
