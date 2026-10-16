import { MigrationError } from '../domain/errors.js';
import type { TimezonePolicy } from '../domain/config.js';
import { daysFromCivil } from './civil-calendar.js';

/**
 * Declared time zones.
 *
 * The engine carries no time zone database of its own. When a plan declares a
 * zone, the runtime's ICU answers what that zone's clock said at an instant,
 * and only under two conditions that make the answer part of the plan rather
 * than a property of the machine:
 *
 *   1. `Intl` is always given an explicit `timeZone`. The host's own zone
 *      (`TZ`) is never consulted, so it cannot move a delivered timestamp.
 *   2. The plan names the tzdata release it was declared against, and the
 *      runtime's release must be that one (decision D68). The rules behind a
 *      zone name change between releases, so a zone without its release would
 *      deliver different instants on a different runtime.
 */

/** A zone name as IANA spells it: no offsets, no abbreviations with digits, no empty segment. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;

const SECONDS_PER_DAY = 86_400;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const held = formatters.get(zone);
  if (held !== undefined) return held;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    era: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  formatters.set(zone, made);
  return made;
}

/** The tzdata release of the runtime, or null when the runtime cannot say. */
export function runtimeTzdata(): string | null {
  const release = process.versions.tz;
  return typeof release === 'string' && release.length > 0 ? release : null;
}

/**
 * Refuses a declared zone the runtime cannot honour.
 *
 * Called when a plan is loaded, so a mismatch stops the run before any source
 * is read, and again where a value is resolved, so a configuration built in
 * code cannot skip it.
 */
export function assertTimezoneUsable(policy: TimezonePolicy, where: string): void {
  const runtime = runtimeTzdata();
  if (runtime === null || policy.tzdata !== runtime) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${where} declares the zone "${policy.zone}" against tzdata ${policy.tzdata}, and this runtime carries tzdata ${runtime ?? '(unknown)'}`,
      `A time zone is only a rule together with the tzdata release that defines it. Run the migration on a runtime whose tzdata is ${policy.tzdata}, or re-declare the plan against ${runtime ?? 'a runtime that reports its tzdata'} after checking that the rules of "${policy.zone}" did not change for the dates in the data.`,
      { where, zone: policy.zone, declaredTzdata: policy.tzdata, runtimeTzdata: runtime },
    );
  }
  let known = ZONE_NAME.test(policy.zone);
  if (known) {
    try {
      formatterFor(policy.zone);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      known = false;
    }
  }
  if (!known) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${where} declares the zone "${policy.zone}", which is not an IANA time zone this runtime knows`,
      'Use an IANA zone name such as "Europe/Madrid". A fixed offset is declared with timezoneOffset instead.',
      { where, zone: policy.zone },
    );
  }
}

/** What a wall-clock reading means in a zone. Offsets are in seconds east of UTC. */
export type LocalTimeResolution =
  | { readonly kind: 'UNIQUE'; readonly offsetSeconds: number }
  | { readonly kind: 'OVERLAP'; readonly earlierOffsetSeconds: number; readonly laterOffsetSeconds: number }
  | { readonly kind: 'GAP' };

/** The offset the zone's clock had at a UTC instant, in seconds. */
function offsetAt(zone: string, utcSeconds: number): number {
  const parts = formatterFor(zone).formatToParts(new Date(utcSeconds * 1000));
  const field = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const eraYear = Number(field('year'));
  const year = field('era').startsWith('B') ? 1 - eraYear : eraYear;
  const days = daysFromCivil({ year, month: Number(field('month')), day: Number(field('day')) });
  const hour = Number(field('hour')) % 24;
  const wallSeconds = days * SECONDS_PER_DAY + hour * 3600 + Number(field('minute')) * 60 + Number(field('second'));
  return wallSeconds - utcSeconds;
}

/**
 * Resolves a local reading, given as if it were UTC seconds, in a declared zone.
 *
 * Every offset the zone has within two days either side is a candidate; a
 * candidate stands only if the zone really had that offset at the instant it
 * implies. No candidate standing means the clock skipped that reading (a gap);
 * two mean it read that time twice (an overlap). Nothing is moved to make a
 * reading fit.
 */
export function resolveLocalTime(localSeconds: number, zone: string): LocalTimeResolution {
  const candidates = new Set<number>();
  for (let step = -2; step <= 2; step += 1) {
    candidates.add(offsetAt(zone, localSeconds + step * SECONDS_PER_DAY));
  }
  const standing = [...candidates].filter((offset) => offsetAt(zone, localSeconds - offset) === offset);
  if (standing.length === 0) return { kind: 'GAP' };
  standing.sort((a, b) => b - a);
  const earlier = standing[0] as number;
  const later = standing[standing.length - 1] as number;
  if (standing.length === 1) return { kind: 'UNIQUE', offsetSeconds: earlier };
  return { kind: 'OVERLAP', earlierOffsetSeconds: earlier, laterOffsetSeconds: later };
}

/** `+02:00`, or `+00:53:28` where the zone's historical offset has seconds. */
export function renderOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const absolute = Math.abs(offsetSeconds);
  const two = (value: number): string => String(value).padStart(2, '0');
  const base = `${sign}${two(Math.floor(absolute / 3600))}:${two(Math.floor((absolute % 3600) / 60))}`;
  return absolute % 60 === 0 ? base : `${base}:${two(absolute % 60)}`;
}
