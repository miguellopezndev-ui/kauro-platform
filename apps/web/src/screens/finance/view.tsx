// The markup of UI39's owner sections O1 and O2 (docs/design/B12-owner-screens.md D-B12S-5). Pure: no hooks, so a node test renders it. The
// route shows its state, versions and evidence hash and only the commands its state permits; the queue shows one state's page of credits or
// the shared state of a refusal, never both. Neither ever names the bank's account or routing numbers: the owner's views do not carry them.
import type { ReactElement } from "react";
import { Button } from "@kauro/ui";
import { message } from "../../copy/en.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { type BankCreditState, type BankCreditView, type BankRouteView, type QueueRead, QUEUE_STATES, type CreditCommand, type RouteCommand, creditRow, routeCommands } from "./model.ts";

export interface RouteSectionProps {
  readonly route: BankRouteView;
  /** A command of the route is running: every control is disabled (the runner joins a second activation anyway). */
  readonly busy: boolean;
  readonly onCommand: (command: RouteCommand) => void;
}

export function RouteSection({ route, busy, onCommand }: RouteSectionProps): ReactElement {
  return (
    <section aria-labelledby="finance-route-title" data-route={route.routeId}>
      <h2 id="finance-route-title">{message("screen.finance.route.title")}</h2>
      <dl>
        <dt>{message("screen.finance.route.state.label")}</dt>
        <dd data-route-state={route.state}>{message(`screen.finance.route.state.${route.state}`)}</dd>
        <dt>{message("screen.finance.route.account.label")}</dt>
        <dd>{route.accountRef}</dd>
        <dt>{message("screen.finance.route.environment.label")}</dt>
        <dd>{route.environment}</dd>
        <dt>{message("screen.finance.route.version.label")}</dt>
        <dd>{String(route.routeVersion)}</dd>
        <dt>{message("screen.finance.route.hash.label")}</dt>
        <dd>
          <code>{route.detailsEvidenceHash}</code>
        </dd>
        <dt>{message("screen.finance.route.rollout.label")}</dt>
        <dd>{route.rollout ?? message("screen.finance.route.rollout.none")}</dd>
      </dl>
      <div>
        {routeCommands(route).map((command) => (
          <Button key={command} variant={command === "DISABLE" ? "secondary" : "primary"} disabled={busy} aria-busy={busy ? true : undefined} onClick={() => (busy ? undefined : onCommand(command))}>
            {message(`screen.finance.route.command.${command}`)}
          </Button>
        ))}
      </div>
    </section>
  );
}

export interface CreditQueueProps {
  readonly state: BankCreditState;
  readonly read: QueueRead;
  readonly onState: (state: BankCreditState) => void;
  readonly onMore: (cursor: string) => void;
  readonly onOpen: (credit: BankCreditView, command: CreditCommand | null) => void;
}

export function CreditQueue({ state, read, onState, onMore, onOpen }: CreditQueueProps): ReactElement {
  return (
    <section aria-labelledby="finance-queue-title">
      <h2 id="finance-queue-title">{message("screen.finance.queue.title")}</h2>
      <label>
        {message("screen.finance.queue.state.label")}{" "}
        <select value={state} onChange={(event) => onState(event.currentTarget.value as BankCreditState)}>
          {QUEUE_STATES.map((option) => (
            <option key={option} value={option}>
              {message(`screen.finance.queue.state.${option}`)}
            </option>
          ))}
        </select>
      </label>
      {read.kind === "REFUSED" ? (
        <StatePanel decision={read.decision} />
      ) : read.credits.length === 0 ? (
        <p>{message("screen.finance.queue.empty")}</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th scope="col">{message("screen.finance.credit.transaction.label")}</th>
                <th scope="col">{message("screen.finance.credit.gross.label")}</th>
                <th scope="col">{message("screen.finance.credit.fee.label")}</th>
                <th scope="col">{message("screen.finance.credit.rail.label")}</th>
                <th scope="col">{message("screen.finance.credit.reference.label")}</th>
                <th scope="col">{message("screen.finance.credit.action.label")}</th>
              </tr>
            </thead>
            <tbody>
              {read.credits.map((credit) => {
                const row = creditRow(credit);
                return (
                  <tr key={credit.creditId} data-credit={credit.creditId}>
                    <td>{credit.bankTransactionId}</td>
                    <td>{row.gross}</td>
                    <td>{row.fee}</td>
                    <td>{credit.rail}</td>
                    <td>{credit.reference ?? message("screen.finance.credit.reference.none")}</td>
                    <td>
                      {row.commands.length === 0 ? (
                        <Button onClick={() => onOpen(credit, null)}>{message("screen.finance.credit.open.cta")}</Button>
                      ) : (
                        row.commands.map((command) => (
                          <Button key={command} variant="primary" onClick={() => onOpen(credit, command)}>
                            {message(`screen.finance.credit.command.${command}`)}
                          </Button>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {read.nextCursor === null ? null : (
            <Button onClick={() => (read.nextCursor === null ? undefined : onMore(read.nextCursor))}>{message("screen.finance.queue.more")}</Button>
          )}
        </>
      )}
    </section>
  );
}
