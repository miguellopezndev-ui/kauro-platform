/**
 * What every source sweeper shares (docs/design/B07-upload-source-lifecycle.md §12.5; SourceSweeper of @kauro/application): the
 * database decides what is due on its own clock (D-CLOCK-1) through the control plane's unbound discovery reads, each due item is
 * then handled in its own SYSTEM unit of work bound to the item's agency (D-CTRL-1), revision row first (D-LOCK-2), and one item's
 * failure never stops the others — it is reported and found again by the next run, since nothing about it changed.
 */
import type { AgencyId, CausationId, CorrelationId, IdGenerator, SystemContext } from "@kauro/domain";
import { discovery, lostTheSubject, type WorkItem } from "../work.js";

/** One run of a sweeper: its correlation and causation, and the item of each agency it acts for. */
export class SweepRun {
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly failures: Array<{ readonly subject: string; readonly cause: string }> = [];

  constructor(
    readonly serviceId: string,
    ids: IdGenerator,
  ) {
    this.correlationId = ids.next() as CorrelationId;
    this.causationId = ids.next() as CausationId;
  }

  /** The unbound discovery context (no agency: only the control plane's granted columns). */
  get discovery(): SystemContext {
    return discovery(this.serviceId, this.correlationId);
  }

  itemFor(agencyId: AgencyId): WorkItem {
    return { serviceId: this.serviceId, agencyId, correlationId: this.correlationId, causationId: this.causationId };
  }

  /**
   * Runs one due item's work; true when it acted. An item another writer settled first (a lost compare-and-swap or fence) is not an
   * error; any other failure is recorded (safe tokens only) and the item is left for the next run.
   */
  async attempt(subject: string, work: () => Promise<boolean>): Promise<boolean> {
    try {
      return await work();
    } catch (e) {
      if (!lostTheSubject(e)) this.failures.push({ subject, cause: e instanceof Error ? `${e.name}${"code" in e ? `:${String((e as { code: unknown }).code)}` : ""}` : "FAILURE" });
      return false;
    }
  }
}

/** The result of one sweep run: what was due, what was acted on, and the items that failed (left for the next run). */
export interface SweepResult {
  readonly examined: number;
  readonly acted: number;
  readonly failed: ReadonlyArray<{ readonly subject: string; readonly cause: string }>;
}

export interface SweeperDependencies {
  readonly ids: IdGenerator;
}

