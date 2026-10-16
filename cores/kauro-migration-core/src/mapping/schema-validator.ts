import type { JsonObject, JsonValue } from '../util/json.js';

/**
 * A deliberately small JSON Schema subset, written here rather than pulled in as
 * a dependency.
 *
 * The engine only needs closed object validation with enums, arrays and
 * primitive types. Owning the ~150 lines keeps the dependency tree at two
 * runtime packages and makes the error messages point at exactly the JSON
 * pointer the operator has to fix.
 */

export type Schema =
  | { readonly type: 'string'; readonly enum?: readonly string[]; readonly minLength?: number; readonly pattern?: string; readonly description?: string }
  | { readonly type: 'integer'; readonly minimum?: number; readonly maximum?: number; readonly description?: string }
  | { readonly type: 'boolean'; readonly description?: string }
  | { readonly type: 'null'; readonly description?: string }
  | { readonly type: 'array'; readonly items: Schema; readonly minItems?: number; readonly description?: string }
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, Schema>>;
      readonly required?: readonly string[];
      readonly additionalProperties: false;
      readonly description?: string;
    }
  | { readonly anyOf: readonly Schema[]; readonly description?: string };

export interface SchemaViolation {
  /** RFC 6901 JSON pointer to the offending value. */
  readonly pointer: string;
  readonly message: string;
}

export function validateAgainstSchema(value: JsonValue, schema: Schema): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  walk(value, schema, '', violations);
  return violations;
}

function walk(value: JsonValue, schema: Schema, pointer: string, out: SchemaViolation[]): void {
  if ('anyOf' in schema) {
    const branches = schema.anyOf.map((branch) => validateAgainstSchema(value, branch));
    if (branches.every((branch) => branch.length > 0)) {
      const reasons = branches.map((branch) => branch[0]?.message ?? 'no match').join('; ');
      out.push({ pointer, message: `value matches none of the allowed shapes (${reasons})` });
    }
    return;
  }

  switch (schema.type) {
    case 'null':
      if (value !== null) out.push({ pointer, message: `expected null, received ${typeName(value)}` });
      return;

    case 'boolean':
      if (typeof value !== 'boolean') {
        out.push({ pointer, message: `expected a boolean, received ${typeName(value)}` });
      }
      return;

    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        out.push({ pointer, message: `expected an integer, received ${typeName(value)}` });
        return;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        out.push({ pointer, message: `must be at least ${String(schema.minimum)}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        out.push({ pointer, message: `must be at most ${String(schema.maximum)}` });
      }
      return;

    case 'string': {
      if (typeof value !== 'string') {
        out.push({ pointer, message: `expected a string, received ${typeName(value)}` });
        return;
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        out.push({
          pointer,
          message: `"${value}" is not one of: ${schema.enum.join(', ')}`,
        });
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        out.push({ pointer, message: `must be at least ${String(schema.minLength)} characters` });
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
        out.push({ pointer, message: `must match ${schema.pattern}` });
      }
      return;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        out.push({ pointer, message: `expected an array, received ${typeName(value)}` });
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        out.push({ pointer, message: `must contain at least ${String(schema.minItems)} items` });
      }
      value.forEach((item, index) => {
        walk(item, schema.items, `${pointer}/${String(index)}`, out);
      });
      return;
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        out.push({ pointer, message: `expected an object, received ${typeName(value)}` });
        return;
      }
      const record = value as JsonObject;
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
          out.push({ pointer: `${pointer}/${escapePointer(key)}`, message: 'is required' });
        }
      }
      for (const key of Object.keys(record).sort()) {
        const propertySchema = schema.properties[key];
        if (propertySchema === undefined) {
          out.push({
            pointer: `${pointer}/${escapePointer(key)}`,
            message: `unknown property "${key}"; the configuration schema is closed`,
          });
          continue;
        }
        const child = record[key];
        if (child === undefined) continue;
        walk(child, propertySchema, `${pointer}/${escapePointer(key)}`, out);
      }
      return;
    }
  }
}

function typeName(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Renders the schema as a plain JSON value so it can be written to `spec/`. */
export function schemaToJson(schema: Schema): JsonValue {
  return JSON.parse(JSON.stringify(schema)) as JsonValue;
}
