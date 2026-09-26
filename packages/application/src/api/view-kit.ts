/**
 * The kit every response view of the api is declared with (10 "Version and validation": closed 2020-12 objects derived from the
 * owning contract registry; reference/FIELD_CONTRACTS.md "Common rules"): the field vocabulary, the member constructors of a view
 * definition, the members no response may declare, and viewSchema, which derives a view from the registry bundle. Kept apart from
 * api/response-schemas (the served views, envelopes and roots) so a later package's views — the B07 source lifecycle,
 * sources/response-views — are declared with the same kit and joined to the served ones without a module cycle.
 */
import type { ContractName } from "@kauro/contracts";
import { DomainFailure } from "@kauro/domain";
import { CURSOR_PATTERN } from "./cursor.js";
import { RESOURCE_ACTIONS } from "./permitted-actions.js";
import { LABEL_PATTERN } from "./request-schemas.js";

export const RESPONSE_SCHEMA_PREFIX = "urn:kauro:api:v1:response:";

export type JsonSchema = Readonly<Record<string, unknown>>;

// --- field vocabulary (reference/FIELD_CONTRACTS.md "Common rules"; the request schemas use the same shapes) -----------------

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
/** A server identity the platform minted (UUIDv7) or derived (UUIDv5): "Application IDs are opaque server identities". */
const ID = Object.freeze({ type: "string", pattern: UUID_PATTERN });
/** A version the platform assigns: an aggregate starts at 1 and every edit adds one (design D-VER-1). */
const VERSION = Object.freeze({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** "SHA-256 is lowercase hexadecimal". */
const HASH = Object.freeze({ type: "string", pattern: "^[0-9a-f]{64}$" });
/** "UTC instants include Z"; the calendar assertion is the validator's `date-time` format (10 "Schema format execution"). */
const UTC = Object.freeze({ type: "string", format: "date-time", pattern: "Z$" });
/**
 * The registry `label` shape (FIELD_CONTRACTS: labels are untrusted text, bounded), with the control-character rule of the
 * request schemas and kauro.is_label: a label the api could not have admitted is never answered either (re-check finding N6).
 */
const LABEL = Object.freeze({ type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN });
/** A non-negative exact count. */
const COUNT = Object.freeze({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** The shapes above, exported so a test can prove each equals the registry vocabulary it claims to be. */
export const RESPONSE_FIELD_VOCABULARY = Object.freeze({ ID, VERSION, HASH, UTC, LABEL, COUNT, UUID_PATTERN });

// --- view definitions ----------------------------------------------------------------------------------------------------

/**
 * A member taken from the registry, optionally narrowed by keywords the registry member lacks: from the view's own contract
 * (same name), or — `from` — from the named member of another contract (a reference such as a project's capability version).
 */
export interface DerivedMember {
  readonly kind: "registry";
  readonly required: boolean;
  readonly narrow?: JsonSchema;
  readonly from?: readonly [ContractName, string];
}
/** A member the registry has no contract for; its schema is platform vocabulary and its rationale is recorded. */
export interface PlatformMember {
  readonly kind: "platform";
  readonly required: boolean;
  readonly schema: JsonSchema;
  readonly description: string;
}
export type ViewMember = DerivedMember | PlatformMember;

export interface ViewDefinition {
  readonly name: string;
  readonly description: string;
  /** The registry contract the view projects, or null when the registry has none (the members are then all platform). */
  readonly contract: ContractName | null;
  /** Registry members of `contract` the view deliberately does not select, each with the reason (FIELD_CONTRACTS). */
  readonly withheld: Readonly<Record<string, string>>;
  readonly members: Readonly<Record<string, ViewMember>>;
}

const registry = (required: boolean, narrow?: JsonSchema, from?: readonly [ContractName, string]): DerivedMember => ({
  kind: "registry",
  required,
  ...(narrow !== undefined ? { narrow } : {}),
  ...(from !== undefined ? { from } : {}),
});
const platform = (required: boolean, schema: JsonSchema, description: string): PlatformMember => ({ kind: "platform", required, schema, description });
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const NARROW_ID = Object.freeze({ pattern: UUID_PATTERN });
/** A registry label narrowed by the platform's control-character rule (the request schemas and kauro.is_label; N6). */
const NARROW_LABEL = Object.freeze({ pattern: LABEL_PATTERN });
/** The served commands a caller may issue on a resource, derived server-side (api/permitted-actions; N16). */
const RESOURCE_ACTIONS_SCHEMA = Object.freeze({ type: "array", maxItems: RESOURCE_ACTIONS.length, items: { type: "string", enum: [...RESOURCE_ACTIONS] } });
const RESOURCE_ACTIONS_DESCRIPTION =
  "The served commands the caller may issue on this resource, derived server-side from the caller's role, the resource's state and, for an approval, its control (07 \"The handoff to UI includes every state, safe field, permitted action\"); informative, never authority (re-check finding N16).";
/** An opaque list cursor (api/cursor): integrity-protected and bound to the caller, the scope, the filter and the order. */
const CURSOR = Object.freeze({ type: "string", pattern: CURSOR_PATTERN, maxLength: 600 });

/**
 * The member constructors and narrowing keywords of a view definition, exported so a later package declares its views exactly as
 * these are declared (the B07 source lifecycle, @kauro/application sources/response-views) and builds them with viewSchema.
 */
export const VIEW_MEMBER_KIT = Object.freeze({ registry, platform, ref, NARROW_ID, NARROW_LABEL, CURSOR, RESOURCE_ACTIONS_SCHEMA, RESOURCE_ACTIONS_DESCRIPTION });

// --- forbidden response members ----------------------------------------------------------------------------------------------

/**
 * Member names no response schema may declare, with the authority that forbids them. The schemas are closed, so a member that
 * no schema declares can never reach the wire; this list proves no schema declares one (start-up and the OpenAPI checker).
 */
export const FORBIDDEN_RESPONSE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  token: "10 \"Agency and team routes\": no authentication provider tokens",
  tokenHash: "08 \"Invitation, recovery and ownership transfer\": stored token material is protected",
  accessToken: "10 \"Agency and team routes\": no authentication provider tokens",
  refreshToken: "10 \"Agency and team routes\": no authentication provider tokens",
  idToken: "10 \"Agency and team routes\": no authentication provider tokens",
  sessionToken: "08 \"Authentication and assurance\": session tokens never leave the secure flow",
  bearerToken: "10 \"Agency and team routes\": no authentication provider tokens",
  invitationToken: "08 \"Invitation, recovery and ownership transfer\": one-use opaque tokens",
  subject: "08 \"Identity is not permission\": the provider subject stays with the authenticator",
  subjectHash: "08 \"Identity is not permission\": the provider subject stays with the authenticator",
  providerSubject: "08 \"Identity is not permission\": the provider subject stays with the authenticator",
  password: "08 \"Authentication and assurance\": passwords never leave the secure flow",
  passwordHash: "08 \"Authentication and assurance\": passwords never leave the secure flow",
  recoveryCodes: "10 \"Agency and team routes\": no recovery settings",
  recoverySettings: "10 \"Agency and team routes\": no recovery settings",
  mfaSeed: "08 \"Authentication and assurance\": MFA seeds never leave the secure flow",
  mfaSecret: "08 \"Authentication and assurance\": MFA seeds never leave the secure flow",
  totpSecret: "08 \"Authentication and assurance\": MFA seeds never leave the secure flow",
  secret: "10 \"Responses and safe errors\": no internal secrets",
  clientSecret: "10 \"Responses and safe errors\": no internal secrets",
  privateKey: "10 \"Responses and safe errors\": no internal secrets",
  apiKey: "10 \"Responses and safe errors\": no internal secrets",
  credentials: "08 \"Authentication and assurance\": provider credentials never leave the secure flow",
  assuranceProofRef: "10 \"Agency and team routes\": no private security evidence (the step-up proof)",
  emailVerifiedAt: "10 \"Agency and team routes\": no private security evidence (identity verification facts)",
  mfaEnrolledAt: "10 \"Agency and team routes\": no private security evidence (identity verification facts)",
  stack: "10 \"Responses and safe errors\": no stack traces",
  stackTrace: "10 \"Responses and safe errors\": no stack traces",
  sql: "10 \"Responses and safe errors\": no SQL",
  bucket: "10 \"Responses and safe errors\": no bucket names",
  bucketName: "10 \"Responses and safe errors\": no bucket names",
  sessionUri: "10 \"Responses and safe errors\": no session URIs",
  requestDigest: "10 \"Read endpoints return safe projections\": the idempotency journal is an internal record",
  responseBody: "10 \"Read endpoints return safe projections\": the idempotency journal is an internal record",
  createdByUserId: "10 \"Read endpoints return safe projections\": internal column",
  activeOwnerCount: "10 \"Read endpoints return safe projections\": internal column",
  legalProfileRef: "registry Agency.legalProfileRef \"Private reviewed customer billing profile\"",
});

// --- building the schemas from the registry bundle ---------------------------------------------------------------------------

/** The generated registry bundle, as @kauro/contracts/schemas.json ships it. */
export interface RegistryBundle {
  readonly $defs: Readonly<Record<string, unknown>>;
}

interface RegistryContractSchema {
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required?: ReadonlyArray<string>;
}


function refuse(message: string): never {
  throw new DomainFailure("INTEGRITY_FAILURE", `response schemas: ${message}`);
}

function registryContract(bundle: RegistryBundle, name: ContractName): RegistryContractSchema {
  const def = bundle.$defs[name];
  if (typeof def !== "object" || def === null || typeof (def as { properties?: unknown }).properties !== "object") refuse(`the registry bundle has no contract ${name}`);
  return def as RegistryContractSchema;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every member name any object schema in `schema` declares, with its path; `$ref`s are not followed. */
export function declaredMembers(schema: unknown, at = ""): ReadonlyArray<{ readonly name: string; readonly path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const walk = (s: unknown, path: string): void => {
    if (Array.isArray(s)) {
      s.forEach((x, i) => walk(x, `${path}/${i}`));
      return;
    }
    if (!isPlainObject(s)) return;
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && isPlainObject(v)) {
        for (const [name, sub] of Object.entries(v)) {
          out.push({ name, path: `${path}/properties/${name}` });
          walk(sub, `${path}/properties/${name}`);
        }
      } else if (k !== "enum" && k !== "const") {
        walk(v, `${path}/${k}`);
      }
    }
  };
  walk(schema, at);
  return out;
}

/** Paths of object schemas that are not closed (`additionalProperties: false`); a wire contract is closed (10). */
export function openObjects(schema: unknown, at = ""): ReadonlyArray<string> {
  const out: string[] = [];
  const walk = (s: unknown, path: string): void => {
    if (Array.isArray(s)) {
      s.forEach((x, i) => walk(x, `${path}/${i}`));
      return;
    }
    if (!isPlainObject(s)) return;
    const isObject = s["type"] === "object" || (Array.isArray(s["type"]) && (s["type"] as unknown[]).includes("object")) || "properties" in s;
    if (isObject && s["additionalProperties"] !== false) out.push(path || "/");
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && isPlainObject(v)) {
        for (const [name, sub] of Object.entries(v)) walk(sub, `${path}/properties/${name}`);
      } else if (k !== "enum" && k !== "const") {
        walk(v, `${path}/${k}`);
      }
    }
  };
  walk(schema, at);
  return out;
}

