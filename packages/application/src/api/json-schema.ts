/**
 * Strict JSON Schema 2020-12 validation over the closed keyword vocabulary of the Kauro contract bundle and request schemas
 * (10 "Version and validation": closed objects, no coercion, no default, no silent removal; 10 "Schema format execution":
 * calendar date-time assertions are explicitly enabled and tested; S093: only reviewed application-owned schemas are compiled).
 *
 * Why not a general-purpose validator: the bundle @kauro/contracts generates uses exactly the keywords below, and the boundary
 * must fail closed. This compiler refuses any schema that carries a keyword outside the vocabulary (a keyword it does not
 * implement can never be silently ignored), any `$ref` that does not point into the bundle's `$defs`, any `format` other than
 * `date-time`, and any non-boolean `additionalProperties`. Compilation happens once at start-up from application-owned
 * sources; there is no entry that compiles a value received at runtime.
 *
 * Semantics follow the 2020-12 validation vocabulary for the keywords implemented: `type` (string or list; `integer` is a
 * number with no fractional part), `enum`, `const`, `properties` + `required` + `additionalProperties`, `items` + `minItems` +
 * `maxItems`, `minLength` + `maxLength` (Unicode code points), `pattern` (ECMA-262, unanchored, `u` flag), `minimum` +
 * `maximum`, `format: date-time` asserted as the utc primitive of manual 10 (YYYY-MM-DDTHH:mm:ss[.fff]Z, real Gregorian
 * instant, at most three fractional digits, no offsets, no leap seconds).
 */
import type { FieldError } from "@kauro/domain";

export class SchemaCompileError extends Error {
  readonly schemaPath: string;
  constructor(message: string, schemaPath: string) {
    super(`${message} (schema ${schemaPath || "$"})`);
    this.name = "SchemaCompileError";
    this.schemaPath = schemaPath;
  }
}

/** Keywords the compiler implements; anything else is refused at compile time. */
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength",
  "maxLength", "pattern", "minimum", "maximum", "format", "$ref",
]);
/** Annotation keywords the compiler accepts and ignores (they carry no validation semantics). */
export const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set(["$schema", "$id", "title", "description", "$comment", "$defs"]);

const JSON_TYPES = ["object", "array", "string", "integer", "number", "boolean", "null"] as const;
type JsonType = (typeof JSON_TYPES)[number];

type Validator = (value: unknown, path: string, errors: FieldError[]) => void;

export interface CompiledSchemaSet {
  readonly ids: ReadonlyArray<string>;
  /** Validates `input` against the compiled root `id`; throws SchemaCompileError-free: an unknown id is a programming error the caller maps. */
  validate(id: string, input: unknown): ReadonlyArray<FieldError>;
  has(id: string): boolean;
}

export interface SchemaBundleInput {
  /** Shared definitions reachable through `#/$defs/<Name>`. */
  readonly defs: Readonly<Record<string, unknown>>;
  /** Root schemas by id; a root may itself be one of the defs. */
  readonly roots: Readonly<Record<string, unknown>>;
}

const MAX_ERRORS = 100;

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/** The utc primitive (10 "Schema format execution"): a real Gregorian instant with millisecond precision at most. */
export function isCalendarDateTime(value: string): boolean {
  const m = DATE_TIME.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  return day >= 1 && day <= daysInMonth;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function typeOf(value: unknown): Exclude<JsonType, "integer"> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "object": return "object";
    default: throw new TypeError(`value of type ${typeof value} is not JSON`);
  }
}

