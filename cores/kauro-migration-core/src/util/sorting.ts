import { compareCodeUnits } from './json.js';

export type Comparator<T> = (a: T, b: T) => number;

/** Compose comparators; first non-zero wins. Keeps artifact ordering explicit and total. */
export function by<T>(...comparators: Array<Comparator<T>>): Comparator<T> {
  return (a, b) => {
    for (const compare of comparators) {
      const result = compare(a, b);
      if (result !== 0) return result;
    }
    return 0;
  };
}

export function onString<T>(select: (value: T) => string): Comparator<T> {
  return (a, b) => compareCodeUnits(select(a), select(b));
}

export function onNumber<T>(select: (value: T) => number): Comparator<T> {
  return (a, b) => {
    const left = select(a);
    const right = select(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

export function sorted<T>(items: readonly T[], comparator: Comparator<T>): T[] {
  return [...items].sort(comparator);
}
