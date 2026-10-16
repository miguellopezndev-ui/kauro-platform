export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Canonical JSON: keys sorted by UTF-16 code unit, two-space indent, LF line
 * endings, trailing newline. Byte-identical on every platform for equal input,
 * which is what makes artifact hashes comparable across Ubuntu and Windows.
 *
 * Non-finite numbers and `undefined` are rejected rather than coerced, because
 * silently turning them into `null` would put an invented value in an artifact.
 */
export function canonicalJsonText(value: JsonValue): string {
  return `${render(value, '')}\n`;
}

function render(value: JsonValue, indent: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJsonText: non-finite number cannot be serialized: ${String(value)}`);
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    default:
      break;
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const parts = value.map((item) => `${inner}${render(item, inner)}`);
    return `[\n${parts.join(',\n')}\n${indent}]`;
  }
  const keys = Object.keys(value).sort(compareCodeUnits);
  if (keys.length === 0) return '{}';
  const parts = keys.map((key) => {
    const child = value[key];
    if (child === undefined) {
      throw new Error(`canonicalJsonText: property "${key}" is undefined; omit it instead`);
    }
    return `${inner}${JSON.stringify(key)}: ${render(child, inner)}`;
  });
  return `{\n${parts.join(',\n')}\n${indent}}`;
}

/** Locale-independent ordering. `Array.prototype.sort` default is code-unit order already, but being explicit prevents accidental `localeCompare` creep. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseJson(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}
