/**
 * The PERIODS sweep of the commission service (docs/design/B10-commercial-domain.md §7, §14; decisions D10-CAL-1, D10-STMT-1, D10-STMT-4;
 * mandate B10-STATEMENTS-PAYOUTS): one bounded pass that
 *  - opens the commission period of the month the server's clock stands in (America/Bogota), once (commission_periods_one_per_month);
 *  - proposes the close of each OPEN period whose month has ended — KAURO_COMMISSION_CUTOFF_V1 over the ledger as it stands — and closes
 *    it through CMD051's own core as the commission service, under the journal key period-close-<periodId>: a close it repeats replays,
 *    and a close the command refuses (PERIOD_NOT_DUE before the 5th banking day, CALENDAR_UNAVAILABLE, INPUTS_UNRECONCILED, a ledger
 *    that moved under the proposal) writes nothing and is proposed again by the next pass.
 * Built here beside CMD051 and tested directly; B10-INTEGRATION enters it into the service's cycle (runCycle({ also })).
 */
import type { BankingCalendarSource, StatementServiceHold } from "@kauro/application";
import { calendarDateIn, closeCommissionPeriod, proposeCommissionClose } from "@kauro/application";
import type { CommissionPeriodId, CorrelationId } from "@kauro/domain";
import { DomainFailure, monthStartsAt, nextMonth } from "@kauro/domain";
import { commissionWorkOf, statementsOf } from "@kauro/persistence";
import { serverNow } from "./ledger-effects.js";
import { statementServiceRuntime } from "./routes.js";
import { COMMISSION_SERVICE_ID, serviceContext, type CommissionRuntime } from "./runtime.js";
import type { CycleSweep, SweepReport } from "./sweeps.js";

/** The journal key under which the PERIODS sweep closes a period (design §14). */
export function periodCloseKey(periodId: string): string {
  return `period-close-${periodId}`;
}

type Items = Array<{ readonly subject: string; readonly outcome: string }>;

async function item(rt: CommissionRuntime, items: Items, subject: string, work: () => Promise<string>): Promise<void> {
  try {
    items.push({ subject, outcome: await work() });
  } catch (e) {
    rt.onBackgroundFailure(subject, e);
    items.push({ subject, outcome: `FAILED ${e instanceof DomainFailure ? e.code : "UNEXPECTED_ERROR"}` });
  }
}

/**
 * The PERIODS sweep over the commission service's runtime. `calendar` is the BankingCalendarSource CMD051 dates a period with (the
 * platform's RecordedBankingCalendarSource when absent, D10-BIND-1); `hold` is a test's interleaving of the close.
 */
export function createPeriodsSweep(rt: CommissionRuntime, ports: { readonly calendar?: BankingCalendarSource; readonly hold?: StatementServiceHold } = {}): CycleSweep {
  const commands = statementServiceRuntime({ units: rt.assembly.units, ...(ports.calendar !== undefined ? { calendar: ports.calendar } : {}), ...(ports.hold !== undefined ? { hold: ports.hold } : {}) }, rt.environment, rt.clock);
  return {
    sweep: "PERIODS",
    async run(options: { readonly limit: number }): Promise<SweepReport> {
      const items: Items = [];
      // the month the server's clock stands in, opened once
      await item(rt, items, "OPEN", () =>
        rt.assembly.units.run(serviceContext(rt), async (uow) => {
          const now = await serverNow(uow);
          const month = calendarDateIn(now, rt.policy.operationalTimeZone).slice(0, 7);
          const zone = rt.policy.operationalTimeZone;
          const opened = await statementsOf(uow).openPeriod({ periodId: uow.ids.next() as CommissionPeriodId, month, startsAt: monthStartsAt(month, zone), endsAt: monthStartsAt(nextMonth(month), zone) });
          return `${opened.created ? "OPENED" : "EXISTS"} ${month}`;
        }),
      );
      // each ended OPEN period: proposed, then closed through CMD051 as the commission service
      const ended = await rt.assembly.units.run(serviceContext(rt), (uow) => commissionWorkOf(uow).endedOpenPeriods(options.limit));
      for (const { periodId } of ended) {
        await item(rt, items, periodId, async () => {
          const proposal = await rt.assembly.units.run(serviceContext(rt), async (uow) => {
            const period = await statementsOf(uow).getPeriod(periodId as CommissionPeriodId);
            if (period === null) throw new DomainFailure("INTEGRITY_FAILURE", "an ended period of the work list is not readable");
            return proposeCommissionClose(statementsOf(uow), period, await serverNow(uow));
          });
          const result = await closeCommissionPeriod(commands, {
            correlationId: rt.ids.next() as CorrelationId,
            idempotencyKey: periodCloseKey(periodId),
            identity: { serviceId: COMMISSION_SERVICE_ID, audience: "kauro-api", environment: rt.environment },
            path: { periodId },
            body: { ledgerCutoffHash: proposal.ledgerCutoffHash },
          });
          if (result.kind === "COMPLETED") return result.replayed ? "CLOSED_BEFORE" : "CLOSED";
          if (result.kind === "ACCEPTED") return "ACCEPTED";
          return `REFUSED ${result.problem.reason ?? result.problem.code}`;
        });
      }
      return { sweep: "PERIODS", items };
    },
  };
}
