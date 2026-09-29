import type { ReactElement } from "react";
import { formatCount, formatDeadline, formatMoney } from "../format.js";
import type { CountValue } from "../format.js";
import { CLASS } from "../internal/class-names.js";

/** Count (D-DS-1): a whole number shown en-US with thousands separators, never rounded, never a float. */
export function Count({ value }: { readonly value: CountValue }): ReactElement {
  return <span className={CLASS.count}>{formatCount(value)}</span>;
}

export interface MoneyProps {
  /** The amount in minor units as a canonical decimal string ("129500"): money is never a float. */
  readonly minor: string;
  /** The ISO 4217 code ("USD"). */
  readonly currency: string;
}

/** Money (D-DS-1, D-COPY-1): minor-unit string to "USD 1,295.00", by BigInt arithmetic. */
export function Money({ minor, currency }: MoneyProps): ReactElement {
  return <span className={CLASS.money}>{formatMoney(minor, currency)}</span>;
}

export interface DeadlineProps {
  /** The instant, RFC 3339 with an offset or Z ("2027-03-14T22:00:00Z"). */
  readonly at: string;
  /** The IANA zone the deadline is shown in ("America/New_York"); its short name is part of the text. */
  readonly timeZone: string;
}

/** Deadline (D-DS-1, D-COPY-1): a <time> element whose datetime is the exact instant and whose text is the minute with the zone. */
export function Deadline({ at, timeZone }: DeadlineProps): ReactElement {
  const { iso, text } = formatDeadline(at, timeZone);
  return (
    <time className={CLASS.deadline} dateTime={iso}>
      {text}
    </time>
  );
}
