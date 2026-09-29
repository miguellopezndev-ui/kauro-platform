// The closed runtime guard behind apps/web/src/api/generated.ts (design D-GEN-1; 10 "Version and validation": TypeScript types alone are
// insufficient runtime validation). It validates a parsed JSON value against one of the generated, validation-only schemas and answers
// the paths that fail, never a value: a failing reply is an integrity failure and its content is never rendered or logged.
// Closed means: an object member that a schema does not name is a failure, not a pass.

export type JsonLiteral = string | number | boolean | null;

export interface SchemaNode {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: SchemaNode;
  readonly enum?: readonly JsonLiteral[];
  readonly const?: JsonLiteral;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly format?: string;
  readonly $ref?: string;
}

const MAX_DEPTH = 40;
const MAX_VIOLATIONS = 50;
const patterns = new Map<string, RegExp>();
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function compiled(pattern: string): RegExp {
  let regex = patterns.get(pattern);
  if (regex === undefined) {
    regex = new RegExp(pattern, "u");
    patterns.set(pattern, regex);
  }
  return regex;
}

function isDateTime(text: string): boolean {
  const match = DATE_TIME.exec(text);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function matchesType(kind: string, value: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      return false;
  }
}

export function validateAgainst(schemas: Readonly<Record<string, SchemaNode>>, name: string, value: unknown): readonly string[] {
  const failures: string[] = [];
  const fail = (path: string, rule: string): void => {
    if (failures.length < MAX_VIOLATIONS) failures.push(`${path}: ${rule}`);
  };

  const visit = (schema: SchemaNode, subject: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      fail(path, "depth");
      return;
    }
    if (schema.$ref !== undefined) {
      const target = Object.hasOwn(schemas, schema.$ref) ? schemas[schema.$ref] : undefined;
      if (target === undefined) fail(path, `unknown-schema ${schema.$ref}`);
      else visit(target, subject, path, depth + 1);
      return;
    }
    if (schema.type !== undefined) {
      const kinds = typeof schema.type === "string" ? [schema.type] : schema.type;
      if (!kinds.some((kind) => matchesType(kind, subject))) {
        fail(path, "type");
        return;
      }
    }
    if (schema.const !== undefined && subject !== schema.const) fail(path, "const");
    if (schema.enum !== undefined && !schema.enum.includes(subject as JsonLiteral)) fail(path, "enum");

    if (typeof subject === "string") {
      if (schema.minLength !== undefined && [...subject].length < schema.minLength) fail(path, "minLength");
      if (schema.maxLength !== undefined && [...subject].length > schema.maxLength) fail(path, "maxLength");
      if (schema.pattern !== undefined && !compiled(schema.pattern).test(subject)) fail(path, "pattern");
      if (schema.format === "date-time" && !isDateTime(subject)) fail(path, "format");
    } else if (typeof subject === "number") {
      if (schema.minimum !== undefined && subject < schema.minimum) fail(path, "minimum");
      if (schema.maximum !== undefined && subject > schema.maximum) fail(path, "maximum");
    } else if (Array.isArray(subject)) {
      if (schema.minItems !== undefined && subject.length < schema.minItems) fail(path, "minItems");
      if (schema.maxItems !== undefined && subject.length > schema.maxItems) fail(path, "maxItems");
      const items = schema.items;
      if (items !== undefined) subject.forEach((item, index) => visit(items, item, `${path}[${index}]`, depth + 1));
    } else if (isPlainObject(subject)) {
      const properties = schema.properties ?? {};
      for (const required of schema.required ?? []) if (!Object.hasOwn(subject, required)) fail(`${path}.${required}`, "required");
      for (const key of Object.keys(subject)) {
        const child = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (child === undefined) {
          if (schema.additionalProperties === false) fail(`${path}.${key}`, "unknown-member");
        } else visit(child, subject[key], `${path}.${key}`, depth + 1);
      }
    }
  };

  const root = Object.hasOwn(schemas, name) ? schemas[name] : undefined;
  if (root === undefined) return [`$: unknown-schema ${name}`];
  visit(root, value, "$", 0);
  return failures;
}
