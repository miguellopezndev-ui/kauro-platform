/**
 * The contract fake of BankingCalendarSource (design §8, D10-CAL-1; 21 example 21): the controlled fixture of a banking calendar.
 * Weekends are nonbanking by rule and the fixture lists 2026-10-12 as the one other nonbanking day over the October 2026 it covers, so
 * the 5th banking day after the 2026-09-30 month-end is 2026-10-07 and the 10th is 2026-10-15. Whatever it serves is labelled TEST_FIXTURE — never VERIFIED_FEED,
 * which the fake refuses to serve — so a commission period computed from it records that its dates are a simulation.
 * `binding: CONTRACT_FAKE`, evidence class SIMULATED, a call log and a hold point; reachable only from the testing subpath.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { Clock, UnitOfWork } from "@kauro/domain";
import { CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, sha256Hex, type FakeCall } from "../../commerce/testing/labels.js";
import type { BankingCalendarSource, BankingCalendarVersion } from "../ports.js";
import { HoldPoints, type CommercialFakeHold } from "./holds.js";

export const BANKING_CALENDAR_FAKE_PROVIDER = "contract-fake-banking-calendar" as const;
export const BANKING_CALENDAR_FIXTURE_VERSION = "test-fixture-2026-10" as const;
/** The one nonbanking day the fixture lists besides weekends (design §8 example 21). */
export const BANKING_CALENDAR_FIXTURE_NONBANKING = Object.freeze(["2026-10-12"] as const);
/** The dates the fixture version covers: October 2026, so the 5th and the 10th banking days after September are known to it. */
export const BANKING_CALENDAR_FIXTURE_COVERAGE = Object.freeze({ coversFrom: "2026-10-01", coversTo: "2026-10-31" } as const);

const CALENDAR_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function requireCalendarDate(value: string): string {
  const parsed = CALENDAR_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (parsed === null || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`"${value}" is not a calendar date (YYYY-MM-DD; contract fake)`);
  }
  return value;
}

/** The digest of a version as recorded: everything that identifies it except the digest itself. */
function digestOf(version: Omit<BankingCalendarVersion, "evidenceHash">): string {
  return sha256Hex(
    ["banking-calendar", version.jurisdiction, version.calendarVersion, version.source, version.recordedAt, [...version.nonbankingDates].join(","), version.coversFrom, version.coversTo].join("|"),
  );
}

/** A version banking_calendars can record: a range of covered dates, every listed day a calendar date inside it. */
function recordable(version: Omit<BankingCalendarVersion, "evidenceHash">): Omit<BankingCalendarVersion, "evidenceHash"> {
  const coversFrom = requireCalendarDate(version.coversFrom);
  const coversTo = requireCalendarDate(version.coversTo);
  if (coversTo < coversFrom) throw new Error(`a calendar covers a range of dates, not ${coversFrom}..${coversTo} (contract fake)`);
  const nonbankingDates = Object.freeze([...version.nonbankingDates].map(requireCalendarDate));
  for (const d of nonbankingDates) if (d < coversFrom || d > coversTo) throw new Error(`${d} lies outside the covered dates ${coversFrom}..${coversTo} (contract fake)`);
  return { calendarVersion: version.calendarVersion, jurisdiction: version.jurisdiction, source: version.source, nonbankingDates, coversFrom, coversTo, recordedAt: version.recordedAt };
}

export class ContractFakeBankingCalendar implements BankingCalendarSource {
  readonly provider = BANKING_CALENDAR_FAKE_PROVIDER;
  readonly integrationClass = CONTRACT_FAKE;
  readonly evidenceClass = FAKE_EVIDENCE_CLASS;
  readonly contractFake = true as const;
  readonly binding = CONTRACT_FAKE;

  private current: BankingCalendarVersion;
  private withdrawn = false;
  private readonly log: FakeCall[] = [];
  private readonly holds = new HoldPoints<"CURRENT_CALENDAR">();

  constructor(private readonly options: { readonly clock: Clock }) {
    const fixture = recordable({
      calendarVersion: BANKING_CALENDAR_FIXTURE_VERSION,
      jurisdiction: "CO" as const,
      source: "TEST_FIXTURE" as const,
      nonbankingDates: BANKING_CALENDAR_FIXTURE_NONBANKING,
      ...BANKING_CALENDAR_FIXTURE_COVERAGE,
      recordedAt: options.clock.now(),
    });
    this.current = Object.freeze({ ...fixture, evidenceHash: digestOf(fixture) });
  }

  /** The calls received so far, oldest first; a frozen copy. */
  get calls(): ReadonlyArray<FakeCall> {
    return Object.freeze([...this.log]);
  }

  /**
   * Replaces the calendar the fake serves. Only the controlled source is accepted (a feed label is refused, so a fixture can never be
   * passed off as one), and only a version banking_calendars can record: a range of covered dates with every listed day a calendar
   * date inside it. The evidence hash is recomputed from what is served.
   */
  serve(version: BankingCalendarVersion): void {
    if (version.source !== "TEST_FIXTURE") throw new Error(`the fake serves only a TEST_FIXTURE calendar, never ${String(version.source)}`);
    const recorded = recordable(version);
    this.current = Object.freeze({ ...recorded, evidenceHash: digestOf(recorded) });
  }

  /** The served calendar answers null from now on, as an unrecorded calendar does (CMD051 then refuses CALENDAR_UNAVAILABLE). */
  withdraw(): void {
    this.withdrawn = true;
  }

  restore(): void {
    this.withdrawn = false;
  }

  /** Whether the date is nonbanking in the served calendar: a weekend by rule, or a listed day. */
  isNonbanking(date: string): boolean {
    requireCalendarDate(date);
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6 || this.current.nonbankingDates.includes(date);
  }

  /** Stops the next `currentCalendar` after it was recorded, until the test releases it. */
  hold(operation: "CURRENT_CALENDAR"): CommercialFakeHold {
    return this.holds.hold(operation);
  }

  async currentCalendar(uow: UnitOfWork, request: { readonly jurisdiction: "CO"; readonly at: UtcInstant }): Promise<BankingCalendarVersion | null> {
    this.log.push(Object.freeze({ port: "BankingCalendarSource", operation: `CURRENT_CALENDAR ${uow.context.kind}`, identity: request.jurisdiction, at: request.at, sent: true }));
    await this.holds.arrive("CURRENT_CALENDAR");
    if (this.withdrawn || request.jurisdiction !== this.current.jurisdiction || this.current.recordedAt > request.at) return null;
    return this.current;
  }
}