function matchesType(value: unknown, t: JsonType): boolean {
  if (t === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeOf(value) === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (Array.isArray(b)) return false;
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}/${key}`;
}

function push(errors: FieldError[], field: string, code: FieldError["code"]): void {
  if (errors.length < MAX_ERRORS) errors.push({ field, code });
}

export function compileSchemaBundle(input: SchemaBundleInput): CompiledSchemaSet {
  const defCache = new Map<string, Validator>();
  // Two-phase reference resolution: a def validator is registered as a forwarder before its body compiles so mutual and
  // self references (TargetContract -> TargetObject -> TargetField) terminate.
  const defBodies = new Map<string, Validator>();

  function resolveRef(ref: string, at: string): Validator {
    const m = /^#\/\$defs\/([A-Za-z][A-Za-z0-9_]*)$/.exec(ref);
    if (!m) throw new SchemaCompileError(`unsupported $ref ${ref}: only #/$defs/<Name> inside the bundle is allowed`, at);
    const name = m[1] as string;
    const cached = defCache.get(name);
    if (cached) return cached;
    const def = input.defs[name];
    if (def === undefined) throw new SchemaCompileError(`$ref to unknown definition ${name}`, at);
    const forwarder: Validator = (value, path, errors) => {
      const body = defBodies.get(name);
      if (!body) throw new SchemaCompileError(`definition ${name} referenced before compilation finished`, at);
      body(value, path, errors);
    };
    defCache.set(name, forwarder);
    defBodies.set(name, compile(def, `#/$defs/${name}`, true));
    return forwarder;
  }

  function compile(schema: unknown, at: string, isRoot = false): Validator {
    if (schema === true) return () => undefined;
    if (schema === false) return (_v, path, errors) => push(errors, path, "TYPE");
    if (!isPlainObject(schema)) throw new SchemaCompileError("a schema must be an object or a boolean", at);
    for (const k of Object.keys(schema)) {
      if (SUPPORTED_KEYWORDS.has(k)) continue;
      if (ANNOTATION_KEYWORDS.has(k)) {
        if (k === "$defs" && !isRoot) throw new SchemaCompileError("$defs is only accepted on a bundle root", at);
        continue;
      }
      throw new SchemaCompileError(`unsupported keyword ${k}: the validator refuses schemas it cannot enforce`, at);
    }
    const checks: Validator[] = [];

    if ("$ref" in schema) {
      const ref = schema["$ref"];
      if (typeof ref !== "string") throw new SchemaCompileError("$ref must be a string", at);
      checks.push(resolveRef(ref, at));
    }

    if ("type" in schema) {
      const t = schema["type"];
      const list = Array.isArray(t) ? t : [t];
      if (list.length === 0) throw new SchemaCompileError("type must name at least one JSON type", at);
      const types: JsonType[] = list.map((x) => {
        if (typeof x !== "string" || !(JSON_TYPES as ReadonlyArray<string>).includes(x)) throw new SchemaCompileError(`unknown type ${String(x)}`, at);
        return x as JsonType;
      });
      checks.push((value, path, errors) => {
        if (!types.some((x) => matchesType(value, x))) push(errors, path, "TYPE");
      });
    }

    if ("enum" in schema) {
      const e = schema["enum"];
      if (!Array.isArray(e) || e.length === 0) throw new SchemaCompileError("enum must be a non-empty array", at);
      const members = e as ReadonlyArray<unknown>;
      checks.push((value, path, errors) => {
        if (!members.some((m) => deepEqual(m, value))) push(errors, path, "ENUM");
      });
    }

    if ("const" in schema) {
      const c = schema["const"];
      checks.push((value, path, errors) => {
        if (!deepEqual(c, value)) push(errors, path, "ENUM");
      });
    }

    if ("minLength" in schema || "maxLength" in schema) {
      const min = schema["minLength"];
      const max = schema["maxLength"];
      if (min !== undefined && (!Number.isInteger(min) || (min as number) < 0)) throw new SchemaCompileError("minLength must be a non-negative integer", at);
      if (max !== undefined && (!Number.isInteger(max) || (max as number) < 0)) throw new SchemaCompileError("maxLength must be a non-negative integer", at);
      checks.push((value, path, errors) => {
        if (typeof value !== "string") return;
        const len = codePointLength(value);
        if ((min !== undefined && len < (min as number)) || (max !== undefined && len > (max as number))) push(errors, path, "RANGE");
      });
    }

    if ("pattern" in schema) {
      const p = schema["pattern"];
      if (typeof p !== "string") throw new SchemaCompileError("pattern must be a string", at);
      let re: RegExp;
      try {
        re = new RegExp(p, "u");
      } catch (e) {
        throw new SchemaCompileError(`pattern does not compile: ${e instanceof Error ? e.message : String(e)}`, at);
      }
      checks.push((value, path, errors) => {
        if (typeof value === "string" && !re.test(value)) push(errors, path, "FORMAT");
      });
    }

    if ("format" in schema) {
      const f = schema["format"];
      if (f !== "date-time") throw new SchemaCompileError(`format ${String(f)} has no asserted implementation; only date-time is accepted`, at);
      checks.push((value, path, errors) => {
        if (typeof value === "string" && !isCalendarDateTime(value)) push(errors, path, "FORMAT");
      });
    }

    if ("minimum" in schema || "maximum" in schema) {
      const min = schema["minimum"];
      const max = schema["maximum"];
      if (min !== undefined && typeof min !== "number") throw new SchemaCompileError("minimum must be a number", at);
      if (max !== undefined && typeof max !== "number") throw new SchemaCompileError("maximum must be a number", at);
      checks.push((value, path, errors) => {
        if (typeof value !== "number") return;
        if ((min !== undefined && value < (min as number)) || (max !== undefined && value > (max as number))) push(errors, path, "RANGE");
      });
    }

    if ("items" in schema || "minItems" in schema || "maxItems" in schema) {
      const items = "items" in schema ? compile(schema["items"], `${at}/items`) : null;
      const minItems = schema["minItems"];
      const maxItems = schema["maxItems"];
      if (minItems !== undefined && (!Number.isInteger(minItems) || (minItems as number) < 0)) throw new SchemaCompileError("minItems must be a non-negative integer", at);
      if (maxItems !== undefined && (!Number.isInteger(maxItems) || (maxItems as number) < 0)) throw new SchemaCompileError("maxItems must be a non-negative integer", at);
      checks.push((value, path, errors) => {
        if (!Array.isArray(value)) return;
        if ((minItems !== undefined && value.length < (minItems as number)) || (maxItems !== undefined && value.length > (maxItems as number))) push(errors, path, "RANGE");
        if (items) value.forEach((v, i) => items(v, join(path, i), errors));
      });
    }

    if ("properties" in schema || "required" in schema || "additionalProperties" in schema) {
      const props = schema["properties"];
      if (props !== undefined && !isPlainObject(props)) throw new SchemaCompileError("properties must be an object", at);
      const compiledProps = new Map<string, Validator>();
      for (const [name, sub] of Object.entries(props ?? {})) compiledProps.set(name, compile(sub, `${at}/properties/${name}`));
      const required = schema["required"];
      if (required !== undefined && (!Array.isArray(required) || !required.every((r) => typeof r === "string"))) throw new SchemaCompileError("required must be a list of names", at);
      const requiredNames = (required ?? []) as ReadonlyArray<string>;
      const additional = schema["additionalProperties"];
      if (additional !== undefined && typeof additional !== "boolean") throw new SchemaCompileError("additionalProperties must be a boolean (no open extension maps)", at);
      const allowAdditional = additional !== false;
      checks.push((value, path, errors) => {
        if (!isPlainObject(value)) return;
        for (const r of requiredNames) {
          if (!Object.prototype.hasOwnProperty.call(value, r)) push(errors, join(path, r), "REQUIRED");
        }
        for (const [k, v] of Object.entries(value)) {
          const sub = compiledProps.get(k);
          if (sub) sub(v, join(path, k), errors);
          else if (!allowAdditional) push(errors, join(path, k), "UNKNOWN_FIELD");
        }
      });
    }

    return (value, path, errors) => {
      for (const c of checks) c(value, path, errors);
    };
  }

  const roots = new Map<string, Validator>();
  for (const [id, schema] of Object.entries(input.roots)) roots.set(id, compile(schema, id, true));
  // every definition must compile even when no root references it: an unsupported keyword anywhere in the bundle is refused
  for (const name of Object.keys(input.defs)) resolveRef(`#/$defs/${name}`, `#/$defs/${name}`);

  return {
    ids: [...roots.keys()],
    has: (id) => roots.has(id),
    validate(id, value) {
      const v = roots.get(id);
      if (!v) throw new SchemaCompileError(`unknown schema id ${id}`, id);
      const errors: FieldError[] = [];
      v(value, "", errors);
      return errors;
    },
  };
}
