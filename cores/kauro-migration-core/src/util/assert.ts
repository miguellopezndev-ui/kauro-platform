import type { JsonObject } from './json.js';

/**
 * Thrown when the engine detects that it has violated one of its own
 * invariants. This is never a data problem; it is a defect. It must abort the
 * run rather than emit an artifact whose guarantees no longer hold.
 */
export class CoreInvariantError extends Error {
  readonly invariant: string;
  readonly details: JsonObject;

  constructor(invariant: string, message: string, details: JsonObject = {}) {
    super(`${invariant}: ${message}`);
    this.name = 'CoreInvariantError';
    this.invariant = invariant;
    this.details = details;
  }
}

export function invariant(
  condition: boolean,
  name: string,
  message: string,
  details: JsonObject = {},
): asserts condition {
  if (!condition) throw new CoreInvariantError(name, message, details);
}

export function unreachable(value: never, context: string): never {
  throw new CoreInvariantError(
    'EXHAUSTIVENESS',
    `${context}: unhandled variant ${JSON.stringify(value)}`,
  );
}
