import { useId } from "react";
import type { ReactElement } from "react";
import { countToBigInt } from "../format.js";
import type { CountValue } from "../format.js";
import { CLASS } from "../internal/class-names.js";
import { Heading } from "../internal/heading.js";
import type { HeadingLevel } from "../internal/heading.js";
import { Count } from "./figures.js";
import { SafeText } from "./safe-text.js";
import type { SafeTextCopy } from "./safe-text.js";

/**
 * CountDenominators (B11 D-DS-1, R2-065): the three counts a source has, shown apart, each with its own label and its own
 * definition — never one "records" figure.
 *
 * - Physical rows: the rows read from the admitted files.
 * - Billable source units: the price denominator of the Billable unit (16 "Billable unit").
 * - Output rows: the rows of each delivered file, one line per file, never added up.
 *
 * The three are different measures of the same source and are not derived from one another (R2-065: the counters "cannot be
 * substituted for one another"), so this component adds nothing up, and it refuses copy that gives two of them the same label
 * or the same definition. The words come from the caller's copy catalogue: this package holds none.
 */

export interface MeasureCopy {
  readonly label: string;
  readonly definition: string;
}

export interface CountDenominatorsCopy {
  readonly heading: string;
  readonly physicalRows: MeasureCopy;
  readonly billableSourceUnits: MeasureCopy;
  readonly outputRows: MeasureCopy & {
    /** Shown when no file has been delivered yet. */
    readonly empty: string;
  };
  readonly safeText: SafeTextCopy;
}

export interface OutputFileCount {
  /** Stable id of the delivered file. */
  readonly id: string;
  /** The file's name: a string from outside, shown through SafeText. */
  readonly name: string;
  readonly rows: CountValue;
}

export interface CountDenominatorsProps {
  /** Rows read from the admitted files. */
  readonly physicalRows: CountValue;
  /** The billable source units: the price denominator. */
  readonly billableSourceUnits: CountValue;
  /** The rows of each delivered file. */
  readonly outputFiles: readonly OutputFileCount[];
  readonly copy: CountDenominatorsCopy;
  readonly headingLevel?: HeadingLevel | undefined;
}

function assertDistinct(copy: CountDenominatorsCopy): void {
  const measures = [copy.physicalRows, copy.billableSourceUnits, copy.outputRows];
  for (const field of ["label", "definition"] as const) {
    const values = measures.map((measure) => measure[field].trim());
    if (values.some((value) => value === "")) throw new RangeError(`every measure needs a ${field}`);
    if (new Set(values).size !== values.length) throw new RangeError(`the three measures must have different ${field}s`);
  }
}

export function CountDenominators({ physicalRows, billableSourceUnits, outputFiles, copy, headingLevel = 3 }: CountDenominatorsProps): ReactElement {
  assertDistinct(copy);
  countToBigInt(physicalRows, "physical rows");
  countToBigInt(billableSourceUnits, "billable source units");
  const ids = new Set<string>();
  for (const file of outputFiles) {
    if (ids.has(file.id)) throw new RangeError(`output file listed twice: ${file.id}`);
    ids.add(file.id);
    countToBigInt(file.rows, `output rows of ${file.id}`);
  }
  const headingId = useId();
  return (
    <section className={CLASS.countPanel} aria-labelledby={headingId}>
      <Heading level={headingLevel} id={headingId}>
        {copy.heading}
      </Heading>
      <dl className={CLASS.measures}>
        <div className={CLASS.measure}>
          <dt>{copy.physicalRows.label}</dt>
          <dd className={CLASS.measureValue}>
            <Count value={physicalRows} />
          </dd>
          <dd className={CLASS.measureDefinition}>{copy.physicalRows.definition}</dd>
        </div>
        <div className={CLASS.measure}>
          <dt>{copy.billableSourceUnits.label}</dt>
          <dd className={CLASS.measureValue}>
            <Count value={billableSourceUnits} />
          </dd>
          <dd className={CLASS.measureDefinition}>{copy.billableSourceUnits.definition}</dd>
        </div>
        <div className={CLASS.measure}>
          <dt>{copy.outputRows.label}</dt>
          <dd className={CLASS.measureValue}>
            {outputFiles.length === 0 ? (
              copy.outputRows.empty
            ) : (
              <ul className={CLASS.outputFiles}>
                {outputFiles.map((file) => (
                  <li key={file.id}>
                    <SafeText value={file.name} copy={copy.safeText} maxChars={null} /> <Count value={file.rows} />
                  </li>
                ))}
              </ul>
            )}
          </dd>
          <dd className={CLASS.measureDefinition}>{copy.outputRows.definition}</dd>
        </div>
      </dl>
    </section>
  );
}