export function viewSchema(bundle: RegistryBundle, view: ViewDefinition): JsonSchema {
  const contract = view.contract === null ? null : registryContract(bundle, view.contract);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, member] of Object.entries(view.members)) {
    if (member.kind === "registry") {
      const [sourceName, sourceMember] = member.from ?? [view.contract, name];
      if (sourceName === null) refuse(`${view.name}.${name} is derived from the registry but names no contract`);
      const source = sourceName === view.contract && contract !== null ? contract : registryContract(bundle, sourceName);
      const base = source.properties[sourceMember];
      if (base === undefined) refuse(`${view.name}.${name}: the registry contract ${sourceName} has no member ${sourceMember}`);
      if ((source.required ?? []).includes(sourceMember) && !member.required) refuse(`${view.name}.${name}: the registry requires ${sourceName}.${sourceMember}; a view cannot make it optional`);
      const narrowed: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(member.narrow ?? {})) {
        if (k in base) refuse(`${view.name}.${name}: narrowing may only add keywords the registry member lacks (${k} is already set)`);
        narrowed[k] = v;
      }
      properties[name] = narrowed;
    } else {
      if (contract !== null && name in contract.properties) refuse(`${view.name}.${name} is a registry member of ${view.contract}; it must be derived, not redeclared`);
      properties[name] = { ...member.schema, description: member.description };
    }
    if (member.required) required.push(name);
  }
  if (contract !== null) {
    for (const name of Object.keys(contract.properties)) {
      if (!(name in view.members) && !(name in view.withheld)) refuse(`${view.name}: registry member ${view.contract}.${name} is neither selected nor withheld with a reason`);
    }
    for (const name of Object.keys(view.withheld)) {
      if (!(name in contract.properties)) refuse(`${view.name}: withheld member ${name} is not a registry member of ${view.contract}`);
      if (name in view.members) refuse(`${view.name}: ${name} is both selected and withheld`);
    }
  }
  const withheld = Object.entries(view.withheld);
  return {
    title: view.name,
    description: view.description,
    ...(view.contract !== null ? { $comment: `Projection of registry contract ${view.contract}.${withheld.length > 0 ? ` Withheld: ${withheld.map(([k, why]) => `${k} (${why})`).join("; ")}` : " Every registry member is selected."}` } : {}),
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}
